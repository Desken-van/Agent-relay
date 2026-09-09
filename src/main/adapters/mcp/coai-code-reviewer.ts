/** Typed Coai code-review adapter over the generic bounded MCP transport. */

import { z } from 'zod';
import { AgentRelayError } from '../../../shared/domain/errors';
import { providerCodeFindingSchema } from '../../../shared/domain/code-review';
import { containsSecretShape, redactAndTruncate } from '../../../shared/util/redact';
import {
  unsafeProviderIdentity,
  unsafeProviderLocatorId,
  unsafeProviderProse,
  type UnsafeProviderTextReason
} from '../../../shared/util/provider-text';
import type {
  CodeReviewerAvailability,
  ExternalCodeReviewer,
  ExternalCodeReviewRound,
  ExternalCodeReviewSubject,
  ExternalCodeRoundLocator,
  ExternalCodeRoundStatus,
  ExternalMcpCallResult,
  ExternalMcpClient,
  ExternalMcpServerConfig
} from '../../ports';
import {
  COAI_ADDRESSABLE_PROFILE,
  COAI_ADDRESSABLE_TOOLS,
  COAI_PROVIDER_ID,
  isAuditedProfile
} from './coai-profiles';
import { McpToolProfileMismatchError } from './stdio-mcp-client';

/** How much of a provider's prose may reach a stored reason. */
const REASON_LIMIT = 2_000;

/**
 * One component of a locator: opaque to this build, and therefore shaped.
 *
 * Length alone is not a contract. These strings are stored on the durable round
 * and shown wherever its provider identity is, so a server that answered a
 * reservation with an escape sequence, a path or a token in its own session id
 * had it persisted verbatim. The allow-list is stricter than the old bound in
 * every direction, so nothing is weakened: it also enforces 1..128 characters.
 *
 * Refused at the SCHEMA, so a bad component fails the whole payload closed
 * rather than being caught later by whoever happened to look. Nothing is
 * normalised: a locator edited on the way in no longer names the round the
 * provider created.
 */
const opaqueLocatorId = z.string().refine((value) => unsafeProviderLocatorId(value) === null, {
  message: 'is not a plain opaque identifier this build is willing to store'
});

const locatorSchema = z
  .object({
    providerId: opaqueLocatorId,
    sessionId: opaqueLocatorId,
    roundId: opaqueLocatorId
  })
  .strict();

/**
 * What `reserve_round` returns.
 *
 * Strict: an unrecognised field is a contract this build has not read, and the
 * whole point of a pinned profile is that such a server is refused rather than
 * partially understood.
 */
const reservationSchema = z
  .object({
    locator: locatorSchema,
    attestation: z
      .object({
        repoIdentity: z.string().max(4_096),
        baseRef: z.string().max(512),
        baseSha: z.string().max(128),
        headSha: z.string().max(128),
        treeSha: z.string().max(128),
        subjectHash: z.string().max(128)
      })
      .strict(),
    state: z.string().min(1).max(64),
    alreadyReserved: z.boolean(),
    instruction: z.string().max(20_000)
  })
  .strict();

const verdictSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.toLowerCase() : value),
  z.enum(['proceed', 'revise', 'continue_anyway', 'good_enough', 'call_human', 'escalated'])
);

/**
 * What a completed round says, from `run_round` or read back by `round_status`.
 *
 * `reviewedSubjectSha256` is REQUIRED here and never defaulted. A reviewer that
 * cannot say which snapshot it read has produced a verdict about unnamed code,
 * and the service refuses such an answer — so accepting a missing field with a
 * null would move that refusal from this schema into a silent success.
 */
const completedRoundSchema = z
  .object({
    locator: locatorSchema,
    reviewedSubjectSha256: z.string().min(1).max(128),
    verdict: verdictSchema,
    gatingCount: z.number().int().nonnegative().max(100_000),
    threshold: z.number().int().nonnegative().max(100_000),
    reviewers: z.string().min(1).max(2_000),
    findings: z.array(providerCodeFindingSchema).max(512),
    instruction: z.string().max(20_000),
    // Provider-reported usage. Absent is UNKNOWN, never zero: a round whose cost
    // nobody reported must not be recorded as one that cost nothing.
    tokensIn: z.number().int().nonnegative().nullable().optional(),
    tokensOut: z.number().int().nonnegative().nullable().optional()
  })
  .strict();

/**
 * What `round_status` returns for one locator: a discriminated union on
 * `state`, not one object with an optional `review`.
 *
 * The difference is a safety property rather than a tidiness one. With the
 * optional field, `{ state: 'not_started', review: { …a completed round… } }`
 * parsed happily and the `not_started` branch never looked at `review` — so a
 * payload that contradicts itself produced the ONE answer that licenses a
 * re-dispatch, and a provider could be asked to run a round it had already
 * completed.
 *
 * Only `completed` may carry a review. Every other state is a strict object
 * WITHOUT the key, so a review arriving beside `not_started`, `running`,
 * `failed` or `unknown` is an unrecognised field: the parse fails, and a parse
 * failure is answered with `unknown`. Contradiction is ambiguity, and ambiguity
 * is never positive evidence that nothing ran.
 *
 * The union also makes the original mistake unspellable — outside the
 * `completed` branch there is no `review` left to forget to check.
 */
const roundStatusSchema = z.discriminatedUnion('state', [
  z
    .object({
      locator: locatorSchema,
      state: z.literal('completed'),
      instruction: z.string().max(20_000),
      // Optional even here: a server may call a round completed and produce no
      // result for it. That is its own ambiguity, and it is answered with
      // `unknown` rather than a parse error, because the state itself is
      // coherent — the server is simply unable to say what it found.
      review: completedRoundSchema.optional()
    })
    .strict(),
  z
    .object({
      locator: locatorSchema,
      state: z.enum(['not_started', 'running', 'failed', 'unknown']),
      instruction: z.string().max(20_000)
    })
    .strict()
]);

/**
 * The Coai code-review adapter, bound to one audited server configuration.
 *
 * Every call goes through the same bounded transport the plan gate uses: one
 * short-lived process, no shell, a fixed argv from trusted settings, and a tool
 * list that must match the configured profile exactly.
 */
export class CoaiCodeReviewer implements ExternalCodeReviewer {
  constructor(
    private readonly client: ExternalMcpClient,
    private readonly config: ExternalMcpServerConfig
  ) {
    if (!isAuditedProfile(config.allowedTools, COAI_ADDRESSABLE_PROFILE)) {
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        'The Coai code reviewer requires its exact audited ten-tool profile.',
        {
          remediation:
            'Code review needs reserve_round, run_round and round_status alongside the seven plan tools.'
        }
      );
    }
  }

  /**
   * False, and it stays false until a separate attestation exists.
   *
   * `run_round` reviews a commit in a worktree the provider pins to a SHA, so
   * uncommitted and untracked work is invisible to it. Declaring the capability
   * honestly is what turns that into a refusal instead of a confident verdict
   * about different code — the service will not dispatch a dirty subject here.
   * Reviewing a dirty tree needs a provider that can snapshot it AND prove the
   * snapshot is the caller's own; that contract does not exist yet.
   */
  readonly readsUncommittedWorktreeState = false;

  readonly providerId = COAI_PROVIDER_ID;

  /**
   * Can a round run right now? Read-only, and never a consuming call.
   *
   * Discovery alone answers it: the transport refuses a server whose tool list
   * is not exactly this profile, so a legacy seven-tool server fails here —
   * before `CodeReviewService` writes any durable intent — and the reason names
   * what is missing rather than saying the call failed.
   */
  async availability(signal?: AbortSignal): Promise<CodeReviewerAvailability> {
    try {
      const discovery = await this.client.discover(this.config, signal);
      const names = discovery.tools.map((tool) => tool.name);
      if (!isAuditedProfile(names, COAI_ADDRESSABLE_PROFILE)) {
        // Unreachable through the transport, which enforces the same thing —
        // and checked anyway, because this class must not depend on another
        // layer's guard to keep its own promise.
        return this.unavailable(this.missingSentence(names));
      }

      return { available: true, reason: null };
    } catch (error) {
      return this.unavailable(this.describe(error));
    }
  }

  /**
   * Why discovery failed, said without repeating anything the server sent.
   *
   * `availability.reason` is stored and shown, and its contract is that it
   * carries no path, no argv and no secret. An earlier version of this method
   * appended `AgentRelayError.details` for ANY discovery failure, and that broke
   * the contract: the transport uses the same field for a failed spawn's raw
   * STDERR, which can hold an absolute path, the argv it was launched with, or
   * whatever prose the server chose to print. Redaction hides credential shapes;
   * it does not hide a path, and it was never meant to.
   *
   * So nothing here reads `details`, and nothing reads a server-supplied string.
   * A tool-profile mismatch is recognised by its TYPE and answered with names
   * from this build's own {@link COAI_ADDRESSABLE_TOOLS}; every other failure
   * gets a fixed sentence plus its error CODE, which comes from a closed set
   * this application defines.
   */
  private describe(error: unknown): string {
    if (error instanceof McpToolProfileMismatchError) {
      return `It does not advertise the audited profile. Code review needs ${this.namesFor(error)}.`;
    }

    // Everything else: a spawn failure, a timeout, a cancellation, a protocol
    // violation. The code is a closed enum this application owns; the message
    // is not, so it is not repeated.
    const code = error instanceof AgentRelayError ? error.code : 'UNKNOWN';

    return `The server could not be discovered (${code}). See the application log for the detail, which is not repeated here because it can carry a path or a command line.`;
  }

  /**
   * The addressable tools to name, sourced only from this build's constant.
   *
   * Filtered by what the transport reported missing — itself taken from the
   * allowlist this application supplied, so still local — and falling back to
   * all three when the mismatch was an extra or duplicated tool rather than an
   * absent one. Either way the strings emitted are this build's own.
   */
  private namesFor(error: McpToolProfileMismatchError): string {
    const absent = COAI_ADDRESSABLE_TOOLS.filter((tool) => error.missing.includes(tool));

    return (absent.length > 0 ? absent : COAI_ADDRESSABLE_TOOLS).join(', ');
  }

  /**
   * Reserve the round, and nothing else.
   *
   * `reserve_round` is the only tool called: it writes the provider's own record
   * of a round that has not run and returns its locator. No reviewer starts and
   * no round budget moves, which is what makes it safe to call before the
   * durable dispatch — and what makes a crash straight afterwards cost nothing.
   *
   * @param clientToken
   * The local round's own durable id. It is the provider's idempotency key, so
   * the same local round always reserves the same provider round: a retry after
   * a lost answer resumes rather than reserving a second. It is deliberately NOT
   * the subject hash — several legitimate rounds review one subject — and not a
   * timestamp or anything this adapter invents, because neither survives the
   * restart the token exists for.
   */
  async beginRound(
    subject: ExternalCodeReviewSubject,
    clientToken: string,
    signal?: AbortSignal
  ): Promise<ExternalCodeRoundLocator> {
    const value = this.parse(
      await this.client.call(
        this.config,
        'reserve_round',
        {
          repoPath: subject.worktreePath,
          branch: subject.branch,
          baseRef: subject.baseRef,
          // Sent so the reservation can be checked against it below. On a fresh
          // reservation echoing it back proves little; on a RESUMED one — the
          // same token after a lost answer — the stored attestation comes from
          // the original reservation, so an echo that differs is a reservation
          // for other code being handed back under this token.
          subjectSha256: subject.subjectSha256,
          clientToken
        },
        signal
      ),
      reservationSchema
    );
    this.assertOurProvider(value.locator);
    this.assertReservationMatches(value, subject);

    return value.locator;
  }

  /**
   * The reservation must describe the round we asked for, before anything runs.
   *
   * This is the last moment at which a disagreement costs nothing. `run_round`
   * is the non-idempotent call, and the answer it returns is checked against
   * the subject — but by then the round is spent, and a mismatch discovered
   * there is a wasted review rather than a refusal. Checking the reservation
   * turns the same disagreement into a refusal with no external cost.
   *
   * Three fields are compared, and only three: the ones the port holds a
   * trustworthy local value for. `repoIdentity`, `baseSha` and `treeSha` are
   * the provider's own resolutions and Agent Relay has nothing of its own to
   * compare them against here — inventing a comparison would be checking a
   * value against itself and calling it evidence.
   *
   * `state` must be exactly `not_started`. A reservation reported as running,
   * completed or unknown is not a round this call may go on to dispatch, and it
   * is emphatically not evidence that nothing ran — that reading belongs to the
   * read-back path, against a locator that is already stored.
   */
  private assertReservationMatches(
    value: z.infer<typeof reservationSchema>,
    subject: ExternalCodeReviewSubject
  ): void {
    if (value.state !== 'not_started') {
      // Fixed wording, and deliberately NOT `value.state`. That field is the
      // provider's own string, this error reaches a durable column through the
      // service's reservation path, and a state nobody constrained could carry
      // an absolute path, an argv or a control character just as easily as a
      // word. Which state it was is not worth storing at that price.
      throw new AgentRelayError(
        'PARSE_FAILED',
        'The reservation is not a round that has yet to run, so nothing was dispatched.'
      );
    }

    // What each comparison is actually worth, because they are not alike.
    // `headSha` is the strongest: the provider resolved the branch itself, and
    // this build resolved it independently when it captured the subject, so a
    // difference means the branch moved between the two. `baseRef` confirms the
    // provider pinned the base this dispatch named. `subjectHash` is echoed
    // from the request, which proves nothing on a first reservation and
    // everything on a resumed one — see the argument note above.
    const disagreements: string[] = [];
    if (value.attestation.baseRef !== subject.baseRef) disagreements.push('baseRef');
    if (value.attestation.headSha !== subject.headCommit) disagreements.push('headSha');
    if (value.attestation.subjectHash !== subject.subjectSha256) disagreements.push('subjectHash');
    if (disagreements.length > 0) {
      // Named fields only: the values are a provider's resolution of the
      // caller's own repository, and repeating them here would put a checkout's
      // shape into a stored error for no gain.
      throw new AgentRelayError(
        'PARSE_FAILED',
        `The reservation attests a different subject than the one asked for (${disagreements.join(', ')}), so nothing was dispatched.`
      );
    }
  }

  /**
   * Run exactly the reserved round.
   *
   * `run_round` and nothing else — never `review_code`, even as a fallback. The
   * legacy tool creates its own round and names it only afterwards, so falling
   * back to it would spend a review nothing could ever read back, which is the
   * failure the locator exists to prevent.
   */
  async reviewCode(
    locator: ExternalCodeRoundLocator,
    _subject: ExternalCodeReviewSubject,
    scopeText: string,
    signal?: AbortSignal
  ): Promise<ExternalCodeReviewRound> {
    this.assertOurProvider(locator);
    const result = await this.client.call(
      this.config,
      'run_round',
      {
        providerId: locator.providerId,
        sessionId: locator.sessionId,
        roundId: locator.roundId,
        planText: scopeText
      },
      signal
    );
    const value = this.parse(result, completedRoundSchema);

    return this.round(value, locator, result);
  }

  /**
   * Read one locator back. Read-only by contract: it starts and spends nothing.
   *
   * Every failure is `unknown` with a bounded reason, and that is the whole
   * discipline of this method. A timeout, a refusal, a transport error and a
   * server that has never heard of the locator look identical from here, and
   * only one of them would be safe to read as "nothing ran" — so none of them is
   * read that way. `not_started` is returned only when the provider says it, and
   * the provider says it only about a round it reserved and did not dispatch.
   */
  async roundStatus(
    locator: ExternalCodeRoundLocator,
    // Unused on purpose: the round is addressed by its LOCATOR, never described
    // by its subject. Describing it would be the guess this whole contract
    // exists to remove.
    _subject: ExternalCodeReviewSubject,
    signal?: AbortSignal
  ): Promise<ExternalCodeRoundStatus> {
    if (locator.providerId !== this.providerId) {
      return {
        kind: 'unknown',
        reason: 'That round was dispatched to a different provider than this one.'
      };
    }

    let result: ExternalMcpCallResult;
    let value: z.infer<typeof roundStatusSchema>;
    try {
      result = await this.client.call(
        this.config,
        'round_status',
        {
          providerId: locator.providerId,
          sessionId: locator.sessionId,
          roundId: locator.roundId
        },
        signal
      );
      value = this.parse(result, roundStatusSchema);
    } catch (error) {
      return { kind: 'unknown', reason: this.unreadable(error) };
    }

    if (!sameLocator(value.locator, locator)) {
      return {
        kind: 'unknown',
        reason: 'The provider answered about a different round than the one asked about.'
      };
    }

    switch (value.state) {
      case 'running':
        return { kind: 'running' };

      case 'not_started':
        // Positive evidence: the provider holds this reservation and has not
        // dispatched it. Nothing else in this method can produce this answer.
        return { kind: 'not_started' };

      case 'completed': {
        if (value.review === undefined) {
          return {
            kind: 'unknown',
            reason: 'The provider called the round completed and returned no result for it.'
          };
        }
        if (!sameLocator(value.review.locator, locator)) {
          return {
            kind: 'unknown',
            reason: 'The completed result carried a different locator than the round asked about.'
          };
        }

        // `round` refuses a server identity that cannot be stored, and it
        // refuses by throwing. That must not escape a read-back: this method's
        // whole contract is that it always answers, and an answer that cannot
        // be stored is exactly the ambiguity `unknown` exists to express.
        try {
          return { kind: 'completed', round: this.round(value.review, locator, result) };
        } catch (error) {
          return {
            kind: 'unknown',
            reason: redactAndTruncate(
              error instanceof Error ? error.message : String(error),
              REASON_LIMIT
            )
          };
        }
      }

      case 'failed':
        // Dispatched and ended without an answer. Whether a reviewer ran is not
        // knowable from here, so this is NOT `not_started`: the local round is
        // left unresolved rather than offered a free retry of a call that may
        // already have consumed a round.
        return {
          kind: 'unknown',
          // `instruction` is the provider's own prose and this reason is stored
          // by the service, so it is not repeated. Redaction hides credential
          // SHAPES; it hides neither an absolute path nor a control character,
          // and it was never meant to.
          reason:
            'The provider reports this round as failed. What it said about the failure is not repeated here, because a provider message can carry a path, a command line or a control character.'
        };

      default:
        return {
          kind: 'unknown',
          reason: 'The provider has no usable record of this round.'
        };
    }
  }

  /**
   * One provider answer, as the port's round.
   *
   * The attestation is carried through untouched. Checking it against the
   * dispatched subject is `CodeReviewService`'s job and is deliberately not
   * duplicated here: one place decides whether an answer may complete a round,
   * and an adapter that also judged it could disagree with that place.
   */
  private round(
    value: z.infer<typeof completedRoundSchema>,
    locator: ExternalCodeRoundLocator,
    result: ExternalMcpCallResult
  ): ExternalCodeReviewRound {
    if (!sameLocator(value.locator, locator)) {
      throw new AgentRelayError(
        'PARSE_FAILED',
        'The provider answered for a different round than the one dispatched.'
      );
    }

    // Checked HERE, before any of it becomes part of a stored round.
    const unstorable = this.unstorableRound(value, result);
    if (unstorable !== null) {
      throw new AgentRelayError('PARSE_FAILED', unstorable);
    }

    return {
      locator: value.locator,
      reviewedSubjectSha256: value.reviewedSubjectSha256,
      verdict: value.verdict,
      gatingCount: value.gatingCount,
      threshold: value.threshold,
      reviewers: value.reviewers,
      findings: value.findings,
      instruction: value.instruction,
      serverName: result.server.name,
      serverVersion: result.server.version,
      // Absent means the vendor reported nothing, and that is not zero.
      tokensIn: value.tokensIn ?? null,
      tokensOut: value.tokensOut ?? null
    };
  }

  /**
   * Why nothing about this round can be stored, or `null` when it all can.
   *
   * Every provider-controlled string the round would carry into storage, in one
   * place. `serverInfo.name` and `serverInfo.version` arrive in the MCP
   * INITIALIZE handshake rather than in a tool result, so the credential scan
   * {@link parse} runs over the payload never sees them at all; `reviewers` and
   * `instruction` are in the payload but are prose, which the scan checks for
   * credential shapes and not for anything else.
   *
   * Identity and prose are judged by different rules on purpose: a name or a
   * version has no business carrying any control character, while a reviewer's
   * instruction may legitimately wrap. The service applies the same four checks
   * again at its own boundary, because `ExternalCodeReviewer` is an interface
   * and the service is where an answer becomes durable.
   *
   * The answer names the FIELD and the problem and never the value: this
   * message is itself stored, so repeating the value would defeat the check
   * that produced it.
   */
  private unstorableRound(
    value: z.infer<typeof completedRoundSchema>,
    result: ExternalMcpCallResult
  ): string | null {
    const checks: readonly (readonly [string, UnsafeProviderTextReason | null])[] = [
      ['The MCP server name', unsafeProviderIdentity(result.server.name)],
      ['The MCP server version', unsafeProviderIdentity(result.server.version)],
      ['The reviewer summary', unsafeProviderProse(value.reviewers, 2_000)],
      ['The reviewer instruction', unsafeProviderProse(value.instruction, 20_000)]
    ];
    for (const [what, reason] of checks) {
      if (reason !== null) {
        return `${what} is ${reason}, so the round was not accepted.`;
      }
    }

    return null;
  }

  /**
   * Why a read-back could not be read, said without repeating anything foreign.
   *
   * The error can be the transport's, or {@link parse}'s report of a refusal the
   * server returned as data — and that one embeds the server's own sentence. The
   * code is a closed enum this application owns; the message is not, so only the
   * code is used.
   */
  private unreadable(error: unknown): string {
    const code = error instanceof AgentRelayError ? error.code : 'UNKNOWN';

    return `The round could not be read back (${code}). What the provider said is not repeated here, because it can carry a path, a command line or a credential.`;
  }

  private assertOurProvider(locator: ExternalCodeRoundLocator): void {
    if (locator.providerId !== this.providerId) {
      throw new AgentRelayError(
        'PARSE_FAILED',
        'The provider issued a locator under an identity this build does not file rounds under.'
      );
    }
  }

  private unavailable(detail: string): CodeReviewerAvailability {
    return {
      available: false,
      // Bounded and redacted: a refusal can carry an executable path, an argv or
      // a credential-shaped fragment out of a server this build does not own.
      reason: redactAndTruncate(
        `Addressable code review is not supported by the configured Coai server. ${detail}`,
        REASON_LIMIT
      )
    };
  }

  private missingSentence(names: readonly string[]): string {
    const missing = COAI_ADDRESSABLE_TOOLS.filter((tool) => !names.includes(tool));

    return missing.length > 0
      ? `It advertises ${names.length} tools and is missing ${missing.join(', ')}.`
      : `It advertises ${names.length} tools, which is not the audited profile.`;
  }

  /**
   * One MCP result, validated the way storage requires.
   *
   * The four outcomes a caller must be able to tell apart are kept apart: an MCP
   * transport error, the server's own refusal returned as data, output that will
   * not parse, and a real answer. Credential-shaped text is refused outright
   * rather than stored — reviewer prose is data from outside this application,
   * and a round whose text carries a key must not be persisted as complete.
   */
  private parse<T>(result: ExternalMcpCallResult, schema: z.ZodType<T>): T {
    if (result.isError) {
      throw new AgentRelayError(
        'TOOL_FAILED',
        `Coai reported an MCP tool error from ${result.tool.name}.`
      );
    }
    if (result.content.length !== 1) {
      throw new AgentRelayError('PARSE_FAILED', 'Coai must return exactly one JSON text block.');
    }

    let value: unknown;
    try {
      value = JSON.parse(result.content[0]!);
    } catch (error) {
      throw new AgentRelayError('PARSE_FAILED', 'Coai returned malformed JSON inside its MCP result.', {
        cause: error
      });
    }

    // A refusal the server returns as DATA rather than as a protocol error. It
    // is not a parse failure and not a transport failure, and calling it either
    // would lose the sentence a person needs.
    if (typeof value === 'object' && value !== null && 'error' in value) {
      const message = (value as { error?: unknown }).error;
      throw new AgentRelayError(
        'TOOL_FAILED',
        typeof message === 'string' && message.length > 0
          ? `Coai refused the request: ${redactAndTruncate(message, REASON_LIMIT)}`
          : 'Coai refused the request.'
      );
    }

    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new AgentRelayError('PARSE_FAILED', `Coai returned an invalid ${result.tool.name} result.`, {
        details: parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')
      });
    }
    if (containsSecretShape(JSON.stringify(parsed.data))) {
      throw new AgentRelayError(
        'PARSE_FAILED',
        'The reviewer returned credential-shaped text; the round was not accepted.'
      );
    }

    return parsed.data;
  }
}

function sameLocator(a: ExternalCodeRoundLocator, b: ExternalCodeRoundLocator): boolean {
  return a.providerId === b.providerId && a.sessionId === b.sessionId && a.roundId === b.roundId;
}
