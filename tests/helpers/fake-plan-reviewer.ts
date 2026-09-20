/**
 * Fixtures for external plan-review tests: a fake Coai plan reviewer that a test
 * drives by hand, a valid rule-evidence snapshot, and finding factories.
 *
 * Shared by the gate tests and the correction-loop tests so both are written
 * against one implementation of the provider rather than two that drift.
 */

import { createHash } from 'node:crypto';
import type {
  ExternalPlanReviewer,
  ExternalPlanReviewResolution,
  ExternalPlanReviewRound,
  ExternalPlanReviewSession,
  ExternalPlanReviewStatus,
  ExternalPlanReviewSubject
} from '../../src/main/ports';
import type { PlanReviewDecision, PlanReviewFinding } from '../../src/shared/domain/plan-review';
import type { RuleEvidenceSnapshot } from '../../src/shared/domain/rule-evidence';

export interface Deferred {
  readonly promise: Promise<unknown>;
  resolve(value: unknown): void;
}

/** A promise a test resolves by hand, so it decides when an answer arrives. */
export function deferred(): Deferred {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** The provider's PlanReview round tally, defaulting to "nothing has run". */
export function planRounds(
  counts: Partial<ExternalPlanReviewStatus['planRounds']> = {}
): ExternalPlanReviewStatus['planRounds'] {
  return { total: 0, running: 0, done: 0, interrupted: 0, ...counts };
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** A fixed, valid-shaped contract fingerprint — its value is asserted on only where a test names it. */
export const FINGERPRINT = 'f'.repeat(64);

export function snapshot(content = 'Run the repository verification command.\n'): RuleEvidenceSnapshot {
  const contentBytes = Buffer.byteLength(content);
  const sources = [{ id: 'project', kind: 'project' as const, revision: 'a'.repeat(40), clean: true }];
  const files = [{
    sourceId: 'project',
    path: 'AGENTS.md',
    bytes: contentBytes,
    sha256: sha256(content),
    content
  }];
  const omitted: RuleEvidenceSnapshot['omitted'] = [];
  return {
    version: 1,
    sources,
    files,
    omitted,
    totalBytes: contentBytes,
    sha256: sha256(JSON.stringify({
      version: 1,
      sources,
      files: files.map(({ sourceId, path, bytes, sha256: fileHash }) => ({
        sourceId, path, bytes, sha256: fileHash
      })),
      omitted
    })),
    capturedAt: '2026-09-06T00:00:00.000Z'
  };
}

export class FakePlanReviewer implements ExternalPlanReviewer {
  readonly openCalls: ExternalPlanReviewSubject[] = [];
  readonly reviewCalls: { subject: ExternalPlanReviewSubject; planText: string }[] = [];
  readonly resolveCalls: { subject: ExternalPlanReviewSubject; decisions: readonly PlanReviewDecision[] }[] = [];
  readonly statusCalls: ExternalPlanReviewSubject[] = [];
  /** The signal each provider call was given, by call kind, so a test can see what reached the provider. */
  readonly signals: Record<'open' | 'review' | 'resolve' | 'status', (AbortSignal | undefined)[]> = {
    open: [],
    review: [],
    resolve: [],
    status: []
  };
  statusError: Error | null = null;
  onReview: (() => void) | null = null;
  onResolve: (() => void) | null = null;
  openError: Error | null = null;
  reviewError: Error | null = null;
  resolveError: Error | null = null;
  session: ExternalPlanReviewSession = {
    sessionId: 'session-1',
    stage: 'PlanReview',
    awaitingResolve: false,
    planProceeded: false,
    serverName: 'coai-mcp',
    serverVersion: '1.2.3',
    contractFingerprint: FINGERPRINT
  };
  round: ExternalPlanReviewRound = {
    verdict: 'proceed',
    gatingCount: 0,
    threshold: 2,
    reviewers: 'all 2 reviewers answered',
    findings: [],
    instruction: 'resolve every finding',
    serverName: 'coai-mcp',
    serverVersion: '1.2.3',
    contractFingerprint: FINGERPRINT
  };
  resolution: ExternalPlanReviewResolution = {
    stage: 'CodeReview',
    awaitingResolve: false,
    recordedDecisions: 0,
    instruction: 'continue',
    serverName: 'coai-mcp',
    serverVersion: '1.2.3',
    contractFingerprint: FINGERPRINT
  };

  state: ExternalPlanReviewStatus = {
    sessionId: 'session-1',
    stage: 'PlanReview',
    awaitingResolve: false,
    planProceeded: false,
    planRounds: planRounds(),
    serverName: 'coai-mcp',
    serverVersion: '1.2.3',
    contractFingerprint: FINGERPRINT
  };

  /**
   * Successive rounds `reviewPlan` returns, one per call, once the queue is
   * non-empty; the plain {@link round} answers when it is empty. Lets a loop test
   * script "round 1 has findings, round 2 is clean".
   */
  roundQueue: ExternalPlanReviewRound[] = [];
  /** The same for `resolve`. */
  resolutionQueue: ExternalPlanReviewResolution[] = [];

  /**
   * Hold a specific `status` call open, by its zero-based index.
   *
   * The point of the delay is not slowness but ordering: it lets a test decide
   * when each answer comes back, and therefore construct the interleaving where
   * a reading is computed from a world that changes before it is written.
   */
  onStatusCall: ((index: number) => Promise<unknown> | void) | null = null;
  /** Held open so a round can still be executing while something else runs. */
  reviewGate: Promise<unknown> | null = null;
  /** The same, for a resolution that has been dispatched and not yet answered. */
  resolveGate: Promise<unknown> | null = null;

  async status(subject: ExternalPlanReviewSubject, signal?: AbortSignal): Promise<ExternalPlanReviewStatus> {
    const index = this.statusCalls.length;
    this.statusCalls.push(subject);
    this.signals.status.push(signal);
    // Captured before the wait, so a delayed answer describes the session as it
    // was when it was read — which is exactly what a stale answer is.
    const answer = this.state;
    const wait = this.onStatusCall?.(index);
    if (wait) await wait;
    if (this.statusError) throw this.statusError;
    return answer;
  }

  async open(subject: ExternalPlanReviewSubject, signal?: AbortSignal): Promise<ExternalPlanReviewSession> {
    this.openCalls.push(subject);
    this.signals.open.push(signal);
    if (this.openError) throw this.openError;
    return this.session;
  }

  async reviewPlan(
    subject: ExternalPlanReviewSubject,
    planText: string,
    signal?: AbortSignal
  ): Promise<ExternalPlanReviewRound> {
    this.reviewCalls.push({ subject, planText });
    this.signals.review.push(signal);
    this.onReview?.();
    if (this.reviewGate) await this.reviewGate;
    if (this.reviewError) throw this.reviewError;
    return this.roundQueue.shift() ?? this.round;
  }

  async resolve(
    subject: ExternalPlanReviewSubject,
    decisions: readonly PlanReviewDecision[],
    signal?: AbortSignal
  ): Promise<ExternalPlanReviewResolution> {
    this.resolveCalls.push({ subject, decisions });
    this.signals.resolve.push(signal);
    this.onResolve?.();
    if (this.resolveGate) await this.resolveGate;
    if (this.resolveError) throw this.resolveError;
    return this.resolutionQueue.shift() ?? this.resolution;
  }
}

export function finding(title: string): PlanReviewFinding {
  return {
    severity: 'major',
    category: 'reliability',
    file: 'src/service.ts',
    line: 42,
    title,
    why: 'It matters for this round only.',
    fix: 'Address it.',
    providers: ['codex'],
    role: 'SecurityReliability'
  };
}
