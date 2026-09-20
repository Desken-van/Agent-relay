/**
 * A plan reviewer that behaves the way the real Coai server does about SESSIONS.
 *
 * The hand-driven {@link FakePlanReviewer} answers every call from one canned
 * session, which is exactly what let the plan-correction defect through: it cannot
 * notice that two gates asked for the same session. This one keeps a session per
 * (repository, branch) pair — Coai's own key, verified against the real server —
 * and enforces the rules that matter here:
 *
 * - `open` is idempotent: the same pair resumes the same session, whatever stage it
 *   has reached since. A ref Git cannot resolve is refused, as the real one does.
 * - `review_plan` runs a round only while the session is at PlanReview with nothing
 *   awaiting a resolution, and is refused otherwise — with the server's own words
 *   once the plan stage is over.
 * - `resolve` moves the session on: PlanReview again (a `revise` resolution) or
 *   CodeReview (a `proceed` one, after which no further plan round is possible).
 * - `status` reports exactly what happened in that one session, and refuses a pair
 *   that was never opened.
 *
 * What a round contains, and how each resolution ends, is scripted by the test
 * through the queues, so the loop under test is the only thing that varies.
 */

import { AgentRelayError, PlanReviewNotDispatchedError } from '../../src/shared/domain/errors';
import type {
  ExternalPlanReviewer,
  ExternalPlanReviewResolution,
  ExternalPlanReviewRound,
  ExternalPlanReviewSession,
  ExternalPlanReviewStatus,
  ExternalPlanReviewSubject
} from '../../src/main/ports';
import type { PlanReviewDecision } from '../../src/shared/domain/plan-review';
import { FINGERPRINT, finding } from './fake-plan-reviewer';

export const PLAN_STAGE_OVER =
  'the plan stage is over for this session (stage: CodeReview); open a new session for a new plan';

type Stage = 'PlanReview' | 'CodeReview' | 'Done';

interface SessionState {
  readonly sessionId: string;
  stage: Stage;
  awaitingResolve: boolean;
  planProceeded: boolean;
  /** One entry per plan round the session has run, in order. */
  rounds: { status: 'running' | 'done' | 'interrupted' }[];
}

export interface Tally {
  readonly total: number;
  readonly running: number;
  readonly done: number;
  readonly interrupted: number;
}

const keyOf = (subject: ExternalPlanReviewSubject): string => `${subject.repositoryPath}\u0000${subject.branch}`;

function tally(state: SessionState): Tally {
  const count = (status: SessionState['rounds'][number]['status']): number =>
    state.rounds.filter((round) => round.status === status).length;
  return { total: state.rounds.length, running: count('running'), done: count('done'), interrupted: count('interrupted') };
}

export class FakeCoaiPlanReviewer implements ExternalPlanReviewer {
  readonly sessions = new Map<string, SessionState>();
  readonly openCalls: ExternalPlanReviewSubject[] = [];
  readonly statusCalls: ExternalPlanReviewSubject[] = [];
  readonly reviewCalls: { subject: ExternalPlanReviewSubject; planText: string }[] = [];
  readonly resolveCalls: { subject: ExternalPlanReviewSubject; decisions: readonly PlanReviewDecision[] }[] = [];
  /** The signal each provider call was given, by call kind. */
  readonly signals: Record<'open' | 'review' | 'resolve' | 'status', (AbortSignal | undefined)[]> = {
    open: [],
    review: [],
    resolve: [],
    status: []
  };
  /** The refs Git can resolve. `null` accepts every name, which is how a test that does not care stays short. */
  knownRefs: Set<string> | null = null;
  contractFingerprint = FINGERPRINT;
  /** Make `open` report no round list at all, as a provider that does not say what its session holds. */
  openReportsNoRounds = false;
  /** When set, `status` answers with this instead of the session the subject names — a provider that answers for the wrong one. */
  statusOverride: ExternalPlanReviewStatus | null = null;

  /** What each `review_plan` returns, in order; a clean round once the queue is empty. */
  roundQueue: ExternalPlanReviewRound[] = [];
  /** How each `resolve` ends, in order: the stage the session is left in. CodeReview once the queue is empty. */
  resolutionQueue: ('PlanReview' | 'CodeReview')[] = [];

  openError: Error | null = null;
  statusError: Error | null = null;
  reviewError: Error | null = null;
  resolveError: Error | null = null;
  /**
   * When set, `review_plan` records the round in the session and THEN fails: the
   * request reached the provider and only its answer was lost — the case that must
   * never be repeated.
   */
  failAfterRecording = false;
  onOpen: (() => void) | null = null;
  onReview: (() => void) | null = null;
  reviewGate: Promise<unknown> | null = null;
  resolveGate: Promise<unknown> | null = null;
  openGate: Promise<unknown> | null = null;

  private counter = 0;

  /** Test-side view of one session, so an assertion can read what the provider believes. */
  sessionOf(subject: ExternalPlanReviewSubject): SessionState | undefined {
    return this.sessions.get(keyOf(subject));
  }

  /** Put a session into a state, as another gate or an operator working in the provider would have. */
  seed(
    subject: ExternalPlanReviewSubject,
    state: Partial<Pick<SessionState, 'stage' | 'awaitingResolve' | 'planProceeded'>> & {
      rounds?: readonly SessionState['rounds'][number]['status'][];
    }
  ): SessionState {
    const session = this.ensure(subject);
    if (state.stage !== undefined) session.stage = state.stage;
    if (state.awaitingResolve !== undefined) session.awaitingResolve = state.awaitingResolve;
    if (state.planProceeded !== undefined) session.planProceeded = state.planProceeded;
    if (state.rounds !== undefined) session.rounds = state.rounds.map((status) => ({ status }));
    return session;
  }

  /**
   * Make `subject` name the session `of` already names — the provider answering a new ref with
   * an old session, which is what a provider that does not honour the ref, or a stale record of
   * one, would do.
   */
  alias(subject: ExternalPlanReviewSubject, of: ExternalPlanReviewSubject): void {
    const target = this.sessions.get(keyOf(of));
    if (!target) throw new Error('There is no session to alias.');
    this.sessions.set(keyOf(subject), target);
  }

  private ensure(subject: ExternalPlanReviewSubject): SessionState {
    if (this.knownRefs !== null && !this.knownRefs.has(subject.branch)) {
      // What the adapter types from the provider's documented refusal.
      throw new PlanReviewNotDispatchedError(
        'unresolvable_subject',
        `Coai refused the request: git rev-parse: cannot resolve '${subject.branch}': fatal: Needed a single revision`
      );
    }
    const existing = this.sessions.get(keyOf(subject));
    if (existing) return existing;
    this.counter += 1;
    const created: SessionState = {
      sessionId: `coai-session-${this.counter}`,
      stage: 'PlanReview',
      awaitingResolve: false,
      planProceeded: false,
      rounds: []
    };
    this.sessions.set(keyOf(subject), created);
    return created;
  }

  async open(subject: ExternalPlanReviewSubject, signal?: AbortSignal): Promise<ExternalPlanReviewSession> {
    this.openCalls.push(subject);
    this.signals.open.push(signal);
    this.onOpen?.();
    if (this.openGate) await this.openGate;
    if (this.openError) throw this.openError;
    const session = this.ensure(subject);
    return {
      sessionId: session.sessionId,
      stage: session.stage,
      awaitingResolve: session.awaitingResolve,
      planProceeded: session.planProceeded,
      planRounds: this.openReportsNoRounds ? null : tally(session),
      serverName: 'coai-mcp',
      serverVersion: '1.2.3',
      contractFingerprint: this.contractFingerprint
    };
  }

  async status(subject: ExternalPlanReviewSubject, signal?: AbortSignal): Promise<ExternalPlanReviewStatus> {
    this.statusCalls.push(subject);
    this.signals.status.push(signal);
    if (this.statusError) throw this.statusError;
    if (this.statusOverride) return this.statusOverride;
    const session = this.sessions.get(keyOf(subject));
    if (!session) {
      throw new AgentRelayError('NOT_FOUND', 'Coai has no session for this repository and branch.');
    }
    return {
      sessionId: session.sessionId,
      stage: session.stage,
      awaitingResolve: session.awaitingResolve,
      planProceeded: session.planProceeded,
      planRounds: tally(session),
      serverName: 'coai-mcp',
      serverVersion: '1.2.3',
      contractFingerprint: this.contractFingerprint
    };
  }

  async reviewPlan(
    subject: ExternalPlanReviewSubject,
    planText: string,
    signal?: AbortSignal
  ): Promise<ExternalPlanReviewRound> {
    this.reviewCalls.push({ subject, planText });
    this.signals.review.push(signal);
    this.onReview?.();
    const session = this.sessions.get(keyOf(subject));
    if (!session) {
      throw new PlanReviewNotDispatchedError('no_session', 'Coai refused the request: no session for this repo+branch — call open first');
    }
    // The adapter recognises Coai's documented refusals and types them; a refusal in other
    // words stays an ordinary failure, exactly as here.
    if (session.stage !== 'PlanReview') {
      throw new PlanReviewNotDispatchedError('plan_stage_over', `Coai refused the request: ${PLAN_STAGE_OVER.replace('CodeReview', session.stage)}`);
    }
    if (session.awaitingResolve) {
      throw new AgentRelayError('TOOL_FAILED', 'Coai refused the request: a plan round is awaiting resolution; call resolve first');
    }
    if (this.reviewGate) await this.reviewGate;
    if (this.reviewError) throw this.reviewError;
    session.rounds.push({ status: 'done' });
    session.awaitingResolve = true;
    if (this.failAfterRecording) throw new AgentRelayError('TIMEOUT', 'The Coai call timed out.');
    return (
      this.roundQueue.shift() ?? {
        verdict: 'proceed',
        gatingCount: 0,
        threshold: 2,
        reviewers: 'all 2 reviewers answered',
        findings: [finding('A finding')],
        instruction: 'resolve every finding',
        serverName: 'coai-mcp',
        serverVersion: '1.2.3',
        contractFingerprint: this.contractFingerprint
      }
    );
  }

  async resolve(
    subject: ExternalPlanReviewSubject,
    decisions: readonly PlanReviewDecision[],
    signal?: AbortSignal
  ): Promise<ExternalPlanReviewResolution> {
    this.resolveCalls.push({ subject, decisions });
    this.signals.resolve.push(signal);
    const session = this.sessions.get(keyOf(subject));
    if (!session || !session.awaitingResolve) {
      throw new AgentRelayError('TOOL_FAILED', 'Coai refused the request: no plan round awaits resolution');
    }
    if (this.resolveGate) await this.resolveGate;
    if (this.resolveError) throw this.resolveError;
    const ends = this.resolutionQueue.shift() ?? 'CodeReview';
    session.awaitingResolve = false;
    session.stage = ends;
    session.planProceeded = ends !== 'PlanReview';
    return {
      stage: ends,
      awaitingResolve: false,
      recordedDecisions: decisions.length,
      instruction: 'continue',
      serverName: 'coai-mcp',
      serverVersion: '1.2.3',
      contractFingerprint: this.contractFingerprint
    };
  }
}
