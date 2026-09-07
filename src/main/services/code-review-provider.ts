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
  ExternalCodeReviewer,
  ExternalCodeReviewRound,
  ExternalCodeReviewSubject
} from '../ports';

export class UnconfiguredCodeReviewer implements ExternalCodeReviewer {
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

  async reviewCode(
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
