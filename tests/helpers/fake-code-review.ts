/**
 * Fakes for the code-review service: a snapshot source the test controls file by
 * file, and an external reviewer whose every call records the signal it was given
 * and can be held open, so a test decides when (and how) each provider call ends.
 */

import type {
  CodeReviewerAvailability,
  CodeSnapshotRequest,
  CodeSnapshotSource,
  ExternalCodeReviewer,
  ExternalCodeReviewRound,
  ExternalCodeReviewSubject,
  ExternalCodeRoundLocator,
  ExternalCodeRoundStatus,
  RawCheckoutIdentity,
  RawCodeSnapshot,
  RawCodeSnapshotFile,
  RawCodeSnapshotFingerprint
} from '../../src/main/ports';
import type { ProviderCodeFinding } from '../../src/shared/domain/code-review';

/**
 * A provider call a test holds open and ends by hand, either way.
 *
 * `release()` lets the held call answer normally; `fail(error)` makes it throw.
 * The promise is created already handled, so a hold nobody awaits (a test that
 * ends before the call does) cannot surface as an unhandled rejection.
 */
export class Hold {
  readonly promise: Promise<void>;
  private settle!: { resolve: () => void; reject: (error: Error) => void };

  constructor() {
    this.promise = new Promise<void>((resolve, reject) => {
      this.settle = { resolve, reject };
    });
    this.promise.catch(() => undefined);
  }

  release(): void {
    this.settle.resolve();
  }

  fail(error: Error): void {
    this.settle.reject(error);
  }
}

export const BASE = '1'.repeat(40);

/** A fixed, valid-shaped contract fingerprint — its value is asserted on only where a test names it. */
export const FINGERPRINT = 'f'.repeat(64);


/**
 * A snapshot source whose answer the test controls file by file.
 *
 * `content` is what would be on disk; the fake writes it into a temporary
 * worktree so the service's own file reading and hashing are exercised rather
 * than stubbed.
 */
export class FakeSnapshotSource implements CodeSnapshotSource {
  readonly calls: CodeSnapshotRequest[] = [];
  readonly checkoutCalls: string[] = [];
  headCommit = '2'.repeat(40);
  files: RawCodeSnapshotFile[] = [];
  truncated = false;
  hasUncommittedState = false;
  error: Error | null = null;
  /**
   * What the stability fingerprint reports, per call.
   *
   * The default is a constant, so an ordinary capture is stable. A test that
   * wants to model the tree moving mid-capture returns a different value on the
   * later reads.
   */
  fingerprints: RawCodeSnapshotFingerprint[] = [];
  readonly fingerprintCalls: number[] = [];
  /** What `describeCheckout` reports, keyed by the path it is asked about. */
  checkouts = new Map<string, RawCheckoutIdentity>();
  defaultCheckout: RawCheckoutIdentity = {
    commonDir: 'C:/repo/.git',
    branch: 'agent/task-1',
    detached: false
  };

  async describeCheckout(worktreePath: string): Promise<RawCheckoutIdentity> {
    this.checkoutCalls.push(worktreePath);
    return this.checkouts.get(worktreePath) ?? this.defaultCheckout;
  }

  private nextFingerprint(): RawCodeSnapshotFingerprint {
    const index = this.fingerprintCalls.length;
    this.fingerprintCalls.push(index);
    return (
      this.fingerprints[index] ??
      this.fingerprints[this.fingerprints.length - 1] ?? {
        headCommit: this.headCommit,
        branch: 'agent/task-1',
        status: '',
        changeSet: ''
      }
    );
  }

  async fingerprint(): Promise<RawCodeSnapshotFingerprint> {
    if (this.error) throw this.error;
    return this.nextFingerprint();
  }

  /** Runs the moment a capture is requested, before it answers — where a test lands a Stop at a chosen point. */
  onCapture: (() => void) | null = null;

  async capture(request: CodeSnapshotRequest): Promise<RawCodeSnapshot> {
    this.calls.push(request);
    this.onCapture?.();
    if (this.error) throw this.error;
    return {
      baseCommit: BASE,
      headCommit: this.headCommit,
      branch: 'agent/task-1',
      files: this.files,
      truncated: this.truncated,
      hasUncommittedState: this.hasUncommittedState,
      fingerprint: this.nextFingerprint()
    };
  }
}

export class FakeCodeReviewer implements ExternalCodeReviewer {
  readsUncommittedWorktreeState = true;
  /** Who this reviewer is. Tests change it to model a reconfigured build. */
  providerId = 'coai';
  /** What the typed preflight answers. Tests make it refuse. */
  available: CodeReviewerAvailability = { available: true, reason: null };
  readonly availabilityCalls: number[] = [];
  /**
   * What the reviewer attests it read.
   *
   * `undefined` means "echo the dispatched subject", which is what an honest
   * adapter does; a test sets it to something else to forge a mismatch.
   */
  attest: string | null | undefined = undefined;
  readonly calls: {
    locator: ExternalCodeRoundLocator;
    subject: ExternalCodeReviewSubject;
    scopeText: string;
  }[] = [];
  /**
   * The locators `beginRound` hands out, in order.
   *
   * A fresh one per call by default, because a real provider opens a new round
   * each time; a test that wants two rounds to collide sets them explicitly.
   */
  locators: ExternalCodeRoundLocator[] = [];
  readonly beginCalls: ExternalCodeReviewSubject[] = [];
  /** The idempotency key each reservation was asked for. */
  readonly beginTokens: string[] = [];
  beginError: Error | null = null;
  /** Runs at the moment the round is opened, before a locator is returned. */
  onBegin: (() => void) | null = null;
  /**
   * What the answer claims to be, when it is not simply the dispatched locator.
   *
   * `undefined` means "echo the locator it was called with", which is what an
   * honest adapter does; a test sets it to forge an answer from another round.
   */
  answerLocator: ExternalCodeRoundLocator | undefined = undefined;
  /** Runs at the moment the call is dispatched, before it answers. */
  onCall: (() => void) | null = null;
  error: Error | null = null;
  answer: ExternalCodeReviewRound = {
    locator: { providerId: 'coai', sessionId: 'session-1', roundId: 'round-1' },
    reviewedSubjectSha256: null,
    verdict: 'revise',
    gatingCount: 1,
    threshold: 0,
    reviewers: 'all 3 reviewers answered',
    findings: [],
    instruction: 'resolve every finding',
    serverName: 'coai-mcp',
    serverVersion: '1.2.3',
    contractFingerprint: FINGERPRINT,
    tokensIn: 100,
    tokensOut: 20
  };

  /** What the read-only round read-back reports. */
  roundStatusAnswer: ExternalCodeRoundStatus = {
    kind: 'unknown',
    reason: 'not configured',
    contractFingerprint: null
  };
  /**
   * What each read-back was asked about.
   *
   * Both halves are recorded because the point of the locator is that the
   * subject alone is not enough to name a round.
   */
  readonly roundStatusCalls: {
    locator: ExternalCodeRoundLocator;
    subject: ExternalCodeReviewSubject;
  }[] = [];

  /** The signal each call was handed, per operation, in call order. */
  readonly signals: Record<'availability' | 'begin' | 'review' | 'status', (AbortSignal | undefined)[]> = {
    availability: [],
    begin: [],
    review: [],
    status: []
  };
  /**
   * When set, that call is held after it is dispatched and answers (or throws)
   * only once the test ends the hold. Cleared by the test between uses.
   */
  availabilityHold: Hold | null = null;
  beginHold: Hold | null = null;
  reviewHold: Hold | null = null;
  statusHold: Hold | null = null;

  async availability(signal?: AbortSignal): Promise<CodeReviewerAvailability> {
    this.availabilityCalls.push(this.calls.length);
    this.signals.availability.push(signal);
    if (this.availabilityHold) await this.availabilityHold.promise;
    return this.available;
  }

  async beginRound(
    subject: ExternalCodeReviewSubject,
    clientToken: string,
    signal?: AbortSignal
  ): Promise<ExternalCodeRoundLocator> {
    this.beginCalls.push(subject);
    this.beginTokens.push(clientToken);
    this.signals.begin.push(signal);
    this.onBegin?.();
    if (this.beginHold) await this.beginHold.promise;
    if (this.beginError) throw this.beginError;
    const index = this.beginCalls.length - 1;
    return (
      this.locators[index] ?? {
        providerId: this.providerId,
        sessionId: `session-${index + 1}`,
        roundId: `round-${index + 1}`,
        contractFingerprint: FINGERPRINT
      }
    );
  }

  async roundStatus(
    locator: ExternalCodeRoundLocator,
    subject: ExternalCodeReviewSubject,
    signal?: AbortSignal
  ): Promise<ExternalCodeRoundStatus> {
    this.roundStatusCalls.push({ locator, subject });
    this.signals.status.push(signal);
    if (this.statusHold) await this.statusHold.promise;
    return this.roundStatusAnswer;
  }

  async reviewCode(
    locator: ExternalCodeRoundLocator,
    subject: ExternalCodeReviewSubject,
    scopeText: string,
    signal?: AbortSignal
  ): Promise<ExternalCodeReviewRound> {
    this.calls.push({ locator, subject, scopeText });
    this.signals.review.push(signal);
    this.onCall?.();
    if (this.reviewHold) await this.reviewHold.promise;
    if (this.error) throw this.error;
    return {
      ...this.answer,
      locator: this.answerLocator ?? locator,
      reviewedSubjectSha256:
        this.attest === undefined ? subject.subjectSha256 : this.attest
    };
  }
}

export function finding(overrides: Partial<ProviderCodeFinding> = {}): ProviderCodeFinding {
  return {
    severity: 'major',
    category: 'reliability',
    gating: true,
    title: 'The retry is ambiguous',
    body: 'A lost response may repeat work.',
    fix: 'Persist the intent before calling out.',
    file: 'src/service.ts',
    line: 42,
    provider: 'codex',
    role: 'SecurityReliability',
    ...overrides
  };
}
