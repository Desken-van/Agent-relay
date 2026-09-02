/**
 * The decision table for a task waiting to publish.
 *
 * One list, read by two suites: the unit tests for `correctionAction` and the
 * orchestrator's integration tests for `sendCorrections`. That sharing is the
 * point — the defect those tests exist to prevent was the renderer and the main
 * process disagreeing about when another Claude round may start, and two
 * hand-copied tables would eventually reproduce it.
 *
 * It lives in `helpers` rather than inside either suite because a `*.test.ts`
 * file imported by another one has its `describe`/`it` blocks registered twice,
 * which quietly inflates the reported test count. Nothing here registers a test:
 * no `describe`, no `it`, no hooks — only data.
 *
 * Test-only, and deliberately not in production code: nothing at runtime needs
 * a list of hypothetical assessments.
 */

import {
  CLAUDE_ASSESSMENT_VERSION,
  type ClaudePublishBlock,
  type CorrectionActionKind
} from '../../src/shared/domain/claude-assessment';

/** A `structured_result` holding a version-1 assessment with the given block. */
export function storedAssessment(publishBlock: ClaudePublishBlock): string {
  return JSON.stringify({
    assessment: {
      version: CLAUDE_ASSESSMENT_VERSION,
      disposition: publishBlock === 'none' ? 'pass' : 'warn',
      verificationStatus: publishBlock === 'verification' ? 'failed' : 'passed',
      publishBlock,
      reasonCodes: [],
      verification: null,
      denials: []
    }
  });
}

export interface ReadyToPublishCase {
  readonly name: string;
  /** What the latest Claude round recorded about itself, if anything. */
  readonly structuredResult: string | null;
  /** What both the button and the API must decide for this record. */
  readonly kind: CorrectionActionKind;
}

/**
 * Every case where a task in `READY_TO_PUBLISH` may or may not start another
 * round.
 *
 * Anything that stops the round being published — a block, or a record nobody
 * can read — leaves the user needing a fresh round. A record that is readable
 * and clear to publish does not: the work is finished, and offering another
 * round would be busywork on code that is already done.
 */
export const READY_TO_PUBLISH_CASES: readonly ReadyToPublishCase[] = [
  {
    name: 'verification block',
    structuredResult: storedAssessment('verification'),
    kind: 'retry_verification'
  },
  {
    name: 'security block',
    structuredResult: storedAssessment('security'),
    kind: 'retry_verification'
  },
  {
    name: 'telemetry block',
    structuredResult: storedAssessment('telemetry'),
    kind: 'retry_verification'
  },
  {
    name: 'configuration block',
    structuredResult: storedAssessment('configuration'),
    kind: 'retry_verification'
  },
  { name: 'assessment absent', structuredResult: null, kind: 'retry_verification' },
  {
    name: 'assessment from an older build',
    structuredResult: JSON.stringify({ numTurns: 3, sessionId: 's-1' }),
    kind: 'retry_verification'
  },
  { name: 'assessment malformed', structuredResult: '{ not json', kind: 'retry_verification' },
  {
    name: 'assessment from a newer version',
    structuredResult: JSON.stringify({ assessment: { version: 2, publishBlock: 'none' } }),
    kind: 'retry_verification'
  },
  { name: 'nothing blocking', structuredResult: storedAssessment('none'), kind: 'unavailable' }
];
