/**
 * The two reviewers the object graph can be built with, and neither pretends.
 *
 * {@link UnconfiguredCodeReviewer} is the honest empty slot: it refuses loudly
 * and specifically, because leaving the dependency optional or returning an
 * empty round would let a caller mistake "no provider is configured" for "the
 * review found nothing" — the one confusion a review gate must never allow.
 *
 * {@link SettingsBoundCodeReviewer} is what the running app uses. It resolves
 * persisted settings per call and refuses exactly as the empty slot does when
 * the integration is off, its executable is unset, or the configured server
 * does not advertise the audited addressable profile.
 */

import { AgentRelayError } from '../../shared/domain/errors';
import type { Settings } from '../../shared/domain/models';
import { CoaiCodeReviewer } from '../adapters/mcp/coai-code-reviewer';
import { COAI_PROVIDER_ID } from '../adapters/mcp/coai-profiles';
import { externalCodeReviewConfig } from './code-review-configuration';
import type {
  ExternalMcpClient,
  CodeReviewerAvailability,
  ExternalCodeRoundIdentity,
  ExternalCodeRoundLocator,
  ExternalCodeRoundStatus,
  ExternalCodeReviewer,
  ExternalCodeReviewRound,
  ExternalCodeReviewSubject
} from '../ports';

/**
 * Typed proof that no external call was attempted.
 *
 * The service has to tell two failures apart that look identical from a catch
 * block: a request that left this process and lost its answer, and a request
 * that was never made at all. The first must leave the round unresolved,
 * because a reviewer may well have run; the second may close it, because
 * nothing did.
 *
 * A TYPE rather than a code, because `TOOL_MISSING` is not proof of anything on
 * its own — a real adapter can raise it from inside an external call, once the
 * request has already gone out. Only the throw site knows whether anything was
 * attempted, so only the throw site can say so, and it says so by choosing this
 * class.
 *
 * The code and message are an ordinary `TOOL_MISSING` for the caller, which is
 * entitled to exactly what it was entitled to before.
 */
export class CodeReviewNotDispatchedError extends AgentRelayError {
  constructor(message: string, options?: { remediation?: string }) {
    super('TOOL_MISSING', message, options);
    this.name = 'CodeReviewNotDispatchedError';
  }
}

export class UnconfiguredCodeReviewer implements ExternalCodeReviewer {
  /**
   * A real name, not an empty string, so a round could never be filed under it
   * by accident and later matched by whatever provider arrives next. Nothing
   * can reach dispatch through this class anyway; the value exists so the
   * identity check has something honest to compare against.
   */
  readonly providerId = 'unconfigured';

  /**
   * False, and not because this reviewer is limited — because it does not
   * exist. The default for anything that has not proved it reads the worktree
   * is that it does not, so a subject with uncommitted work is refused rather
   * than sent somewhere that would answer about different code.
   */
  readonly readsUncommittedWorktreeState = false;

  /**
   * Answers before anything is written, so the refusal costs nothing.
   *
   * The whole point of a separate preflight: this build provably cannot make an
   * external call, so a round row saying one was dispatched would be a lie that
   * something later has to reconcile.
   */
  async availability(): Promise<CodeReviewerAvailability> {
    return {
      available: false,
      reason: 'No external code reviewer is configured in this build.'
    };
  }

  /**
   * Refuses where a real adapter would open a session and reserve a round.
   *
   * Deliberately the same refusal as `reviewCode`: with no provider there is no
   * identity to hand out, and returning an invented locator would let a round be
   * written down as dispatchable when nothing can ever be asked about it.
   */
  async beginRound(
    _subject: ExternalCodeReviewSubject,
    _clientToken: string,
    _signal?: AbortSignal
  ): Promise<ExternalCodeRoundLocator> {
    throw new AgentRelayError(
      'TOOL_MISSING',
      'No external code reviewer is configured in this build, so no review round can be opened.',
      {
        remediation:
          'Capturing the review subject and reading recorded findings work without a provider. Running a round needs the provider adapter, which is not part of this phase.'
      }
    );
  }

  /**
   * Read-only, and equally unable to answer.
   *
   * `unknown` rather than `running` or a fabricated result: with no provider
   * there is nothing to ask, and a recovery that invented an answer would be
   * worse than one that admits it learned nothing.
   */
  async roundStatus(
    _locator: ExternalCodeRoundIdentity,
    _subject: ExternalCodeReviewSubject,
    _signal?: AbortSignal
  ): Promise<ExternalCodeRoundStatus> {
    return {
      kind: 'unknown',
      reason: 'No external code reviewer is configured in this build.',
      contractFingerprint: null
    };
  }

  async reviewCode(
    _locator: ExternalCodeRoundIdentity,
    _subject: ExternalCodeReviewSubject,
    _scopeText: string,
    _signal?: AbortSignal
  ): Promise<ExternalCodeReviewRound> {
    throw new AgentRelayError(
      'TOOL_MISSING',
      'No external code reviewer is configured in this build, so no code-review round can run.',
      {
        remediation:
          'Capturing the review subject and reading recorded findings work without a provider. Running a round needs the provider adapter, which is not part of this phase.'
      }
    );
  }
}

/**
 * The code reviewer the running app uses: settings-bound, and refusing by default.
 *
 * The service is built once at startup while settings change while it runs, so
 * the reviewer is resolved per CALL rather than captured. A configuration that
 * was switched off, or an executable that was cleared, therefore takes effect on
 * the next call instead of at the next restart — and a build with nothing
 * configured refuses exactly as {@link UnconfiguredCodeReviewer} does.
 */
export class SettingsBoundCodeReviewer implements ExternalCodeReviewer {
  constructor(
    private readonly deps: {
      readonly settings: () => Settings;
      readonly client: ExternalMcpClient;
    }
  ) {}

  /**
   * False, whatever is configured.
   *
   * Not delegated: the answer must not depend on whether a provider happens to
   * be reachable this second, because the service asks it to decide whether a
   * dirty subject may be dispatched at all. Until an immutable-snapshot
   * attestation exists, no configuration makes this true.
   */
  readonly readsUncommittedWorktreeState = false;

  /**
   * Constant, and deliberately not read from configuration.
   *
   * A round dispatched while the integration was enabled must still be
   * recognisable after somebody disables it — recovery compares this against the
   * identity stored on the durable round, and an identity that disappeared with
   * the configuration would strand every outstanding round.
   */
  readonly providerId = COAI_PROVIDER_ID;

  async availability(signal?: AbortSignal): Promise<CodeReviewerAvailability> {
    const reviewer = this.reviewer();

    return reviewer === null
      ? {
          available: false,
          reason:
            'External code review is not enabled in this build\u2019s settings, or its MCP server is not configured.'
        }
      : reviewer.availability(signal);
  }

  async beginRound(
    subject: ExternalCodeReviewSubject,
    clientToken: string,
    signal?: AbortSignal
  ): Promise<ExternalCodeRoundLocator> {
    return this.required().beginRound(subject, clientToken, signal);
  }

  async reviewCode(
    locator: ExternalCodeRoundIdentity,
    subject: ExternalCodeReviewSubject,
    scopeText: string,
    signal?: AbortSignal
  ): Promise<ExternalCodeReviewRound> {
    return this.required().reviewCode(locator, subject, scopeText, signal);
  }

  /**
   * Read-only, and it answers rather than throwing.
   *
   * Recovery runs against a round dispatched by a build that may since have been
   * reconfigured. `unknown` is the honest answer there: this server cannot say
   * what became of that round, which is not the same as saying nothing ran.
   */
  async roundStatus(
    locator: ExternalCodeRoundIdentity,
    subject: ExternalCodeReviewSubject,
    signal?: AbortSignal
  ): Promise<ExternalCodeRoundStatus> {
    const reviewer = this.reviewer();

    return reviewer === null
      ? {
          kind: 'unknown',
          reason:
            'External code review is not configured now, so this build cannot ask what became of that round.',
          contractFingerprint: null
        }
      : reviewer.roundStatus(locator, subject, signal);
  }

  /**
   * The configured reviewer, or typed proof that nothing was attempted.
   *
   * Reached BEFORE any MCP call, always: this resolves configuration and either
   * hands back a reviewer or throws. So a throw from here is positive evidence
   * that no request left the process, and {@link CodeReviewNotDispatchedError}
   * is how that evidence crosses the boundary to the service.
   */
  private required(): ExternalCodeReviewer {
    const reviewer = this.reviewer();
    if (reviewer === null) {
      throw new CodeReviewNotDispatchedError(
        'External code review is not enabled, so no round can be reserved or run.',
        {
          remediation:
            'Enable external code review in Settings and point it at an MCP server that advertises the addressable twelve-tool profile.'
        }
      );
    }

    return reviewer;
  }

  /**
   * The configured reviewer, or null when there is none.
   *
   * A configuration that will not validate is the same as none: refusing is
   * correct either way, and the settings screen is where the reason belongs.
   */
  private reviewer(): ExternalCodeReviewer | null {
    let config;
    try {
      config = externalCodeReviewConfig(this.deps.settings());
    } catch {
      return null;
    }

    try {
      return new CoaiCodeReviewer(this.deps.client, config);
    } catch {
      return null;
    }
  }
}
