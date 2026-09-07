/**
 * The external code reviewer that INT-D-A does not have yet.
 *
 * INT-D-A delivers the evidence layer: an immutable subject, durable rounds,
 * findings with stable identity and decisions with an audit trail. What it does
 * NOT deliver is the adapter that calls a real provider's `review_code` — that
 * is INT-D-B, together with its allowlist, budget and live acceptance.
 *
 * This class exists so the object graph is complete and honest rather than
 * half-wired. It refuses loudly and specifically. The alternative — leaving the
 * dependency optional, or returning an empty round — would let a caller mistake
 * "no provider is configured" for "the review found nothing", which is the one
 * confusion a review gate must never allow.
 */

import { AgentRelayError } from '../../shared/domain/errors';
import type {
  CodeReviewerAvailability,
  ExternalCodeRoundLocator,
  ExternalCodeRoundStatus,
  ExternalCodeReviewer,
  ExternalCodeReviewRound,
  ExternalCodeReviewSubject
} from '../ports';

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
    _locator: ExternalCodeRoundLocator,
    _subject: ExternalCodeReviewSubject,
    _signal?: AbortSignal
  ): Promise<ExternalCodeRoundStatus> {
    return {
      kind: 'unknown',
      reason: 'No external code reviewer is configured in this build.'
    };
  }

  async reviewCode(
    _locator: ExternalCodeRoundLocator,
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
