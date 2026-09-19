/**
 * The lifecycle: durable intent, stale results, and decisions that stay put.
 *
 * The reviewer and the Git snapshot are fakes, deliberately: what is under test
 * is what Agent Relay writes and refuses, and a real provider would make the
 * ordering non-deterministic without proving anything extra. The snapshot's own
 * fidelity is proved separately, against a real repository.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteCodeReviewRepository } from '../../src/main/db/repositories/code-review-repository';
import {
  CodeReviewClaims,
  CodeReviewService,
  type CodeReviewDeps,
  type CodeReviewRoundOutcome
} from '../../src/main/services/code-review';
import {
  CodeReviewNotDispatchedError,
  SettingsBoundCodeReviewer,
  UnconfiguredCodeReviewer
} from '../../src/main/services/code-review-provider';
import { defaultSettings } from '../../src/main/container';
import type { Settings } from '../../src/shared/domain/models';
import type {
  CodeReviewerAvailability,
  ExternalCodeRoundLocator,
  ExternalCodeRoundStatus,
  RawCodeSnapshotFingerprint,
  CodeSnapshotRequest,
  CodeSnapshotSource,
  ExternalCodeReviewer,
  ExternalCodeReviewRound,
  ExternalCodeReviewSubject,
  ExternalMcpCallResult,
  ExternalMcpClient,
  ExternalMcpDiscovery,
  ExternalMcpServerConfig,
  ExternalMcpTool,
  RawCheckoutIdentity,
  RawCodeSnapshot,
  RawCodeSnapshotFile
} from '../../src/main/ports';
import {
  nodeSnapshotFileOps,
  type SnapshotFileOps
} from '../../src/main/adapters/git/git-code-snapshot';
import {
  codeReviewCurrentTriageRecommendations,
  parseCodeReviewTriage,
  type ProviderCodeFinding
} from '../../src/shared/domain/code-review';
import { AgentRelayError } from '../../src/shared/domain/errors';
import { CoaiCodeReviewer } from '../../src/main/adapters/mcp/coai-code-reviewer';
import {
  COAI_ADDRESSABLE_PROFILE,
  COAI_CODE_REVIEW_TOOLS,
  COAI_PROVIDER_ID
} from '../../src/main/adapters/mcp/coai-profiles';
import { createHarness, type Harness } from '../helpers/harness';
import { FakeCodexAdapter, makeSpecification } from '../helpers/fakes';

const BASE = '1'.repeat(40);

/** A fixed, valid-shaped contract fingerprint — its value is asserted on only where a test names it. */
const FINGERPRINT = 'f'.repeat(64);

const ESCAPE = String.fromCharCode(27);

/**
 * A wholly fictional path, argv, escape sequence and token.
 *
 * Nothing here exists. It is shaped like what an MCP server could actually put
 * in a refusal — `CoaiCodeReviewer.parse` quotes a server's refusal sentence
 * into the error message on purpose — and every fragment is asserted absent
 * from durable storage.
 */
const HOSTILE =
  'refused at C:/Users/someone/AppData/coai/coai-mcp.exe --stdio' +
  ESCAPE +
  '[31m GH_TOKEN=ghp_A1b2C3d4E5f6G7h8I9j0';

const LEAKS = [
  'C:/Users/someone',
  'coai-mcp.exe',
  '--stdio',
  'AppData',
  ESCAPE,
  'ghp_A1b2C3d4E5f6G7h8I9j0'
];

/**
 * A snapshot source whose answer the test controls file by file.
 *
 * `content` is what would be on disk; the fake writes it into a temporary
 * worktree so the service's own file reading and hashing are exercised rather
 * than stubbed.
 */
class FakeSnapshotSource implements CodeSnapshotSource {
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

  async capture(request: CodeSnapshotRequest): Promise<RawCodeSnapshot> {
    this.calls.push(request);
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

class FakeCodeReviewer implements ExternalCodeReviewer {
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

  async availability(): Promise<CodeReviewerAvailability> {
    this.availabilityCalls.push(this.calls.length);
    return this.available;
  }

  async beginRound(
    subject: ExternalCodeReviewSubject,
    clientToken: string
  ): Promise<ExternalCodeRoundLocator> {
    this.beginCalls.push(subject);
    this.beginTokens.push(clientToken);
    this.onBegin?.();
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
    subject: ExternalCodeReviewSubject
  ): Promise<ExternalCodeRoundStatus> {
    this.roundStatusCalls.push({ locator, subject });
    return this.roundStatusAnswer;
  }

  async reviewCode(
    locator: ExternalCodeRoundLocator,
    subject: ExternalCodeReviewSubject,
    scopeText: string
  ): Promise<ExternalCodeReviewRound> {
    this.calls.push({ locator, subject, scopeText });
    this.onCall?.();
    if (this.error) throw this.error;
    return {
      ...this.answer,
      locator: this.answerLocator ?? locator,
      reviewedSubjectSha256:
        this.attest === undefined ? subject.subjectSha256 : this.attest
    };
  }
}

function finding(overrides: Partial<ProviderCodeFinding> = {}): ProviderCodeFinding {
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

const harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.dispose();
});

function setup() {
  const harness = createHarness();
  harnesses.push(harness);
  const reviews = new SqliteCodeReviewRepository(harness.db, harness.clock);
  const snapshots = new FakeSnapshotSource();
  const reviewer = new FakeCodeReviewer();
  const claims = new CodeReviewClaims();
  const build = (extra: Partial<CodeReviewDeps> = {}): CodeReviewService =>
    new CodeReviewService({
      tasks: harness.tasks,
      projects: harness.projects,
      reviews,
      snapshots,
      reviewer,
      claims,
      clock: harness.clock,
      ids: harness.ids,
      ...extra
    });

  const project = harness.createProject();
  const task = harness.createTask(project.id, {
    status: 'READY_FOR_IMPLEMENTATION',
    worktreePath: harness.worktreesRoot,
    branchName: 'agent/task-1',
    baseBranch: 'main',
    specificationJson: JSON.stringify(makeSpecification())
  });
  // The worktree and the project share one repository by default, and the
  // worktree sits on the branch the task records. Tests that care make them
  // disagree.
  snapshots.checkouts.set(project.localPath, {
    commonDir: 'C:/repo/.git',
    branch: 'main',
    detached: false
  });

  return { harness, reviews, snapshots, reviewer, claims, service: build(), build, task };
}

async function reviewOnce(value: ReturnType<typeof setup>): Promise<CodeReviewRoundOutcome> {
  await value.service.captureSubject(value.task.id);
  return value.service.review(value.task.id);
}

describe('the code-review subject', () => {
  it('keeps terminal task review history readable but refuses every mutating IPC operation', async () => {
    const value = setup();
    value.harness.tasks.update(value.task.id, { status: 'FAILED' });

    expect((await value.service.subjectIdentity(value.task.id)).identity).toBe('no_subject');
    await expect(value.service.captureSubject(value.task.id)).rejects.toThrow(/closed/i);
    await expect(value.service.review(value.task.id)).rejects.toThrow(/closed/i);
    await expect(value.service.reconcile(value.task.id)).rejects.toThrow(/closed/i);
    await expect(value.service.decide(value.task.id, {
      findingId: 'missing-finding',
      action: 'accept',
      reason: 'Historical decision must remain immutable.',
      expectedRevision: 0,
      actor: 'operator',
      source: 'test'
    })).rejects.toThrow(/closed/i);

    expect(value.snapshots.calls).toHaveLength(0);
    expect(value.reviewer.beginCalls).toHaveLength(0);
    expect(value.reviewer.calls).toHaveLength(0);
    expect(value.reviews.latestSubject(value.task.id)).toBeNull();
    expect(value.reviews.listRounds(value.task.id)).toEqual([]);
  });

  it('captures without staging, committing or otherwise touching the worktree', async () => {
    const value = setup();
    await value.service.captureSubject(value.task.id);

    // The only Git contact is the read-only snapshot source; nothing in this
    // service can reach a mutating command. The fake Git adapter the harness
    // installs records every worktree it was asked to create or commit to.
    //
    // Twice, because an exact snapshot is digested and then digested again to
    // prove the bytes did not move underneath it. Both passes are reads.
    expect(value.snapshots.calls).toHaveLength(2);
    expect(value.harness.git.createdWorktrees).toHaveLength(0);
    expect(value.harness.git.commits).toHaveLength(0);
    expect(value.harness.git.pushes).toHaveLength(0);
  });

  it('is idempotent for an unchanged working state', async () => {
    const value = setup();
    const first = await value.service.captureSubject(value.task.id);
    const second = await value.service.captureSubject(value.task.id);

    expect(second.id).toBe(first.id);
    expect(second.subjectSha256).toBe(first.subjectSha256);
    expect(value.reviews.listRounds(value.task.id)).toHaveLength(0);
  });

  it('reports a moved head as stale, and an unreadable checkout as unknown', async () => {
    const value = setup();
    await value.service.captureSubject(value.task.id);
    expect((await value.service.subjectIdentity(value.task.id)).identity).toBe('current');

    value.snapshots.headCommit = '9'.repeat(40);
    expect((await value.service.subjectIdentity(value.task.id)).identity).toBe('stale');

    // Nothing was compared here, so nothing is known. Calling it stale would
    // send an operator to capture again, which is what just failed.
    value.snapshots.error = new Error('the worktree is gone');
    expect((await value.service.subjectIdentity(value.task.id)).identity).toBe('unknown');
  });

  it('has no subject to judge before one is captured', async () => {
    const value = setup();
    expect((await value.service.subjectIdentity(value.task.id)).identity).toBe('no_subject');
  });
});

describe('the code-review round', () => {
  it('writes durable intent before the reviewer is called', async () => {
    const value = setup();
    const subject = await value.service.captureSubject(value.task.id);

    // Asserted at the moment of dispatch, not afterwards: a row written only
    // once the answer came back would leave a crash window in which a
    // non-idempotent call had run and nothing recorded that it had.
    value.reviewer.onCall = () => {
      const round = value.reviews.latestRound(value.task.id);
      expect(round).not.toBeNull();
      expect(round?.status).toBe('reviewing');
      expect(round?.subjectSha256).toBe(subject.subjectSha256);
      expect(round?.startedAt).not.toBeNull();
    };

    const outcome = await value.service.review(value.task.id);
    expect(value.reviewer.calls).toHaveLength(1);
    expect(outcome.round.status).toBe('completed');
    expect(outcome.round.verdict).toBe('revise');
    expect(outcome.round.tokensIn).toBe(100);
  });

  it('leaves a lost answer as an unknown outcome and never repeats it', async () => {
    const value = setup();
    await value.service.captureSubject(value.task.id);
    value.reviewer.error = new Error('the reviewer never answered');
    await expect(value.service.review(value.task.id)).rejects.toThrow(/never answered/);

    const round = value.reviews.latestRound(value.task.id);
    expect(round?.status).toBe('reviewing');
    // The reviewer's own sentence reached the CALLER above, where it belongs.
    // The durable column gets Agent Relay's own words and nothing foreign.
    expect(round?.lastError).toMatch(/outcome could not be confirmed/i);
    expect(round?.lastError).not.toMatch(/never answered/);

    // The call left this process and only its answer was lost. A second
    // dispatch is refused, and marking it interrupted does not unlock one.
    value.reviewer.error = null;
    await expect(value.service.review(value.task.id)).rejects.toThrow(/already been dispatched/i);
    value.service.markInterrupted(value.task.id, round!.id, 'no answer arrived');
    await expect(value.service.review(value.task.id)).rejects.toThrow(/already been dispatched/i);
    expect(value.reviewer.calls).toHaveLength(1);
  });

  it('refuses a second round while one is in flight, from any service instance', async () => {
    const value = setup();
    await value.service.captureSubject(value.task.id);

    let concurrent: Promise<unknown> | null = null;
    value.reviewer.onCall = () => {
      // A second service built from the same container shares the claim, so a
      // direct call cannot slip past the one already running.
      concurrent = expect(value.build().review(value.task.id)).rejects.toMatchObject({
        code: 'BUSY'
      });
    };

    await value.service.review(value.task.id);
    await concurrent;
    expect(value.reviewer.calls).toHaveLength(1);
  });

  it('refuses to review without a subject that matches the current code', async () => {
    const value = setup();
    await expect(value.service.review(value.task.id)).rejects.toThrow(/no captured code-review subject/i);

    await value.service.captureSubject(value.task.id);
    value.snapshots.headCommit = '9'.repeat(40);
    await expect(value.service.review(value.task.id)).rejects.toThrow(/no captured code-review subject/i);
    expect(value.reviewer.calls).toHaveLength(0);
    expect(value.reviews.listRounds(value.task.id)).toHaveLength(0);
  });

  it('keeps a result whose code changed underneath as history, not as a live one', async () => {
    const value = setup();
    const subject = await value.service.captureSubject(value.task.id);
    value.reviewer.answer = { ...value.reviewer.answer, findings: [finding()] };
    // The working tree moves while the reviewer is thinking.
    value.reviewer.onCall = () => {
      value.snapshots.headCommit = '9'.repeat(40);
    };

    const outcome = await value.service.review(value.task.id);

    expect(outcome.subjectAfter).toBe('stale');
    expect(outcome.round.status).toBe('completed');
    expect(outcome.round.lastError).toMatch(/changed while the round was running/i);
    // Findings are recorded against the subject that was actually read, never
    // re-targeted onto the state the code has since reached.
    expect(outcome.findings[0]?.subjectSha256).toBe(subject.subjectSha256);
    expect(value.reviews.listFindingsForSubject(value.task.id, subject.subjectSha256)).toHaveLength(1);
  });

  it('does not turn a malformed, oversized or refused answer into a completed review', async () => {
    const cases: { name: string; answer: Partial<ExternalCodeReviewRound>; error: RegExp }[] = [
      {
        name: 'an unknown verdict',
        answer: { verdict: 'looks-fine-to-me' },
        error: /invalid|expected/i
      },
      {
        name: 'a finding with no severity the gate understands',
        answer: { findings: [{ ...finding(), severity: 'catastrophic' } as never] },
        error: /invalid|expected/i
      },
      {
        name: 'more findings than the ceiling allows',
        answer: { findings: Array.from({ length: 513 }, () => finding()) },
        error: /too big|at most|expected/i
      },
      {
        name: 'credential-shaped reviewer text',
        answer: {
          findings: [finding({ body: 'Use api_key = "AKIA1234567890ABCDEF" for the retry.' })]
        },
        error: /credential-shaped/i
      }
    ];

    for (const scenario of cases) {
      const value = setup();
      await value.service.captureSubject(value.task.id);
      value.reviewer.answer = { ...value.reviewer.answer, ...scenario.answer };

      await expect(value.service.review(value.task.id)).rejects.toThrow(scenario.error);

      // The round stays unresolved and carries the reason. It is emphatically
      // not `completed`, because nothing usable came back.
      const round = value.reviews.latestRound(value.task.id);
      expect(round?.status, scenario.name).toBe('reviewing');
      expect(round?.verdict).toBeNull();
      expect(value.reviews.listFindings(value.task.id)).toHaveLength(0);
    }
  });

  it('refuses to run at all when no provider adapter is configured', async () => {
    const value = setup();
    const unconfigured = new CodeReviewService({
      tasks: value.harness.tasks,
      projects: value.harness.projects,
      reviews: value.reviews,
      snapshots: value.snapshots,
      reviewer: new UnconfiguredCodeReviewer(),
      claims: new CodeReviewClaims(),
      clock: value.harness.clock,
      ids: value.harness.ids
    });
    await value.service.captureSubject(value.task.id);

    // "No provider is configured" must never read as "the review found
    // nothing". It must not read as "a call went out" either: this refusal
    // happens before anything leaves the process, so it leaves no round to
    // reconcile. The earlier version of this test asserted a `reviewing` row
    // here, which recorded a dispatch that provably never occurred.
    await expect(unconfigured.review(value.task.id)).rejects.toMatchObject({
      code: 'TOOL_MISSING'
    });
    expect(value.reviews.listRounds(value.task.id)).toHaveLength(0);
  });
});

/**
 * What INT-D-A-R1 fixed: a snapshot that was not exact, a checkout that was not
 * the task's, an answer written half-way, and staleness inferred from silence.
 */
describe('code-review exactness, checkout identity and atomicity', () => {
  it('refuses to review an incomplete subject rather than calling it exact', async () => {
    const value = setup();
    // One file the reader cannot digest. The capture still succeeds and is
    // still stored — it says what was and was not seen — but it is not an exact
    // statement of the code, so nothing may be reviewed against it.
    value.snapshots.files = [
      { path: 'src/one.ts', change: 'modified', absolutePath: join(value.harness.worktreesRoot, 'missing.ts') }
    ];
    const subject = await value.service.captureSubject(value.task.id);

    expect(subject.complete).toBe(false);
    expect((await value.service.subjectIdentity(value.task.id)).identity).toBe('incomplete');
    await expect(value.service.review(value.task.id)).rejects.toThrow(/not an exact statement/i);
    expect(value.reviewer.calls).toHaveLength(0);
    expect(value.reviews.listRounds(value.task.id)).toHaveLength(0);
  });

  it('treats a truncated change set as incomplete rather than as the whole story', async () => {
    const value = setup();
    value.snapshots.truncated = true;
    const subject = await value.service.captureSubject(value.task.id);

    expect(subject.truncated).toBe(true);
    expect(subject.complete).toBe(false);
    expect((await value.service.subjectIdentity(value.task.id)).identity).toBe('incomplete');
    await expect(value.service.review(value.task.id)).rejects.toThrow(/not an exact statement/i);
  });

  it('refuses to dispatch when the worktree is not the one the task records', async () => {
    const cases: { name: string; checkout: RawCheckoutIdentity }[] = [
      {
        name: 'another repository',
        checkout: { commonDir: 'C:/somewhere-else/.git', branch: 'agent/task-1', detached: false }
      },
      {
        name: 'a detached HEAD',
        checkout: { commonDir: 'C:/repo/.git', branch: null, detached: true }
      },
      {
        name: 'a different branch',
        checkout: { commonDir: 'C:/repo/.git', branch: 'agent/other', detached: false }
      }
    ];

    for (const scenario of cases) {
      const value = setup();
      await value.service.captureSubject(value.task.id);
      value.snapshots.checkouts.set(value.harness.worktreesRoot, scenario.checkout);

      await expect(value.service.review(value.task.id), scenario.name).rejects.toMatchObject({
        code: 'WORKTREE_INVALID'
      });
      // Refused before anything durable and before the provider: no round row,
      // no call, nothing to reconcile afterwards.
      expect(value.reviews.listRounds(value.task.id), scenario.name).toHaveLength(0);
      expect(value.reviewer.calls, scenario.name).toHaveLength(0);
    }
  });

  it('hands the reviewer the task worktree, not the project checkout', async () => {
    const value = setup();
    const subject = await value.service.captureSubject(value.task.id);
    await value.service.review(value.task.id);

    const sent = value.reviewer.calls[0]?.subject;
    // The snapshot came from the worktree and includes its uncommitted state.
    // Pointing the reviewer at the project root would hand it a different
    // working tree that merely shares a repository.
    expect(sent?.worktreePath).toBe(value.harness.worktreesRoot);
    expect(sent?.worktreePath).not.toBe(value.harness.projects.findById(value.task.projectId)?.localPath);
    expect(sent?.subjectSha256).toBe(subject.subjectSha256);
    expect(sent?.headCommit).toBe(subject.headCommit);
    expect(sent?.baseRef).toBe(subject.baseCommit);
  });

  it('refuses to send uncommitted work to a reviewer that reads only commits', async () => {
    const value = setup();
    value.snapshots.hasUncommittedState = true;
    value.reviewer.readsUncommittedWorktreeState = false;
    const subject = await value.service.captureSubject(value.task.id);

    expect(subject.hasUncommittedState).toBe(true);
    // Dispatching would not produce a worse review — it would produce a
    // confident verdict about different code.
    await expect(value.service.review(value.task.id)).rejects.toThrow(/reads only committed refs/i);
    expect(value.reviewer.calls).toHaveLength(0);
    expect(value.reviews.listRounds(value.task.id)).toHaveLength(0);
  });

  it('keeps an unreadable check-back as unknown, never as staleness', async () => {
    const value = setup();
    await value.service.captureSubject(value.task.id);
    // The checkout becomes unreadable while the round is running, so nothing
    // can be compared. Deriving staleness from a null hash would file this as
    // proof the code changed — a claim from the absence of evidence.
    value.reviewer.onCall = () => {
      value.snapshots.error = new Error('the worktree is gone');
    };

    const outcome = await value.service.review(value.task.id);

    expect(outcome.subjectAfter).toBe('unknown');
    expect(outcome.round.lastError).toMatch(/could not be read back/i);
    expect(outcome.round.lastError).not.toMatch(/changed while the round was running/i);
  });

  it('writes the whole round or none of it', async () => {
    const value = setup();
    await value.service.captureSubject(value.task.id);
    value.reviewer.answer = {
      ...value.reviewer.answer,
      findings: [finding(), finding({ title: 'The second one', line: 43 })]
    };

    // The second finding's insert fails. Without one transaction the round
    // would be left `completed` while carrying only the first — a row saying a
    // review finished, under-reporting what it found.
    let seen = 0;
    const realUpsert = value.reviews.upsertFinding.bind(value.reviews);
    value.reviews.upsertFinding = ((record: Parameters<typeof realUpsert>[0]) => {
      seen += 1;
      if (seen === 2) throw new Error('the second finding could not be written');
      return realUpsert(record);
    }) as typeof value.reviews.upsertFinding;

    await expect(value.service.review(value.task.id)).rejects.toThrow(/second finding/);

    const round = value.reviews.latestRound(value.task.id);
    expect(round?.status).not.toBe('completed');
    expect(value.reviews.listFindings(value.task.id)).toHaveLength(0);
  });

  it('records what each round said beside the finding it belongs to', async () => {
    const value = setup();
    value.reviewer.answer = { ...value.reviewer.answer, findings: [finding()] };
    const first = await reviewOnce(value);

    // The same defect, no longer counted against the gate and with a different
    // remedy suggested. Severity, category, location and prose are unchanged,
    // so the fingerprint matches and this is a repeat rather than a new record
    // — which is exactly the case where the round-specific facts would be lost
    // if they were folded into the stable row.
    value.reviewer.answer = {
      ...value.reviewer.answer,
      findings: [finding({ gating: false, fix: 'A different remedy.' })]
    };
    const second = await value.service.review(value.task.id);

    // A different body would be a different defect, so this repeat shares the
    // stable row — and the two rounds' own words are both still readable.
    const stable = second.findings[0]!;
    const occurrences = value.reviews.listOccurrences(stable.id);
    expect(occurrences).toHaveLength(2);
    expect(occurrences[0]).toMatchObject({
      gating: true,
      fix: 'Persist the intent before calling out.',
      roundId: first.round.id
    });
    expect(occurrences[1]).toMatchObject({
      gating: false,
      fix: 'A different remedy.',
      roundId: second.round.id
    });
    // One stable row, two statements about it.
    expect(value.reviews.listFindings(value.task.id)).toHaveLength(1);
    expect(stable.timesReported).toBe(2);
    expect(value.reviews.listOccurrencesForRound(second.round.id)).toHaveLength(1);
  });

  it('refuses a finding whose location escapes the repository', async () => {
    for (const file of [
      'C:\\Windows\\System32\\drivers\\etc\\hosts',
      '/etc/passwd',
      '../../../etc/passwd',
      'src/../../outside.ts',
      '//host/share/file.ts',
      'src\\windows\\path.ts'
    ]) {
      const value = setup();
      await value.service.captureSubject(value.task.id);
      value.reviewer.answer = {
        ...value.reviewer.answer,
        findings: [{ ...finding(), file } as never]
      };

      // Reviewer output is data from outside, and a path is the field something
      // downstream will eventually open. Refused, not sanitised.
      await expect(value.service.review(value.task.id), file).rejects.toThrow(
        /invalid|repository-relative|expected/i
      );
      expect(value.reviews.listFindings(value.task.id), file).toHaveLength(0);
      expect(value.reviews.latestRound(value.task.id)?.status, file).toBe('reviewing');
    }
  });
});

/**
 * What a screen would be told.
 *
 * Assembled here rather than in the renderer, and asserted here because the
 * distinction it encodes — live versus historical — is the difference between
 * an operator acting on a finding about the code they have and acting on one
 * about code that is gone.
 */
/**
 * What INT-D-A-R2 fixed: an unreadable file reported as a code change, a
 * provider repeating itself taken as a contradiction of the database, and a
 * refusal that never left the process leaving a round behind as if it had.
 */
describe('code-review incompleteness, duplicates and the dispatch boundary', () => {
  it('reports an incomplete check-back as incomplete, never as proof the code changed', async () => {
    const value = setup();
    // An exact subject is captured first, so there is something precise to
    // compare against.
    const subject = await value.service.captureSubject(value.task.id);
    expect(subject.complete).toBe(true);

    // While the round runs, one of the same files stops being readable. The
    // recapture therefore covers a different set of files and hashes
    // differently — but that difference is an artefact of the failed read, not
    // evidence that anybody edited anything.
    value.reviewer.onCall = () => {
      value.snapshots.files = [
        {
          path: 'src/one.ts',
          change: 'modified',
          absolutePath: join(value.harness.worktreesRoot, 'not-there.ts')
        }
      ];
    };

    const outcome = await value.service.review(value.task.id);

    expect(outcome.subjectAfter).toBe('incomplete');
    expect(outcome.round.lastError).toMatch(/could not be fully digested/i);
    expect(outcome.round.lastError).toMatch(/not evidence that the code changed/i);
    expect(outcome.round.lastError).not.toMatch(/changed while the round was running/i);
    expect((await value.service.subjectIdentity(value.task.id)).identity).toBe('incomplete');
  });

  it('puts incompleteness ahead of the hash, because a partial hash proves nothing', async () => {
    const value = setup();
    await value.service.captureSubject(value.task.id);

    // A different file list AND unreadable content. The hash differs, but the
    // honest answer is that nothing exact was compared.
    value.snapshots.files = [
      {
        path: 'src/other.ts',
        change: 'added',
        absolutePath: join(value.harness.worktreesRoot, 'missing.ts')
      }
    ];
    const identity = await value.service.subjectIdentity(value.task.id);

    expect(identity.identity).toBe('incomplete');
    expect(identity.currentSha256).not.toBe(identity.stored?.subjectSha256);
  });

  it('treats one finding reported twice as one finding', async () => {
    const value = setup();
    value.reviewer.answer = {
      ...value.reviewer.answer,
      findings: [finding(), finding()]
    };
    const outcome = await reviewOnce(value);

    // A provider listing the same defect twice is not describing two defects,
    // and it must not blow up the completion transaction either.
    expect(outcome.round.status).toBe('completed');
    expect(outcome.newFindings).toBe(1);
    expect(outcome.repeatedFindings).toBe(0);
    expect(value.reviews.listFindings(value.task.id)).toHaveLength(1);
    expect(value.reviews.listOccurrencesForRound(outcome.round.id)).toHaveLength(1);
  });

  it('refuses an answer that reports one finding twice with different details', async () => {
    const value = setup();
    await value.service.captureSubject(value.task.id);
    // The same fingerprint — `gating` and `fix` are deliberately outside it —
    // with contradictory round-specific facts. There is no honest way to pick
    // one, and picking silently would record a gating decision nobody made.
    value.reviewer.answer = {
      ...value.reviewer.answer,
      findings: [finding({ gating: true }), finding({ gating: false, fix: 'Something else.' })]
    };

    await expect(value.service.review(value.task.id)).rejects.toMatchObject({
      code: 'PARSE_FAILED'
    });

    const round = value.reviews.latestRound(value.task.id);
    expect(round?.status).toBe('reviewing');
    expect(round?.verdict).toBeNull();
    expect(round?.lastError).toMatch(/contradicts itself/i);
    expect(value.reviews.listFindings(value.task.id)).toHaveLength(0);
    expect(value.reviews.listOccurrencesForRound(round!.id)).toHaveLength(0);

    // And the next attempt does not mistake that round for a finished one.
    await expect(value.service.review(value.task.id)).rejects.toThrow(/already been dispatched/i);
  });

  it('leaves nothing behind when the reviewer is not available at all', async () => {
    const value = setup();
    await value.service.captureSubject(value.task.id);
    value.reviewer.available = { available: false, reason: 'No reviewer is configured.' };

    await expect(value.service.review(value.task.id)).rejects.toMatchObject({
      code: 'TOOL_MISSING'
    });

    // The refusal is provably local, so it must leave nothing to reconcile:
    // a `reviewing` row here would claim a call went out that never did.
    expect(value.reviews.listRounds(value.task.id)).toHaveLength(0);
    expect(value.reviewer.calls).toHaveLength(0);
    expect(value.reviewer.availabilityCalls).toEqual([0]);
  });

  it('asks whether the reviewer can run before it writes the round', async () => {
    const value = setup();
    await value.service.captureSubject(value.task.id);

    // Ordering, not just presence: the preflight must be the last question
    // asked while a refusal is still free.
    let roundsAtPreflight = -1;
    const realAvailability = value.reviewer.availability.bind(value.reviewer);
    value.reviewer.availability = async () => {
      roundsAtPreflight = value.reviews.listRounds(value.task.id).length;
      return realAvailability();
    };

    await value.service.review(value.task.id);
    expect(roundsAtPreflight).toBe(0);
    expect(value.reviews.listRounds(value.task.id)).toHaveLength(1);
  });

  it('keeps the capability refusal on the free side of the boundary too', async () => {
    const value = setup();
    value.snapshots.hasUncommittedState = true;
    value.reviewer.readsUncommittedWorktreeState = false;
    await value.service.captureSubject(value.task.id);

    await expect(value.service.review(value.task.id)).rejects.toThrow(/reads only committed refs/i);
    expect(value.reviews.listRounds(value.task.id)).toHaveLength(0);
    expect(value.reviewer.availabilityCalls).toHaveLength(0);
  });

  it('still leaves a lost answer unresolved, because that call really went out', async () => {
    const value = setup();
    await value.service.captureSubject(value.task.id);
    value.reviewer.error = new Error('the reviewer never answered');

    await expect(value.service.review(value.task.id)).rejects.toThrow(/never answered/);

    // The other side of the same boundary: past the dispatch, a failure is not
    // evidence of no effect, so the row stays and blocks an automatic retry.
    const round = value.reviews.latestRound(value.task.id);
    expect(round?.status).toBe('reviewing');
    value.reviewer.error = null;
    await expect(value.service.review(value.task.id)).rejects.toThrow(/already been dispatched/i);
  });

  it('rejects an answer that does not attest the subject it was given', async () => {
    for (const attest of [null, 'f'.repeat(64)]) {
      const value = setup();
      await value.service.captureSubject(value.task.id);
      value.reviewer.answer = { ...value.reviewer.answer, findings: [finding()] };
      value.reviewer.attest = attest;

      // A capability flag is a promise about a reviewer's habits; attestation
      // is evidence about this answer. Only the second catches a reviewer that
      // read the right tree at the wrong moment.
      await expect(value.service.review(value.task.id)).rejects.toMatchObject({
        code: 'PARSE_FAILED'
      });

      const round = value.reviews.latestRound(value.task.id);
      expect(round?.status).toBe('reviewing');
      expect(round?.verdict).toBeNull();
      expect(round?.lastError).toMatch(/did not attest/i);
      expect(value.reviews.listFindings(value.task.id)).toHaveLength(0);
    }
  });

  it('accepts an answer that attests the exact subject dispatched', async () => {
    const value = setup();
    const subject = await value.service.captureSubject(value.task.id);
    value.reviewer.answer = { ...value.reviewer.answer, findings: [finding()] };

    const outcome = await value.service.review(value.task.id);

    expect(value.reviewer.calls[0]?.subject.subjectSha256).toBe(subject.subjectSha256);
    expect(outcome.round.status).toBe('completed');
    expect(outcome.subjectAfter).toBe('current');
    expect(outcome.findings).toHaveLength(1);
  });
});

/**
 * What INT-D-A-R3 fixed: a lost round that blocked a task forever, a capture
 * that could hash bytes which never coexisted, and a provider refusal that
 * leaked its own text.
 */
describe('code-review recovery, capture stability and boundary hygiene', () => {
  async function stranded() {
    const value = setup();
    await value.service.captureSubject(value.task.id);
    value.reviewer.error = new Error('the reviewer never answered');
    await expect(value.service.review(value.task.id)).rejects.toThrow(/never answered/);
    value.reviewer.error = null;
    expect(value.reviews.latestRound(value.task.id)?.status).toBe('reviewing');
    return value;
  }

  it('settles a lost round when the provider proves it completed', async () => {
    const value = await stranded();
    const subject = value.reviews.latestSubject(value.task.id)!;
    value.reviewer.roundStatusAnswer = {
      kind: 'completed',
      round: {
        ...value.reviewer.answer,
        findings: [finding()],
        reviewedSubjectSha256: subject.subjectSha256
      }
    };

    const outcome = await value.service.reconcile(value.task.id);

    // The round it recovers is the one that was dispatched, not a new one: the
    // provider was read, never asked to review again.
    expect(value.reviewer.calls).toHaveLength(1);
    expect(value.reviewer.roundStatusCalls).toHaveLength(1);
    expect(outcome.round.status).toBe('completed');
    expect(outcome.findings).toHaveLength(1);
    expect(value.reviews.listOccurrencesForRound(outcome.round.id)).toHaveLength(1);

    // And the task is usable again.
    await expect(value.service.review(value.task.id)).resolves.toBeTruthy();
  });

  it('leaves a round the provider says is still running exactly where it was', async () => {
    const value = await stranded();
    value.reviewer.roundStatusAnswer = { kind: 'running', contractFingerprint: FINGERPRINT };

    const outcome = await value.service.reconcile(value.task.id);

    expect(outcome.round.status).toBe('reviewing');
    expect(outcome.unsettledReason).toBe('running');
    expect(outcome.round.lastError).toMatch(/still running/i);
    expect(outcome.findings).toHaveLength(0);
    // Still blocked, and for the right reason: a second dispatch would double a
    // call that has not finished.
    await expect(value.service.review(value.task.id)).rejects.toThrow(/already been dispatched/i);
  });

  it('records a contract drift discovered while the round is still running, without settling it', async () => {
    const value = await stranded();
    const reserved = value.reviews.latestRound(value.task.id)!.contractFingerprint;
    const drifted = 'e'.repeat(64);
    value.reviewer.roundStatusAnswer = { kind: 'running', contractFingerprint: drifted };

    const outcome = await value.service.reconcile(value.task.id);

    expect(outcome.round.status).toBe('reviewing');
    expect(outcome.unsettledReason).toBe('running');
    // The reserved fingerprint survives untouched...
    expect(outcome.round.contractFingerprint).toBe(reserved);
    // ...and the drift is made explicit rather than only surfacing once the
    // round eventually completes.
    expect(outcome.round.contractMismatchAt).not.toBeNull();
  });

  it('stays blocked and says why when the provider knows nothing', async () => {
    const value = await stranded();
    value.reviewer.roundStatusAnswer = {
      kind: 'unknown',
      reason: 'the session is gone',
      contractFingerprint: null
    };

    const outcome = await value.service.reconcile(value.task.id);

    expect(outcome.round.status).toBe('reviewing');
    expect(outcome.unsettledReason).toBe('unknown');
    expect(outcome.round.lastError).toMatch(/could not say what became/i);
    // The provider's own words are NOT persisted. This field is durable and
    // operator-visible, and a reviewer's reason is foreign text.
    expect(outcome.round.lastError).not.toMatch(/session is gone/);
    // No answer is not evidence that no review ran.
    expect(outcome.round.lastError).not.toMatch(/did not run|never ran/i);
    await expect(value.service.review(value.task.id)).rejects.toThrow(/already been dispatched/i);
  });

  it('refuses a recovered result that attests a different subject', async () => {
    const value = await stranded();
    value.reviewer.roundStatusAnswer = {
      kind: 'completed',
      round: {
        ...value.reviewer.answer,
        findings: [finding()],
        reviewedSubjectSha256: 'f'.repeat(64)
      }
    };

    const outcome = await value.service.reconcile(value.task.id);

    expect(outcome.round.status).toBe('reviewing');
    expect(outcome.unsettledReason).toBe('attestation-mismatch');
    expect(value.reviews.listFindings(value.task.id)).toHaveLength(0);
  });

  it('refuses to reconcile a round that is not outstanding', async () => {
    const value = setup();
    await reviewOnce(value);
    await expect(value.service.reconcile(value.task.id)).rejects.toThrow(
      /no dispatched code-review round/i
    );
  });

  it('marks a capture incomplete when the worktree will not hold still', async () => {
    const value = setup();
    // Every fingerprint read differs from the last, which is what a worktree
    // somebody is actively editing looks like.
    let tick = 0;
    value.snapshots.fingerprints = [];
    const moving = (): { headCommit: string; branch: string; status: string; changeSet: string } => ({
      headCommit: '2'.repeat(40),
      branch: 'agent/task-1',
      status: `moving-${(tick += 1)}`,
      changeSet: ''
    });
    value.snapshots.fingerprint = async () => moving();
    const original = value.snapshots.capture.bind(value.snapshots);
    value.snapshots.capture = async (request) => ({ ...(await original(request)), fingerprint: moving() });

    const subject = await value.service.captureSubject(value.task.id);

    // The capture is stored — it says what was seen — but never as exact.
    expect(subject.complete).toBe(false);
    const identity = await value.service.subjectIdentity(value.task.id);
    expect(identity.identity).toBe('incomplete');
    expect(identity.problem).toMatch(/changed while it was being read/i);
    await expect(value.service.review(value.task.id)).rejects.toThrow(/not an exact statement/i);
  });

  it('accepts a capture the second attempt finds stable', async () => {
    const value = setup();
    // First attempt moves, second holds. A worktree that settles must not be
    // condemned for one unlucky moment.
    const settled = { headCommit: '2'.repeat(40), branch: 'agent/task-1', status: 'x', changeSet: '' };
    const answers = [
      { ...settled, status: 'a' },
      { ...settled, status: 'b' },
      settled,
      settled,
      settled,
      settled
    ];
    let index = 0;
    value.snapshots.fingerprint = async () => answers[index++] ?? settled;
    const original = value.snapshots.capture.bind(value.snapshots);
    value.snapshots.capture = async (request) => ({
      ...(await original(request)),
      fingerprint: answers[index++] ?? settled
    });

    const subject = await value.service.captureSubject(value.task.id);
    expect(subject.complete).toBe(true);
  });

  it('redacts a provider refusal instead of passing its text through', async () => {
    const value = setup();
    await value.service.captureSubject(value.task.id);
    value.reviewer.available = {
      available: false,
      reason: `codex failed: api_key = "AKIA1234567890ABCDEF" at C:\\Users\\someone\\.codex`
    };

    await expect(value.service.review(value.task.id)).rejects.toMatchObject({
      code: 'TOOL_MISSING'
    });
    try {
      await value.service.review(value.task.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A refusal is foreign text like any other: it must not carry a token out
      // through the error boundary.
      expect(message).not.toContain('AKIA1234567890ABCDEF');
    }
    expect(value.reviews.listRounds(value.task.id)).toHaveLength(0);
  });

  it('keeps a decision historical when the code moves, without locking anything', async () => {
    const value = setup();
    value.reviewer.answer = { ...value.reviewer.answer, findings: [finding()] };
    const outcome = await reviewOnce(value);
    const target = outcome.findings[0]!;
    await value.service.decide(value.task.id, {
      findingId: target.id,
      action: 'accept',
      reason: 'Legitimate.',
      expectedRevision: target.revision,
      actor: 'operator',
      source: 'test'
    });

    // The code changes afterwards. The decision is not undone and nothing was
    // locked to prevent this — it is scoped to a snapshot hash that is simply
    // no longer current, so the finding and its answer become history.
    value.snapshots.headCommit = '9'.repeat(40);
    const identity = await value.service.subjectIdentity(value.task.id);
    expect(identity.identity).toBe('stale');
    expect(value.reviews.listDecisions(target.id)).toHaveLength(1);
    expect(value.reviews.latestDecision(target.id)?.subjectSha256).toBe(target.subjectSha256);
  });
});

describe('the code-review detail a caller receives', () => {
  function detail(value: ReturnType<typeof setup>) {
    return async () => {
      const identity = await value.service.subjectIdentity(value.task.id);
      const all = value.reviews.listFindings(value.task.id);
      const live =
        identity.identity === 'current' && identity.stored !== null
          ? all.filter((f) => f.subjectSha256 === identity.stored?.subjectSha256)
          : [];
      return {
        subjectIdentity: identity.identity,
        findings: live,
        historicalFindings: all,
        identityProblem: identity.problem
      };
    };
  }

  it('presents findings as live only while the subject is provably current', async () => {
    const value = setup();
    value.reviewer.answer = { ...value.reviewer.answer, findings: [finding()] };
    await reviewOnce(value);
    const read = detail(value);

    const fresh = await read();
    expect(fresh.subjectIdentity).toBe('current');
    expect(fresh.findings).toHaveLength(1);
    expect(fresh.identityProblem).toBeNull();

    // The code moves on. The finding is still real history; it is no longer a
    // statement about the code this task has.
    value.snapshots.headCommit = '9'.repeat(40);
    const stale = await read();
    expect(stale.subjectIdentity).toBe('stale');
    expect(stale.findings).toHaveLength(0);
    expect(stale.historicalFindings).toHaveLength(1);
    expect(stale.identityProblem).toBeNull();
  });

  it('withholds live findings and explains itself when the code cannot be read', async () => {
    const value = setup();
    value.reviewer.answer = { ...value.reviewer.answer, findings: [finding()] };
    await reviewOnce(value);

    value.snapshots.error = new Error('the worktree is gone');
    const unknown = await detail(value)();

    expect(unknown.subjectIdentity).toBe('unknown');
    expect(unknown.findings).toHaveLength(0);
    expect(unknown.historicalFindings).toHaveLength(1);
    // A bare "unknown" tells an operator nothing they can act on. The reason is
    // carried, bounded and redacted.
    expect(unknown.identityProblem).toMatch(/worktree is gone/);
  });

  it('redacts and bounds the reason rather than passing it through', async () => {
    const value = setup();
    await value.service.captureSubject(value.task.id);
    value.snapshots.error = new Error(
      `capture failed: api_key = "AKIA1234567890ABCDEF" ${'x'.repeat(5_000)}`
    );

    const problem = (await value.service.subjectIdentity(value.task.id)).problem ?? '';
    expect(problem.length).toBeLessThanOrEqual(2_100);
    expect(problem).not.toContain('AKIA1234567890ABCDEF');
  });
});

describe('code-review findings across rounds', () => {
  it('gives a repeated finding the same stable id and keeps the history', async () => {
    const value = setup();
    value.reviewer.answer = { ...value.reviewer.answer, findings: [finding()] };
    const first = await reviewOnce(value);
    expect(first.newFindings).toBe(1);

    // A second round against the SAME subject, repeating the same finding. The
    // first round completed, so a new dispatch is allowed: what is refused is a
    // dispatch on top of an outcome nobody knows.
    const outcome = await value.service.review(value.task.id);
    expect(outcome.newFindings).toBe(0);
    expect(outcome.repeatedFindings).toBe(1);
    expect(outcome.findings[0]?.id).toBe(first.findings[0]?.id);
    expect(outcome.findings[0]?.timesReported).toBe(2);
    expect(value.reviews.listFindings(value.task.id)).toHaveLength(1);
  });

  it('does not collapse two different findings into one', async () => {
    const value = setup();
    value.reviewer.answer = {
      ...value.reviewer.answer,
      findings: [finding(), finding({ title: 'The retry is unbounded', line: 43 })]
    };
    const outcome = await reviewOnce(value);

    expect(outcome.newFindings).toBe(2);
    expect(new Set(outcome.findings.map((entry) => entry.id)).size).toBe(2);
  });
});

describe('code-review decisions', () => {
  async function decided() {
    const value = setup();
    value.reviewer.answer = { ...value.reviewer.answer, findings: [finding()] };
    const outcome = await reviewOnce(value);
    return { value, finding: outcome.findings[0]! };
  }

  it('records an answer with its reason, actor and the revision it was taken against', async () => {
    const { value, finding: target } = await decided();

    const result = await value.service.decide(value.task.id, {
      findingId: target.id,
      action: 'accept',
      reason: 'Legitimate; the retry really is ambiguous.',
      expectedRevision: target.revision,
      actor: 'operator',
      source: 'test'
    });

    expect(result.finding.revision).toBe(target.revision + 1);
    const trail = value.reviews.listDecisions(target.id);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      action: 'accept',
      actor: 'operator',
      source: 'test',
      subjectSha256: target.subjectSha256,
      findingRevision: target.revision
    });
    expect(trail[0]?.decidedAt).toBeTruthy();
  });

  it('requires a reason for every decision, including an acceptance', async () => {
    const { value, finding: target } = await decided();

    await expect(
      value.service.decide(value.task.id, {
        findingId: target.id,
        action: 'accept',
        reason: '   ',
        expectedRevision: target.revision,
        actor: 'operator',
        source: 'test'
      })
    ).rejects.toThrow(/requires a reason/i);
    expect(value.reviews.listDecisions(target.id)).toHaveLength(0);
  });

  it('refuses a decision taken against a revision that has moved', async () => {
    const { value, finding: target } = await decided();
    await value.service.decide(value.task.id, {
      findingId: target.id,
      action: 'accept',
      reason: 'Decided first.',
      expectedRevision: target.revision,
      actor: 'operator',
      source: 'test'
    });

    await expect(
      value.service.decide(value.task.id, {
        findingId: target.id,
        action: 'reject',
        reason: 'Decided from a screen that had gone stale.',
        expectedRevision: target.revision,
        actor: 'operator',
        source: 'test'
      })
    ).rejects.toThrow(/decided by someone else/i);

    expect(value.reviews.listDecisions(target.id)).toHaveLength(1);
    expect(value.reviews.latestDecision(target.id)?.action).toBe('accept');
  });

  it('will not apply an old snapshot\'s finding to code that has since changed', async () => {
    const { value, finding: target } = await decided();

    // The code moves on. The finding still exists and is still history, but it
    // describes a state this task is no longer in, and the operator deciding it
    // has not been shown the code that exists now.
    value.snapshots.headCommit = '9'.repeat(40);
    await expect(
      value.service.decide(value.task.id, {
        findingId: target.id,
        action: 'resolved',
        reason: 'Fixed, probably.',
        expectedRevision: target.revision,
        actor: 'operator',
        source: 'test'
      })
    ).rejects.toThrow(/no longer matches the captured subject/i);

    // Capturing the new state does not carry the old finding forward either.
    await value.service.captureSubject(value.task.id);
    await expect(
      value.service.decide(value.task.id, {
        findingId: target.id,
        action: 'resolved',
        reason: 'Fixed, probably.',
        expectedRevision: target.revision,
        actor: 'operator',
        source: 'test'
      })
    ).rejects.toThrow(/earlier snapshot/i);
    expect(value.reviews.listDecisions(target.id)).toHaveLength(0);
  });

  it('refuses a finding that belongs to another task', async () => {
    const { value, finding: target } = await decided();
    const other = value.harness.createTask(
      value.harness.createProject({ id: 'p2', localPath: 'C:\\another-repo' }).id,
      { status: 'READY_FOR_IMPLEMENTATION' }
    );

    await expect(
      value.service.decide(other.id, {
        findingId: target.id,
        action: 'accept',
        reason: 'Cross-task attempt.',
        expectedRevision: target.revision,
        actor: 'operator',
        source: 'test'
      })
    ).rejects.toThrow(/no such code review finding/i);
    expect(value.reviews.listDecisions(target.id)).toHaveLength(0);
  });

  it('refuses credential-shaped text in a reason', async () => {
    const { value, finding: target } = await decided();

    await expect(
      value.service.decide(value.task.id, {
        findingId: target.id,
        action: 'reject',
        reason: 'Not a problem; we authenticate with api_key = "AKIA1234567890ABCDEF".',
        expectedRevision: target.revision,
        actor: 'operator',
        source: 'test'
      })
    ).rejects.toThrow(/credential-shaped/i);
    expect(value.reviews.listDecisions(target.id)).toHaveLength(0);
  });
});

describe('code-review capture exactness at the level of bytes', () => {
  /**
   * Two real files in the worktree, and a seam that can move one of them at a
   * chosen instant. Both files are digested by the production reader.
   */
  function twoFiles(value: ReturnType<typeof setup>) {
    const root = value.harness.worktreesRoot;
    mkdirSync(root, { recursive: true });
    const a = join(root, 'a.ts');
    const b = join(root, 'b.ts');
    writeFileSync(a, 'const a = 1;\nconst second = 2;\n');
    writeFileSync(b, 'const b = 1;\nconst second = 2;\n');
    value.snapshots.files = [
      { path: 'a.ts', change: 'modified', absolutePath: a },
      { path: 'b.ts', change: 'modified', absolutePath: b }
    ];
    return { a, b };
  }

  it('refuses to call a capture exact when a file is rewritten while another is read', async () => {
    const value = setup();
    const { a, b } = twoFiles(value);

    // Precisely the edit the cheap Git description cannot see. A is rewritten
    // while B is being opened, to a body with the SAME number of lines - so
    // `--numstat`, `--name-status` and `status --porcelain` are byte-identical
    // before and after, and the fingerprint the capture compares is unmoved.
    // The only witness that anything happened is the content digest itself.
    let generation = 0;
    const ops: SnapshotFileOps = {
      ...nodeSnapshotFileOps,
      open: (target) => {
        if (target === b) {
          generation += 1;
          writeFileSync(a, `const a = ${generation + 100};\nconst second = 2;\n`);
        }
        return nodeSnapshotFileOps.open(target);
      }
    };
    const service = value.build({ fileOps: ops });

    const subject = await service.captureSubject(value.task.id);

    // A never held still, so no attempt could reproduce its digest.
    expect(generation).toBeGreaterThan(1);
    expect(subject.complete).toBe(false);
    const identity = await service.subjectIdentity(value.task.id);
    expect(identity.identity).toBe('incomplete');
    await expect(service.review(value.task.id)).rejects.toThrow(/not an exact statement/i);
  });

  it('accepts a capture whose every digest is reproduced by the second reading', async () => {
    const value = setup();
    twoFiles(value);
    const reads: string[] = [];
    const ops: SnapshotFileOps = {
      ...nodeSnapshotFileOps,
      open: (target) => {
        reads.push(target);
        return nodeSnapshotFileOps.open(target);
      }
    };
    const service = value.build({ fileOps: ops });

    const subject = await service.captureSubject(value.task.id);

    // Every file read twice, and the same answer both times.
    expect(reads).toHaveLength(4);
    expect(subject.complete).toBe(true);
    expect((await service.subjectIdentity(value.task.id)).identity).toBe('current');
  });

  it('refuses to call a capture exact when the file set changes between the passes', async () => {
    const value = setup();
    twoFiles(value);
    const both = value.snapshots.files;
    let pass = 0;
    const original = value.snapshots.capture.bind(value.snapshots);
    value.snapshots.capture = async (request) => {
      // Every attempt's first pass sees one file and its second sees two, so no
      // attempt can reproduce its own file set. The fingerprint is constant by
      // construction, so composition is the only thing that can notice.
      value.snapshots.files = pass % 2 === 0 ? [both[0]!] : both;
      pass += 1;
      return original(request);
    };

    const subject = await value.build().captureSubject(value.task.id);

    expect(subject.complete).toBe(false);
  });

  it('refuses to call a capture exact when a file changes what it is, not what it holds', async () => {
    const value = setup();
    const { a } = twoFiles(value);
    expect(a).toBeTruthy();

    // The bytes never move. What moves is what the file IS: an untracked file
    // that gets added to the index between the passes is the everyday case, and
    // `canonicalCodeSnapshot` writes `change` into the subject hash, so the two
    // passes describe two different subjects. A manifest holding only digests
    // cannot see that, and would call this exact.
    const both = value.snapshots.files;
    let pass = 0;
    const original = value.snapshots.capture.bind(value.snapshots);
    value.snapshots.capture = async (request) => {
      const change = pass % 2 === 0 ? 'untracked' : 'added';
      pass += 1;
      value.snapshots.files = both.map((file) => ({ ...file, change }));
      return original(request);
    };

    const subject = await value.build().captureSubject(value.task.id);

    expect(pass).toBe(6);
    expect(subject.complete).toBe(false);
    expect((await value.build().subjectIdentity(value.task.id)).identity).toBe('incomplete');
  });

  it('refuses to call a capture exact when the checkout itself changes underneath', async () => {
    const value = setup();
    twoFiles(value);
    const real = { commonDir: 'C:/repo/.git', branch: 'agent/task-1', detached: false };
    // The same branch and the same head, out of a different repository. Only
    // the checkout's own identity separates the two.
    const other = { ...real, commonDir: 'C:/other-repo/.git' };
    let looks = 0;
    value.snapshots.describeCheckout = async (path) => {
      if (path !== value.harness.worktreesRoot) return { ...real, branch: 'main' };
      looks += 1;
      // Every attempt's first pass sees the real repository and its second pass
      // sees the other one, so no attempt can reproduce the checkout it read
      // from and none of them may call itself exact.
      return looks % 2 === 0 ? other : real;
    };

    const subject = await value.build().captureSubject(value.task.id);

    // Every bounded attempt was spent, and each one looked twice.
    expect(looks).toBe(6);
    expect(subject.complete).toBe(false);
  });
});

describe('code-review round identity at the provider', () => {
  async function stranded() {
    const value = setup();
    await value.service.captureSubject(value.task.id);
    value.reviewer.error = new Error('the reviewer never answered');
    await expect(value.service.review(value.task.id)).rejects.toThrow(/never answered/);
    value.reviewer.error = null;
    return value;
  }

  it('names the round at the provider and records that name before dispatching it', async () => {
    const value = setup();
    await value.service.captureSubject(value.task.id);

    // At the moment the round is opened, the durable row already exists and
    // still has no locator: intent first, identity second, dispatch last.
    value.reviewer.onBegin = () => {
      expect(value.reviewer.calls).toHaveLength(0);
      const round = value.reviews.latestRound(value.task.id);
      expect(round).not.toBeNull();
      expect(round?.providerRoundId).toBeNull();
    };
    // And by the time anything non-idempotent goes out, the name is written
    // down. This is the whole difference between a round that can be recovered
    // and one that can only be guessed at.
    value.reviewer.onCall = () => {
      const round = value.reviews.latestRound(value.task.id);
      expect(round?.sessionId).toBe('session-1');
      expect(round?.providerRoundId).toBe('round-1');
      expect(round?.status).toBe('reviewing');
    };

    const outcome = await value.service.review(value.task.id);
    expect(value.reviewer.beginCalls).toHaveLength(1);
    expect(outcome.round.providerRoundId).toBe('round-1');
  });

  it('gives each round of one subject its own locator, and asks about that one only', async () => {
    const value = setup();
    await value.service.captureSubject(value.task.id);
    const first = await value.service.review(value.task.id);

    // A second round over the SAME subject: identical repository, branch, base,
    // head and subject hash. Everything except the locator collides.
    value.reviewer.error = new Error('the reviewer never answered');
    await expect(value.service.review(value.task.id)).rejects.toThrow(/never answered/);
    value.reviewer.error = null;

    const lost = value.reviews.latestRound(value.task.id)!;
    expect(lost.subjectSha256).toBe(first.round.subjectSha256);
    expect(lost.id).not.toBe(first.round.id);
    expect(lost.providerRoundId).not.toBe(first.round.providerRoundId);

    value.reviewer.roundStatusAnswer = { kind: 'running', contractFingerprint: FINGERPRINT };
    await value.service.reconcile(value.task.id);

    // Asked about exactly one round, and it is this one - not the earlier round
    // of the same code, which the subject alone could not have distinguished.
    expect(value.reviewer.roundStatusCalls).toHaveLength(1);
    expect(value.reviewer.roundStatusCalls[0]?.locator).toEqual({
      providerId: lost.providerId,
      sessionId: lost.sessionId,
      roundId: lost.providerRoundId
    });
    expect(value.reviewer.roundStatusCalls[0]?.locator.roundId).not.toBe(
      first.round.providerRoundId
    );
  });

  it('refuses a recovered result that belongs to another round of the same subject', async () => {
    const value = await stranded();
    const subject = value.reviews.latestSubject(value.task.id)!;
    value.reviewer.roundStatusAnswer = {
      kind: 'completed',
      round: {
        ...value.reviewer.answer,
        // Same provider, same session, same subject, correct attestation -
        // and still the wrong round. Only the locator can tell.
        locator: { providerId: 'coai', sessionId: 'session-1', roundId: 'round-99' },
        findings: [finding()],
        reviewedSubjectSha256: subject.subjectSha256
      }
    };

    const outcome = await value.service.reconcile(value.task.id);

    expect(outcome.round.status).toBe('reviewing');
    expect(outcome.unsettledReason).toBe('wrong-round');
    expect(outcome.round.lastError).toMatch(/different round/i);
    expect(value.reviews.listFindings(value.task.id)).toHaveLength(0);
    await expect(value.service.review(value.task.id)).rejects.toThrow(/already been dispatched/i);
  });

  it('refuses a live answer that carries another round locator', async () => {
    const value = setup();
    await value.service.captureSubject(value.task.id);
    value.reviewer.answerLocator = {
      providerId: 'coai',
      sessionId: 'session-1',
      roundId: 'round-77',
      contractFingerprint: FINGERPRINT
    };

    await expect(value.service.review(value.task.id)).rejects.toThrow(/different round/i);

    // The call did go out, so the round stays unresolved rather than failed.
    const round = value.reviews.latestRound(value.task.id)!;
    expect(round.status).toBe('reviewing');
    expect(value.reviews.listFindings(value.task.id)).toHaveLength(0);
  });

  it('can never settle a round that has no recorded locator', async () => {
    const value = await stranded();
    // A crash between the durable intent and the locator write leaves exactly
    // this: a row that says a call went out, and nothing to ask about.
    const round = value.reviews.latestRound(value.task.id)!;
    value.reviews.updateRound(round.id, {
      providerId: null,
      sessionId: null,
      providerRoundId: null
    });
    const subject = value.reviews.latestSubject(value.task.id)!;
    value.reviewer.roundStatusAnswer = {
      kind: 'completed',
      round: {
        ...value.reviewer.answer,
        findings: [finding()],
        reviewedSubjectSha256: subject.subjectSha256
      }
    };

    const outcome = await value.service.reconcile(value.task.id);

    // The provider was not even asked: a question that cannot name its round
    // has more than one right answer, and any of them would be written here.
    expect(value.reviewer.roundStatusCalls).toHaveLength(0);
    expect(outcome.round.status).toBe('reviewing');
    expect(outcome.unsettledReason).toBe('no-locator');
    expect(value.reviews.listFindings(value.task.id)).toHaveLength(0);
    await expect(value.service.review(value.task.id)).rejects.toThrow(/already been dispatched/i);
  });

  it('dispatches nothing when the round cannot be opened at all', async () => {
    const value = setup();
    await value.service.captureSubject(value.task.id);
    value.reviewer.beginError = new Error('the session could not be opened');

    await expect(value.service.review(value.task.id)).rejects.toThrow(/could not be opened/);

    // Above the non-idempotent call, so this is provably a refusal that
    // reviewed nothing - and it is closed rather than left outstanding.
    expect(value.reviewer.calls).toHaveLength(0);
    const round = value.reviews.latestRound(value.task.id)!;
    expect(round.status).toBe('failed');
    expect(round.providerRoundId).toBeNull();

    value.reviewer.beginError = null;
    await expect(value.service.review(value.task.id)).resolves.toBeTruthy();
  });

  it('keeps the locator when the dispatch is lost, and repeats nothing by itself', async () => {
    const value = await stranded();

    const round = value.reviews.latestRound(value.task.id)!;
    expect(round.status).toBe('reviewing');
    expect(round.sessionId).toBe('session-1');
    expect(round.providerRoundId).toBe('round-1');
    // One call went out and no second one followed on its own.
    expect(value.reviewer.calls).toHaveLength(1);
    expect(value.reviewer.beginCalls).toHaveLength(1);
    await expect(value.service.review(value.task.id)).rejects.toThrow(/already been dispatched/i);
    expect(value.reviewer.calls).toHaveLength(1);
  });

  it('releases a round only when the provider proves it never started', async () => {
    const value = await stranded();
    value.reviewer.roundStatusAnswer = { kind: 'not_started', contractFingerprint: FINGERPRINT };

    const outcome = await value.service.reconcile(value.task.id);

    // Proof that nothing was consumed, so the round may be closed. Still not an
    // automatic repeat: reconciliation reads, and a person starts the next one.
    expect(outcome.round.status).toBe('failed');
    expect(outcome.unsettledReason).toBe('not-started');
    expect(outcome.round.lastError).toMatch(/never started/i);
    expect(outcome.findings).toHaveLength(0);
    expect(value.reviewer.calls).toHaveLength(1);

    await expect(value.service.review(value.task.id)).resolves.toBeTruthy();
    expect(value.reviewer.calls).toHaveLength(2);
  });

  it('records a contract drift discovered while proving the round never started', async () => {
    const value = await stranded();
    const reserved = value.reviews.latestRound(value.task.id)!.contractFingerprint;
    const drifted = 'e'.repeat(64);
    value.reviewer.roundStatusAnswer = { kind: 'not_started', contractFingerprint: drifted };

    const outcome = await value.service.reconcile(value.task.id);

    expect(outcome.round.status).toBe('failed');
    expect(outcome.unsettledReason).toBe('not-started');
    expect(outcome.round.contractFingerprint).toBe(reserved);
    expect(outcome.round.contractMismatchAt).not.toBeNull();
  });
});

describe('code-review locator durability', () => {
  async function stranded() {
    const value = setup();
    await value.service.captureSubject(value.task.id);
    value.reviewer.error = new Error('the reviewer never answered');
    await expect(value.service.review(value.task.id)).rejects.toThrow(/never answered/);
    value.reviewer.error = null;
    return value;
  }

  it('keeps the dispatched locator exactly, whatever the answer says about identity', async () => {
    const value = setup();
    await value.service.captureSubject(value.task.id);

    // An adapter that still carries the older shape, where the round result
    // restated its own session. The answer is checked AGAINST the locator, so
    // letting it write one back would let the evidence rewrite the thing it was
    // checked against — and a provider that simply omitted the field would
    // blank half a locator on an otherwise good round.
    value.reviewer.answer = {
      ...value.reviewer.answer,
      sessionId: null,
      serverName: 'coai-mcp'
    } as typeof value.reviewer.answer;

    const outcome = await value.service.review(value.task.id);

    expect(outcome.round.status).toBe('completed');
    expect(outcome.round.providerId).toBe('coai');
    expect(outcome.round.sessionId).toBe('session-1');
    expect(outcome.round.providerRoundId).toBe('round-1');

    // Read back from storage, because that is what a later recovery would use.
    const stored = value.reviews.latestRound(value.task.id)!;
    expect(stored.providerId).toBe('coai');
    expect(stored.sessionId).toBe('session-1');
    expect(stored.providerRoundId).toBe('round-1');
  });

  it('never dispatches on a locator with an empty or missing part', async () => {
    for (const locator of [
      { providerId: 'coai', sessionId: '', roundId: 'round-1', contractFingerprint: FINGERPRINT },
      { providerId: 'coai', sessionId: 'session-1', roundId: '', contractFingerprint: FINGERPRINT },
      { providerId: '', sessionId: 'session-1', roundId: 'round-1', contractFingerprint: FINGERPRINT },
      { providerId: 'coai', sessionId: 'session-1', contractFingerprint: FINGERPRINT } as unknown as {
        providerId: string;
        sessionId: string;
        roundId: string;
        contractFingerprint: string;
      }
    ]) {
      const value = setup();
      await value.service.captureSubject(value.task.id);
      value.reviewer.locators = [locator];

      await expect(value.service.review(value.task.id)).rejects.toThrow();

      // Nothing left the process, so the round is closed rather than left
      // outstanding — and no fragment of the unusable locator was written.
      expect(value.reviewer.calls).toHaveLength(0);
      const round = value.reviews.latestRound(value.task.id)!;
      expect(round.status).toBe('failed');
      expect(round.providerId).toBeNull();
      expect(round.sessionId).toBeNull();
      expect(round.providerRoundId).toBeNull();
    }
  });

  it('refuses a locator issued under a provider identity that is not the reviewer', async () => {
    const value = setup();
    await value.service.captureSubject(value.task.id);
    value.reviewer.locators = [
      {
        providerId: 'somebody-else',
        sessionId: 'session-1',
        roundId: 'round-1',
        contractFingerprint: FINGERPRINT
      }
    ];

    await expect(value.service.review(value.task.id)).rejects.toThrow(/usable identity/i);

    expect(value.reviewer.calls).toHaveLength(0);
    expect(value.reviews.latestRound(value.task.id)?.providerId).toBeNull();
  });

  it('will not read a lost round back from a different provider than it went to', async () => {
    const value = await stranded();
    const round = value.reviews.latestRound(value.task.id)!;
    expect(round.providerId).toBe('coai');

    // A restart with changed configuration: same session and round ids, and a
    // provider that has never heard of them. Ids are unique only inside one
    // namespace, so asking is not merely useless — it can be answered.
    value.reviewer.providerId = 'a-different-reviewer';
    value.reviewer.roundStatusAnswer = {
      kind: 'completed',
      round: {
        ...value.reviewer.answer,
        locator: {
          providerId: 'a-different-reviewer',
          sessionId: 'session-1',
          roundId: 'round-1'
        },
        findings: [finding()],
        reviewedSubjectSha256: value.reviews.latestSubject(value.task.id)!.subjectSha256
      }
    };

    const outcome = await value.service.reconcile(value.task.id);

    expect(value.reviewer.roundStatusCalls).toHaveLength(0);
    expect(outcome.round.status).toBe('reviewing');
    expect(outcome.unsettledReason).toBe('other-provider');
    expect(outcome.round.lastError).toMatch(/different code reviewer/i);
    expect(value.reviews.listFindings(value.task.id)).toHaveLength(0);

    // The locator is untouched, so the round is still settleable by the
    // provider that actually ran it.
    const held = value.reviews.latestRound(value.task.id)!;
    expect(held.providerId).toBe('coai');
    expect(held.sessionId).toBe('session-1');
    expect(held.providerRoundId).toBe('round-1');
  });

  it('refuses a recovered answer whose provider half disagrees', async () => {
    const value = await stranded();
    value.reviewer.roundStatusAnswer = {
      kind: 'completed',
      round: {
        ...value.reviewer.answer,
        // Right session, right round, wrong namespace.
        locator: { providerId: 'someone-else', sessionId: 'session-1', roundId: 'round-1' },
        findings: [finding()],
        reviewedSubjectSha256: value.reviews.latestSubject(value.task.id)!.subjectSha256
      }
    };

    const outcome = await value.service.reconcile(value.task.id);

    expect(outcome.round.status).toBe('reviewing');
    expect(outcome.unsettledReason).toBe('wrong-round');
    expect(value.reviews.listFindings(value.task.id)).toHaveLength(0);
  });
});

describe('the token a reservation is made under', () => {
  it('is the durable local round id, not the subject and not a new value each time', async () => {
    const value = setup();
    await value.service.captureSubject(value.task.id);

    const first = await value.service.review(value.task.id);
    // A SECOND round over the same subject. Repository, branch, base, head and
    // subject hash are all identical — everything a subject-derived token could
    // see. Only the local round differs.
    const second = await value.service.review(value.task.id);

    expect(value.reviewer.beginTokens).toHaveLength(2);
    expect(value.reviewer.beginCalls[0]?.subjectSha256).toBe(
      value.reviewer.beginCalls[1]?.subjectSha256
    );
    expect(value.reviewer.beginTokens[0]).not.toBe(value.reviewer.beginTokens[1]);

    // And each token IS that round's durable id — the row that already exists
    // when the reservation is made, so it survives a restart unchanged.
    expect(value.reviewer.beginTokens[0]).toBe(first.round.id);
    expect(value.reviewer.beginTokens[1]).toBe(second.round.id);
  });

  it('is stable for one round: a reservation retried under it asks for the same key', async () => {
    const value = setup();
    await value.service.captureSubject(value.task.id);
    // The first attempt loses its answer on the way back, so the round is closed
    // as one that provably reserved nothing and the operator starts another.
    value.reviewer.beginError = new Error('the reservation answer was lost');
    await expect(value.service.review(value.task.id)).rejects.toThrow(/answer was lost/);
    const failed = value.reviews.latestRound(value.task.id)!;

    // Asking the same durable round for its token again yields the same string —
    // it is a stored id, not something recomputed per attempt.
    expect(value.reviewer.beginTokens).toEqual([failed.id]);
    expect(value.reviews.findRoundById(failed.id)?.id).toBe(value.reviewer.beginTokens[0]);
  });

  it('reserves before it dispatches, and a reservation alone dispatches nothing', async () => {
    const value = setup();
    await value.service.captureSubject(value.task.id);
    value.reviewer.onBegin = () => {
      // At the moment the round is named, nothing has been sent to review.
      expect(value.reviewer.calls).toHaveLength(0);
    };

    await value.service.review(value.task.id);

    expect(value.reviewer.beginTokens).toHaveLength(1);
    expect(value.reviewer.calls).toHaveLength(1);
  });
});

describe('provider-controlled text that would become durable', () => {
  /**
   * `ExternalCodeReviewer` is an INTERFACE. The Coai adapter checks its own
   * server's identity, but a second implementation — or this fake — reaches the
   * service without passing through that check at all, and the service is the
   * boundary where an answer becomes durable. So the same standard is applied
   * again here rather than assumed to have happened upstream.
   */
  const ESCAPE = String.fromCharCode(27);

  const cases: { what: string; answer: Partial<ExternalCodeReviewRound>; leak: string }[] = [
    {
      what: 'a credential-shaped server name',
      answer: { serverName: 'coai ghp_A1b2C3d4E5f6G7h8I9j0' },
      leak: 'ghp_A1b2C3d4E5f6G7h8I9j0'
    },
    {
      what: 'a credential-shaped server version',
      answer: { serverVersion: '1.0+sk-ant-A1b2C3d4E5f6G7h8' },
      leak: 'sk-ant-A1b2C3d4E5f6G7h8'
    },
    {
      what: 'an escape sequence in the server name',
      answer: { serverName: 'coai' + ESCAPE + '[31m' },
      leak: ESCAPE
    },
    {
      what: 'a credential in the reviewer summary',
      answer: { reviewers: 'answered as GH_TOKEN=ghp_A1b2C3d4E5f6G7h8I9j0' },
      leak: 'ghp_A1b2C3d4E5f6G7h8I9j0'
    },
    {
      what: 'a credential in the reviewer instruction',
      answer: { instruction: 'run with API_KEY=sk-ant-A1b2C3d4E5f6G7h8' },
      leak: 'sk-ant-A1b2C3d4E5f6G7h8'
    }
  ];

  it.each(cases)('refuses to complete a round carrying $what', async ({ answer, leak }) => {
    const value = setup();
    value.reviewer.answer = { ...value.reviewer.answer, ...answer };
    await value.service.captureSubject(value.task.id);

    await expect(value.service.review(value.task.id)).rejects.toThrow(
      /not persisted as complete/i
    );

    const round = value.reviews.latestRound(value.task.id)!;
    expect(round.status).not.toBe('completed');
    // None of the offending text reached storage — not through the round's own
    // columns, and not through the error that was recorded on it.
    expect(JSON.stringify(round)).not.toContain(leak);
    expect(value.reviews.listFindings(value.task.id)).toHaveLength(0);
  });

  it('still stores an ordinary server identity', async () => {
    const value = setup();
    const outcome = await reviewOnce(value);

    expect(outcome.round.status).toBe('completed');
    expect(outcome.round.serverName).toBe('coai-mcp');
    expect(outcome.round.serverVersion).toBe('1.2.3');
  });
});

describe('a contradictory read-back, from the transport to the durable round', () => {
  function mcpTool(name: string): ExternalMcpTool {
    return {
      name,
      title: null,
      description: null,
      inputSchema: { type: 'object' },
      annotations: { readOnly: null, destructive: null, idempotent: null, openWorld: null }
    };
  }

  const SERVER = { name: 'coai-mcp', version: '0.19.0', protocolVersion: '2024-11-05' };

  const mcpConfig: ExternalMcpServerConfig = {
    id: 'coai-code-review',
    enabled: true,
    executablePath: 'C:/tools/coai-mcp.exe',
    args: ['--stdio'],
    allowedTools: COAI_CODE_REVIEW_TOOLS,
    timeoutMs: 30_000,
    maxMessageBytes: 100_000,
    maxContentBytes: 100_000,
    maxContentBlocks: 4
  };

  /** The smallest transport that can script one answer per call, in order. */
  class ScriptedMcpClient implements ExternalMcpClient {
    readonly calls: string[] = [];
    readonly responses: ExternalMcpCallResult[] = [];

    async discover(): Promise<ExternalMcpDiscovery> {
      return {
        server: SERVER,
        tools: COAI_ADDRESSABLE_PROFILE.map(mcpTool),
        contractFingerprint: FINGERPRINT
      };
    }

    async call(
      _config: ExternalMcpServerConfig,
      name: string
    ): Promise<ExternalMcpCallResult> {
      this.calls.push(name);
      const next = this.responses.shift();
      if (!next) throw new Error('no scripted response for ' + name);

      return next;
    }
  }

  function payload(tool: string, value: unknown): ExternalMcpCallResult {
    return {
      server: SERVER,
      tool: mcpTool(tool),
      isError: false,
      content: [JSON.stringify(value)],
      contractFingerprint: FINGERPRINT
    };
  }

  /**
   * The whole chain, because the adapter's mapping is only half the property.
   * What matters durably is that the round is NOT released: `not_started` is
   * the one status that would let a fresh dispatch repeat a review the provider
   * has just claimed to have finished.
   */
  it('leaves the round dispatched, blocks the next review, and runs nothing again', async () => {
    const value = setup();
    const client = new ScriptedMcpClient();
    const service = value.build({ reviewer: new CoaiCodeReviewer(client, mcpConfig) });
    const locator = { providerId: COAI_PROVIDER_ID, sessionId: 'session-1', roundId: 'round-1' };

    const captured = await service.captureSubject(value.task.id);

    // The reservation is honest and matches the subject, so the dispatch goes
    // out; its answer is then lost, which is what strands a round at all.
    client.responses.push(
      payload('reserve_round', {
        locator,
        attestation: {
          repoIdentity: 'repo',
          baseRef: captured.baseCommit,
          baseSha: captured.baseCommit,
          headSha: captured.headCommit,
          treeSha: captured.headCommit,
          subjectHash: captured.subjectSha256
        },
        state: 'not_started',
        alreadyReserved: false,
        instruction: 'store this locator before calling run_round'
      })
    );
    client.responses.push(payload('run_round', { error: 'the connection dropped' }));

    await expect(service.review(value.task.id)).rejects.toThrow();
    expect(value.reviews.latestRound(value.task.id)?.status).toBe('reviewing');

    // Now the provider contradicts itself: nothing ran, and here is the review.
    client.responses.push(
      payload('round_status', {
        locator,
        state: 'not_started',
        instruction: 'reserved, never run',
        review: {
          locator,
          reviewedSubjectSha256: captured.subjectSha256,
          verdict: 'revise',
          gatingCount: 1,
          threshold: 0,
          reviewers: 'all 3 reviewers answered',
          findings: [],
          instruction: 'resolve every finding',
          tokensIn: 10,
          tokensOut: 5
        }
      })
    );

    const outcome = await service.reconcile(value.task.id);

    // Not released, and not settled either: the answer taught nothing.
    expect(outcome.unsettledReason).toBe('unknown');
    expect(outcome.round.status).toBe('reviewing');
    expect(value.reviews.latestRound(value.task.id)?.status).toBe('reviewing');
    expect(value.reviews.listFindings(value.task.id)).toHaveLength(0);

    // `run_round` was called exactly once — by the original dispatch, never by
    // the recovery.
    expect(client.calls.filter((name) => name === 'run_round')).toHaveLength(1);
    expect(client.calls).toEqual(['reserve_round', 'run_round', 'round_status']);

    // And the task stays blocked rather than being offered a free retry.
    await expect(service.review(value.task.id)).rejects.toThrow(/already been dispatched/i);
  });

  /**
   * The same property, driven through the REAL adapter instead of a fake port.
   *
   * `parse` puts an MCP server's refusal sentence inside the error message on
   * purpose, so this is the exact route by which provider prose used to reach
   * SQLite: the server refuses as DATA, the adapter quotes it, and the service
   * stored what the adapter quoted.
   */
  it('stores none of a refusal the real adapter quoted, at reservation', async () => {
    const value = setup();
    const client = new ScriptedMcpClient();
    const service = value.build({ reviewer: new CoaiCodeReviewer(client, mcpConfig) });

    await service.captureSubject(value.task.id);
    client.responses.push(payload('reserve_round', { error: HOSTILE }));

    // The CALLER is still told what kind of failure this was.
    await expect(service.review(value.task.id)).rejects.toMatchObject({ code: 'TOOL_FAILED' });

    const round = value.reviews.latestRound(value.task.id)!;
    expect(round.status).toBe('failed');
    for (const leak of LEAKS) expect(JSON.stringify(round), leak).not.toContain(leak);
    expect(round.lastError).toMatch(/could not open a round/i);
    // Nothing was dispatched, so there is nothing to reconcile.
    expect(client.calls).toEqual(['reserve_round']);
  });

  it('stores none of a refusal the real adapter quoted, at dispatch', async () => {
    const value = setup();
    const client = new ScriptedMcpClient();
    const service = value.build({ reviewer: new CoaiCodeReviewer(client, mcpConfig) });
    const locator = { providerId: COAI_PROVIDER_ID, sessionId: 'session-1', roundId: 'round-1' };

    const captured = await service.captureSubject(value.task.id);
    client.responses.push(
      payload('reserve_round', {
        locator,
        attestation: {
          repoIdentity: 'repo',
          baseRef: captured.baseCommit,
          baseSha: captured.baseCommit,
          headSha: captured.headCommit,
          treeSha: captured.headCommit,
          subjectHash: captured.subjectSha256
        },
        state: 'not_started',
        alreadyReserved: false,
        instruction: 'store this locator before calling run_round'
      })
    );
    client.responses.push(payload('run_round', { error: HOSTILE }));

    await expect(service.review(value.task.id)).rejects.toMatchObject({ code: 'TOOL_FAILED' });

    const round = value.reviews.latestRound(value.task.id)!;
    // Dispatched, so it stays unresolved: a reviewer may well have run.
    expect(round.status).toBe('reviewing');
    for (const leak of LEAKS) expect(JSON.stringify(round), leak).not.toContain(leak);
    expect(round.lastError).toMatch(/outcome could not be confirmed/i);

    // Exactly one run_round, and a second review is refused rather than retried.
    expect(client.calls.filter((name) => name === 'run_round')).toHaveLength(1);
    await expect(service.review(value.task.id)).rejects.toThrow(/already been dispatched/i);
    expect(client.calls.filter((name) => name === 'run_round')).toHaveLength(1);
  });

  it('says nothing of a provider state that is not a fresh reservation', async () => {
    const value = setup();
    const client = new ScriptedMcpClient();
    const service = value.build({ reviewer: new CoaiCodeReviewer(client, mcpConfig) });
    const locator = { providerId: COAI_PROVIDER_ID, sessionId: 'session-1', roundId: 'round-1' };

    const captured = await service.captureSubject(value.task.id);
    client.responses.push(
      payload('reserve_round', {
        locator,
        attestation: {
          repoIdentity: 'repo',
          baseRef: captured.baseCommit,
          baseSha: captured.baseCommit,
          headSha: captured.headCommit,
          treeSha: captured.headCommit,
          subjectHash: captured.subjectSha256
        },
        // The provider's own `state` string, and nothing constrains it.
        state: HOSTILE,
        alreadyReserved: true,
        instruction: 'resumed'
      })
    );

    await expect(service.review(value.task.id)).rejects.toMatchObject({ code: 'PARSE_FAILED' });

    const round = value.reviews.latestRound(value.task.id)!;
    expect(round.status).toBe('failed');
    for (const leak of LEAKS) expect(JSON.stringify(round), leak).not.toContain(leak);
    // Never dispatched: a reservation that is not fresh licenses nothing.
    expect(client.calls).toEqual(['reserve_round']);
  });
});

describe('a reviewer-supplied reason never reaches storage', () => {
  const ESCAPE = String.fromCharCode(27);

  /**
   * A wholly fictional path, argv and token. Every fragment is asserted absent.
   *
   * The point is the PORT, not the Coai adapter: `ExternalCodeReviewer` is an
   * interface, so a second implementation can hand the service whatever string
   * it likes as a reason. `lastError` is durable and operator-visible, so the
   * service must not write that string whatever it contains.
   */
  const HOSTILE =
    'died at C:/Users/someone/AppData/coai/coai-mcp.exe --stdio' +
    ESCAPE +
    '[31m GH_TOKEN=ghp_A1b2C3d4E5f6G7h8I9j0';

  const leaks = [
    'C:/Users/someone',
    'coai-mcp.exe',
    '--stdio',
    'AppData',
    ESCAPE,
    'ghp_A1b2C3d4E5f6G7h8I9j0'
  ];

  async function strandedRound() {
    const value = setup();
    await value.service.captureSubject(value.task.id);
    value.reviewer.error = new Error('the reviewer never answered');
    await expect(value.service.review(value.task.id)).rejects.toThrow(/never answered/);
    value.reviewer.error = null;
    expect(value.reviews.latestRound(value.task.id)?.status).toBe('reviewing');

    return value;
  }

  it('persists none of an unknown reason, whatever the reviewer put in it', async () => {
    const value = await strandedRound();
    value.reviewer.roundStatusAnswer = { kind: 'unknown', reason: HOSTILE, contractFingerprint: null };

    const outcome = await value.service.reconcile(value.task.id);

    const stored = outcome.round.lastError ?? '';
    for (const leak of leaks) expect(stored, leak).not.toContain(leak);
    // What it says instead is Agent Relay's own, and it still says the part
    // that governs behaviour.
    expect(stored).toMatch(/could not say what became/i);
    expect(stored).toMatch(/not repeated here/i);

    // Semantics unchanged: unresolved, blocked, and never described as safe.
    expect(outcome.round.status).toBe('reviewing');
    expect(outcome.unsettledReason).toBe('unknown');
    expect(stored).not.toMatch(/did not run|never ran/i);
    await expect(value.service.review(value.task.id)).rejects.toThrow(/already been dispatched/i);
  });

  it('reads the same durable row back with nothing of it either', async () => {
    const value = await strandedRound();
    value.reviewer.roundStatusAnswer = { kind: 'unknown', reason: HOSTILE, contractFingerprint: null };

    await value.service.reconcile(value.task.id);

    // Straight from the repository, not from the outcome the call returned.
    const stored = value.reviews.latestRound(value.task.id)?.lastError ?? '';
    for (const leak of leaks) expect(stored, leak).not.toContain(leak);
  });

  it('leaves running and not_started saying exactly what they said before', async () => {
    const running = await strandedRound();
    running.reviewer.roundStatusAnswer = { kind: 'running', contractFingerprint: FINGERPRINT };
    const held = await running.service.reconcile(running.task.id);
    expect(held.unsettledReason).toBe('running');
    expect(held.round.status).toBe('reviewing');
    expect(held.round.lastError).toMatch(/still running/i);

    const released = await strandedRound();
    released.reviewer.roundStatusAnswer = { kind: 'not_started', contractFingerprint: FINGERPRINT };
    const closed = await released.service.reconcile(released.task.id);
    expect(closed.unsettledReason).toBe('not-started');
    expect(closed.round.status).toBe('failed');
    expect(closed.round.lastError).toMatch(/never started/i);
    // The one state that releases a round still releases it.
    await expect(released.service.review(released.task.id)).resolves.toBeTruthy();
  });
});

describe('an external error never reaches durable storage', () => {
  /**
   * The PORT, not the Coai adapter. `ExternalCodeReviewer` is an interface, so
   * an implementation may throw whatever it likes — and both of these catches
   * used to copy `error.message` straight into a durable, operator-visible
   * column. `details` is carried too, because it is exactly as foreign as the
   * message and the transport uses it for a failed process's stderr.
   */
  function hostileError(): AgentRelayError {
    return new AgentRelayError('TOOL_FAILED', HOSTILE, { details: HOSTILE });
  }

  it('closes the round as failed when the reservation refuses, storing none of it', async () => {
    const value = setup();
    await value.service.captureSubject(value.task.id);
    value.reviewer.beginError = hostileError();

    // Classification survives to the caller, which is the boundary it is for.
    await expect(value.service.review(value.task.id)).rejects.toMatchObject({
      code: 'TOOL_FAILED',
      message: HOSTILE
    });

    const round = value.reviews.latestRound(value.task.id)!;
    // No reviewer was dispatched, so the round is provably closed.
    expect(round.status).toBe('failed');
    for (const leak of LEAKS) expect(JSON.stringify(round), leak).not.toContain(leak);
    expect(round.lastError).toMatch(/could not open a round/i);
    expect(round.lastError).toMatch(/nothing was dispatched/i);
    // run_round was never reached.
    expect(value.reviewer.calls).toHaveLength(0);
  });

  it('leaves the round unresolved when the dispatch fails, storing none of it', async () => {
    const value = setup();
    await value.service.captureSubject(value.task.id);
    value.reviewer.error = hostileError();

    await expect(value.service.review(value.task.id)).rejects.toMatchObject({
      code: 'TOOL_FAILED',
      message: HOSTILE
    });

    const round = value.reviews.latestRound(value.task.id)!;
    // The request left this process, so a reviewer may well have run.
    expect(round.status).toBe('reviewing');
    for (const leak of LEAKS) expect(JSON.stringify(round), leak).not.toContain(leak);
    expect(round.lastError).toMatch(/outcome could not be confirmed/i);
    // And it must never read as proof that nothing ran.
    expect(round.lastError).not.toMatch(/did not run|never ran/i);

    // Exactly one dispatch, and no automatic retry: a second attempt is refused
    // rather than repeated.
    expect(value.reviewer.calls).toHaveLength(1);
    value.reviewer.error = null;
    await expect(value.service.review(value.task.id)).rejects.toThrow(/already been dispatched/i);
    expect(value.reviewer.calls).toHaveLength(1);
  });

  it('keeps the two failures telling different stories', async () => {
    // Ordinary, non-hostile failures. The durable WORDING is Agent Relay's now;
    // the state each one leaves is exactly what it always was.
    const reserved = setup();
    await reserved.service.captureSubject(reserved.task.id);
    reserved.reviewer.beginError = new Error('the provider refused to reserve');
    await expect(reserved.service.review(reserved.task.id)).rejects.toThrow(/refused to reserve/);
    expect(reserved.reviews.latestRound(reserved.task.id)?.status).toBe('failed');
    expect(reserved.reviewer.calls).toHaveLength(0);

    const dispatched = setup();
    await dispatched.service.captureSubject(dispatched.task.id);
    dispatched.reviewer.error = new Error('the reviewer never answered');
    await expect(dispatched.service.review(dispatched.task.id)).rejects.toThrow(/never answered/);
    expect(dispatched.reviews.latestRound(dispatched.task.id)?.status).toBe('reviewing');
    expect(dispatched.reviewer.calls).toHaveLength(1);
  });

  it('records only owned text when the answer will not parse', async () => {
    const value = setup();
    await value.service.captureSubject(value.task.id);
    // A SCHEMA failure, whose message this application did not author — the one
    // error in that path that is not built here from a constant or a field name.
    value.reviewer.answer = { ...value.reviewer.answer, verdict: HOSTILE };

    await expect(value.service.review(value.task.id)).rejects.toBeTruthy();

    const round = value.reviews.latestRound(value.task.id)!;
    for (const leak of LEAKS) expect(JSON.stringify(round), leak).not.toContain(leak);
    expect(round.lastError).toMatch(/could not read as a review/i);
  });
});

describe('a locator this build refuses to write down', () => {
  /**
   * The SERVICE guard, not the adapter's. `ExternalCodeReviewer` is an
   * interface: this fake reaches the persistence path without passing through
   * the Coai adapter's schema at all, which is exactly the case the second
   * check exists for.
   */
  const ESC = String.fromCharCode(27);

  const hostile = [
    {
      what: 'an escape sequence in the session id',
      locator: { sessionId: 'session' + ESC + '[31m', roundId: 'round-1' },
      leak: ESC
    },
    {
      what: 'a path in the round id',
      locator: { sessionId: 'session-1', roundId: 'C:/Users/someone/coai' },
      leak: 'C:/Users/someone'
    },
    {
      what: 'a credential-shaped session id',
      locator: { sessionId: 'ghp_A1b2C3d4E5f6G7h8I9j0', roundId: 'round-1' },
      leak: 'ghp_A1b2C3d4E5f6G7h8I9j0'
    }
  ];

  it.each(hostile)('refuses $what, closing the round before any dispatch', async ({
    locator,
    leak
  }) => {
    const value = setup();
    await value.service.captureSubject(value.task.id);
    value.reviewer.locators = [
      { providerId: value.reviewer.providerId, ...locator, contractFingerprint: FINGERPRINT }
    ];

    await expect(value.service.review(value.task.id)).rejects.toMatchObject({
      code: 'PARSE_FAILED'
    });

    const round = value.reviews.latestRound(value.task.id)!;
    // Refused ABOVE the non-idempotent call, so the round is provably closed.
    expect(round.status).toBe('failed');
    // Nothing of the offending value reached the row.
    expect(JSON.stringify(round)).not.toContain(leak);
    // run_round was never called.
    expect(value.reviewer.calls).toHaveLength(0);
  });

  it('leaves an ordinary locator working exactly as before', async () => {
    const value = setup();
    value.reviewer.locators = [
      {
        providerId: value.reviewer.providerId,
        sessionId: '9f2c1e7a-3b4d-4e5f-8a9b-0c1d2e3f4a5b',
        roundId: 'round_42.retry-3',
        contractFingerprint: FINGERPRINT
      }
    ];

    const outcome = await reviewOnce(value);

    expect(outcome.round.status).toBe('completed');
    expect(outcome.round.sessionId).toBe('9f2c1e7a-3b4d-4e5f-8a9b-0c1d2e3f4a5b');
    expect(outcome.round.providerRoundId).toBe('round_42.retry-3');
  });
});

describe('a reviewer that goes away between reserving and dispatching', () => {
  /**
   * The real `SettingsBoundCodeReviewer`, because the defect lives in it: it
   * resolves configuration PER CALL, so a round can be reserved while the
   * integration is on and then find it switched off before anything is sent.
   * The old catch stored `DISPATCH_UNCONFIRMED` for that, which claims the
   * request left the process — a falsehood that also stranded the task.
   */
  function mcpTool(name: string): ExternalMcpTool {
    return {
      name,
      title: null,
      description: null,
      inputSchema: { type: 'object' },
      annotations: { readOnly: null, destructive: null, idempotent: null, openWorld: null }
    };
  }

  const SERVER = { name: 'coai-mcp', version: '0.19.0', protocolVersion: '2024-11-05' };

  function payload(tool: string, value: unknown): ExternalMcpCallResult {
    return {
      server: SERVER,
      tool: mcpTool(tool),
      isError: false,
      content: [JSON.stringify(value)],
      contractFingerprint: FINGERPRINT
    };
  }

  /** A transport that can also run a hook at the moment a call goes out. */
  class DriftingMcpClient implements ExternalMcpClient {
    readonly calls: string[] = [];
    readonly responses: ExternalMcpCallResult[] = [];
    onCall: ((name: string) => void) | null = null;

    async discover(): Promise<ExternalMcpDiscovery> {
      return {
        server: SERVER,
        tools: COAI_ADDRESSABLE_PROFILE.map(mcpTool),
        contractFingerprint: FINGERPRINT
      };
    }

    async call(_config: ExternalMcpServerConfig, name: string): Promise<ExternalMcpCallResult> {
      this.calls.push(name);
      this.onCall?.(name);
      const next = this.responses.shift();
      if (!next) throw new Error('no scripted response for ' + name);

      return next;
    }
  }

  function liveSettings(): Settings {
    return {
      ...defaultSettings({ dataDir: 'C:/user-data', documentsDir: 'C:/documents' }),
      externalCodeReviewEnabled: true,
      coaiMcpExecutablePath: 'C:/tools/coai-mcp.exe',
      coaiMcpArguments: ['--stdio']
    };
  }

  function reservation(
    captured: { baseCommit: string; headCommit: string; subjectSha256: string },
    roundId = 'round-1'
  ) {
    return {
      locator: { providerId: COAI_PROVIDER_ID, sessionId: 'session-1', roundId },
      attestation: {
        repoIdentity: 'repo',
        baseRef: captured.baseCommit,
        baseSha: captured.baseCommit,
        headSha: captured.headCommit,
        treeSha: captured.headCommit,
        subjectHash: captured.subjectSha256
      },
      state: 'not_started',
      alreadyReserved: false,
      instruction: 'store this locator before calling run_round'
    };
  }

  it('closes the round as a proven pre-dispatch failure and sends nothing', async () => {
    const value = setup();
    let enabled = true;
    const client = new DriftingMcpClient();
    const reviewer = new SettingsBoundCodeReviewer({
      settings: () => ({ ...liveSettings(), externalCodeReviewEnabled: enabled }),
      client
    });
    const service = value.build({ reviewer });

    const captured = await service.captureSubject(value.task.id);
    client.responses.push(payload('reserve_round', reservation(captured)));
    // Switched off while the reservation is in flight, which is the real race:
    // settings are resolved per call.
    client.onCall = (name) => {
      if (name === 'reserve_round') enabled = false;
    };

    const failure = await service
      .review(value.task.id)
      .then(() => null)
      .catch((reason: unknown) => reason);

    // The caller keeps the typed error, its code and its safe message.
    expect(failure).toBeInstanceOf(CodeReviewNotDispatchedError);
    expect((failure as AgentRelayError).code).toBe('TOOL_MISSING');
    expect((failure as AgentRelayError).message).toMatch(/not enabled/i);

    const round = value.reviews.latestRound(value.task.id)!;
    // Closed, because nothing was sent — not left unresolved.
    expect(round.status).toBe('failed');
    expect(round.lastError).toMatch(/nothing was dispatched/i);
    expect(round.lastError).toMatch(/closed as failed/i);
    // And it must NOT claim the request left this process.
    expect(round.lastError).not.toMatch(/could not be confirmed/i);
    // run_round was never called.
    expect(client.calls).toEqual(['reserve_round']);

    // Once the setting comes back, the operator may start a new round.
    enabled = true;
    client.onCall = null;
    // A distinct provider round: the first one was reserved and abandoned, and
    // a durable round is unique per provider locator.
    client.responses.push(payload('reserve_round', reservation(captured, 'round-2')));
    client.responses.push(
      payload('run_round', {
        locator: { providerId: COAI_PROVIDER_ID, sessionId: 'session-1', roundId: 'round-2' },
        reviewedSubjectSha256: captured.subjectSha256,
        verdict: 'revise',
        gatingCount: 1,
        threshold: 0,
        reviewers: 'all 3 reviewers answered',
        findings: [],
        instruction: 'resolve every finding',
        tokensIn: 10,
        tokensOut: 5
      })
    );

    await expect(service.review(value.task.id)).resolves.toBeTruthy();
    expect(client.calls.filter((name) => name === 'run_round')).toHaveLength(1);
  });

  it('still leaves a genuine post-dispatch failure unresolved and blocked', async () => {
    const value = setup();
    const client = new DriftingMcpClient();
    const reviewer = new SettingsBoundCodeReviewer({ settings: liveSettings, client });
    const service = value.build({ reviewer });

    const captured = await service.captureSubject(value.task.id);
    client.responses.push(payload('reserve_round', reservation(captured)));
    // The dispatch goes out and the server refuses as data: TOOL_FAILED, raised
    // from INSIDE the external call. Nothing here proves it did not run.
    client.responses.push(payload('run_round', { error: 'the connection dropped' }));

    await expect(service.review(value.task.id)).rejects.toMatchObject({ code: 'TOOL_FAILED' });

    const round = value.reviews.latestRound(value.task.id)!;
    expect(round.status).toBe('reviewing');
    expect(round.lastError).toMatch(/outcome could not be confirmed/i);
    expect(round.lastError).not.toMatch(/nothing was dispatched/i);

    // Exactly one dispatch, and no second run is permitted.
    expect(client.calls.filter((name) => name === 'run_round')).toHaveLength(1);
    await expect(service.review(value.task.id)).rejects.toThrow(/already been dispatched/i);
    expect(client.calls.filter((name) => name === 'run_round')).toHaveLength(1);
  });
});

describe('Coai contract fingerprint evidence', () => {
  it('persists the contract fingerprint bound at reservation through to the completed round', async () => {
    const value = setup();
    const outcome = await reviewOnce(value);

    expect(outcome.round.contractFingerprint).toBe(FINGERPRINT);
    expect(outcome.round.contractMismatchAt).toBeNull();

    // Durable, not merely returned: read back from storage independently.
    const stored = value.reviews.latestRound(value.task.id);
    expect(stored?.contractFingerprint).toBe(FINGERPRINT);
    expect(stored?.contractMismatchAt).toBeNull();
  });

  it('stops safely, without applying the answer, when the contract drifts between reserving and running the round', async () => {
    const value = setup();
    await value.service.captureSubject(value.task.id);
    value.reviewer.answer = { ...value.reviewer.answer, contractFingerprint: 'e'.repeat(64) };

    await expect(value.service.review(value.task.id)).rejects.toThrow(/tool contract changed/i);

    // Left exactly where the dispatch got to — `reviewing`, not `completed` —
    // and the ORIGINAL fingerprint reservation bound, never silently replaced
    // by the answer's differing one.
    const round = value.reviews.latestRound(value.task.id)!;
    expect(round.status).toBe('reviewing');
    expect(round.contractFingerprint).toBe(FINGERPRINT);
    expect(round.contractMismatchAt).not.toBeNull();
    expect(value.reviews.listFindings(value.task.id)).toHaveLength(0);
  });

  it('reconciliation reports a contract mismatch without applying the stale answer, preserving the reserved fingerprint', async () => {
    const value = setup();
    await value.service.captureSubject(value.task.id);
    value.reviewer.error = new Error('the reviewer never answered');
    await expect(value.service.review(value.task.id)).rejects.toThrow(/never answered/);
    value.reviewer.error = null;

    const subject = value.reviews.latestSubject(value.task.id)!;
    const drifted = 'e'.repeat(64);
    value.reviewer.roundStatusAnswer = {
      kind: 'completed',
      round: {
        ...value.reviewer.answer,
        findings: [finding()],
        reviewedSubjectSha256: subject.subjectSha256,
        contractFingerprint: drifted
      }
    };

    const outcome = await value.service.reconcile(value.task.id);

    expect(outcome.unsettledReason).toBe('contract-drifted');
    expect(outcome.round.status).toBe('reviewing');
    // The historical evidence survives untouched...
    expect(outcome.round.contractFingerprint).toBe(FINGERPRINT);
    // ...and the mismatch is made explicit rather than silently absorbed.
    expect(outcome.round.contractMismatchAt).not.toBeNull();
    expect(outcome.findings).toHaveLength(0);
    expect(value.reviews.listFindings(value.task.id)).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Codex-assisted automatic finding triage                                    */
/* -------------------------------------------------------------------------- */

describe('code-review automatic finding triage', () => {
  async function withTwoLiveFindings() {
    const value = setup();
    const codex = new FakeCodexAdapter();
    const triageService = value.build({ codex, settings: value.harness.settings });
    value.reviewer.answer = {
      ...value.reviewer.answer,
      findings: [finding({ title: 'First finding' }), finding({ title: 'Second finding' })]
    };
    const outcome = await reviewOnce(value);
    return { value, codex, triageService, findings: outcome.findings };
  }

  it('sends every currently undecided, live finding when none are named, and never decides anything', async () => {
    const { value, codex, triageService, findings } = await withTwoLiveFindings();
    const recommendations = await triageService.triage(value.task.id);

    expect(codex.triageCalls).toHaveLength(1);
    expect(codex.triageCalls[0]?.findings.map((f) => f.ref).sort()).toEqual(
      findings.map((f) => f.id).sort()
    );
    expect(recommendations).toHaveLength(2);
    // Nothing was decided: every finding is still undecided afterward.
    for (const f of findings) {
      expect(value.reviews.latestDecision(f.id)).toBeNull();
    }
  });

  it('triages by stable string ids: declares the id kind and accepts a complete string-ref answer', async () => {
    const { value, codex, triageService, findings } = await withTwoLiveFindings();
    const recommendations = await triageService.triage(value.task.id);

    expect(codex.triageCalls[0]?.refKind).toBe('id');
    expect(codex.triageCalls[0]?.findings.every((f) => typeof f.ref === 'string')).toBe(true);
    expect(recommendations.map((r) => r.findingRef).sort()).toEqual(findings.map((f) => f.id).sort());
    expect(parseCodeReviewTriage(value.reviews.getTriage(value.task.id)!.triageJson)?.recommendations).toHaveLength(2);
  });

  it('rejects numeric references, which are not finding ids, and persists nothing', async () => {
    const { value, codex, triageService } = await withTwoLiveFindings();
    codex.triageQueue.push([
      { findingRef: 0, recommendation: 'accept', reason: 'r', evidenceRef: 'e', confidence: 'high' },
      { findingRef: 1, recommendation: 'accept', reason: 'r', evidenceRef: 'e', confidence: 'high' }
    ]);

    await expect(triageService.triage(value.task.id)).rejects.toThrow(/not requested/i);
    expect(value.reviews.getTriage(value.task.id)).toBeNull();
  });

  it('analyzes only the requested subset when findingIds is given', async () => {
    const { value, codex, triageService, findings } = await withTwoLiveFindings();
    await triageService.triage(value.task.id, { findingIds: [findings[0]!.id] });

    expect(codex.triageCalls[0]?.findings).toHaveLength(1);
    expect(codex.triageCalls[0]?.findings[0]?.ref).toBe(findings[0]!.id);
  });

  it('preserves a still-current recommendation for a finding a narrower re-analysis did not cover', async () => {
    const { value, codex, triageService, findings } = await withTwoLiveFindings();

    // A broad analysis covers both findings first.
    codex.triageQueue.push([
      { findingRef: findings[0]!.id, recommendation: 'accept', reason: 'r0', evidenceRef: 'e', confidence: 'high' },
      { findingRef: findings[1]!.id, recommendation: 'reject', reason: 'r1', evidenceRef: 'e', confidence: 'high' }
    ]);
    await triageService.triage(value.task.id);
    expect(value.reviews.getTriage(value.task.id)?.triageJson).toMatch(findings[1]!.id);

    // A narrower re-analysis targets ONLY finding 0 — finding 1 is untouched
    // and still undecided at the same revision.
    codex.triageQueue.push([
      { findingRef: findings[0]!.id, recommendation: 'reject', reason: 'revised r0', evidenceRef: 'e', confidence: 'high' }
    ]);
    await triageService.triage(value.task.id, { findingIds: [findings[0]!.id] });

    const stored = value.reviews.getTriage(value.task.id)!;
    const parsed = parseCodeReviewTriage(stored.triageJson);
    // Finding 0's recommendation is the FRESH one from the narrower call...
    expect(parsed?.recommendations.find((r) => r.findingId === findings[0]!.id)?.reason).toBe('revised r0');
    // ...and finding 1's, from the EARLIER broader call, survived being left
    // out of this call's own targets rather than being silently dropped.
    expect(parsed?.recommendations.find((r) => r.findingId === findings[1]!.id)?.reason).toBe('r1');
  });

  it('refuses a finding that already has a decision recorded', async () => {
    const { value, triageService, findings } = await withTwoLiveFindings();
    await value.service.decide(value.task.id, {
      findingId: findings[0]!.id,
      action: 'accept',
      reason: 'Already handled manually.',
      expectedRevision: findings[0]!.revision,
      actor: 'operator',
      source: 'test'
    });

    await expect(
      triageService.triage(value.task.id, { findingIds: [findings[0]!.id] })
    ).rejects.toThrow(/already has a decision/i);
  });

  it('refuses a finding id that does not belong to the current live subject', async () => {
    const { value, triageService } = await withTwoLiveFindings();
    await expect(
      triageService.triage(value.task.id, { findingIds: ['not-a-real-finding'] })
    ).rejects.toThrow(/not a live finding/i);
  });

  it('discards the analysis when a finding is decided while Codex is in flight', async () => {
    const { value, codex, triageService, findings } = await withTwoLiveFindings();
    let resolveGate: (value?: unknown) => void = () => undefined;
    codex.triageGate = new Promise((resolve) => { resolveGate = resolve; });

    const triaging = triageService.triage(value.task.id);
    await Promise.resolve();

    // Decided by another window/process while the analysis is running.
    await value.service.decide(value.task.id, {
      findingId: findings[0]!.id,
      action: 'accept',
      reason: 'Decided elsewhere while analysis ran.',
      expectedRevision: findings[0]!.revision,
      actor: 'operator',
      source: 'test'
    });

    resolveGate();
    await expect(triaging).rejects.toThrow(/decided while the analysis was running/i);
  });

  it('fails closed on a partial response missing a requested finding', async () => {
    const { value, codex, triageService, findings } = await withTwoLiveFindings();
    codex.triageQueue.push([
      { findingRef: findings[0]!.id, recommendation: 'accept', reason: 'r', evidenceRef: 'e', confidence: 'high' }
      // findings[1] missing.
    ]);

    await expect(triageService.triage(value.task.id)).rejects.toThrow(/every requested finding/i);
  });

  it('fails closed on a recommendation for a finding that was not requested', async () => {
    const { value, codex, triageService, findings } = await withTwoLiveFindings();
    codex.triageQueue.push([
      { findingRef: findings[0]!.id, recommendation: 'accept', reason: 'r', evidenceRef: 'e', confidence: 'high' },
      { findingRef: 'some-other-id', recommendation: 'accept', reason: 'r', evidenceRef: 'e', confidence: 'high' }
    ]);

    await expect(
      triageService.triage(value.task.id, { findingIds: [findings[0]!.id] })
    ).rejects.toThrow(/not requested/i);
  });

  it('never calls resolve/decide, approves nothing, and starts no correction', async () => {
    const { value, codex, triageService, findings } = await withTwoLiveFindings();
    codex.triageQueue.push([
      { findingRef: findings[0]!.id, recommendation: 'accept', reason: 'r', evidenceRef: 'e', confidence: 'high' },
      { findingRef: findings[1]!.id, recommendation: 'reject', reason: 'r', evidenceRef: 'e', confidence: 'high' }
    ]);

    await triageService.triage(value.task.id);

    expect(value.reviews.listDecisions(findings[0]!.id)).toHaveLength(0);
    expect(value.reviews.listDecisions(findings[1]!.id)).toHaveLength(0);
    const task = value.harness.tasks.findById(value.task.id)!;
    expect(task.status).toBe('READY_FOR_IMPLEMENTATION');
  });

  it('releases the exclusivity claim when Codex itself fails, so a retry is never blocked by a stale claim', async () => {
    const { value, codex, triageService } = await withTwoLiveFindings();
    codex.triageError = new Error('Codex timed out.');

    await expect(triageService.triage(value.task.id)).rejects.toThrow(/timed out/i);

    // The claim is released in a `finally`, unconditionally — a failed
    // attempt (a Codex timeout, in this case) must not leave the task
    // exclusivity claim held, which would otherwise make every later
    // review/reconcile/triage call for this task fail with BUSY forever.
    // No queued response is pushed: the fake defaults to one recommendation
    // per requested finding, satisfying full coverage on its own.
    codex.triageError = null;
    await expect(triageService.triage(value.task.id)).resolves.toBeDefined();
  });

  it('refuses when Codex is not configured for this build', async () => {
    const { value } = await withTwoLiveFindings();
    await expect(value.service.triage(value.task.id)).rejects.toMatchObject({ code: 'TOOL_MISSING' });
  });

  it('refuses to run a second triage while one is already in flight for the task', async () => {
    const { value, codex, triageService } = await withTwoLiveFindings();
    let resolveGate: (value?: unknown) => void = () => undefined;
    codex.triageGate = new Promise((resolve) => { resolveGate = resolve; });
    const first = triageService.triage(value.task.id);
    await Promise.resolve();

    await expect(triageService.triage(value.task.id)).rejects.toMatchObject({ code: 'BUSY' });

    resolveGate();
    await first;
  });

  it('persists a durable triage record bound to the exact subject and the exact findings analyzed, readable from an independent repository instance', async () => {
    const { value, triageService, findings } = await withTwoLiveFindings();
    const recommendations = await triageService.triage(value.task.id);

    const stored = value.reviews.getTriage(value.task.id);
    expect(stored).not.toBeNull();
    const identity = await value.service.subjectIdentity(value.task.id);
    expect(stored!.subjectSha256).toBe(identity.currentSha256);
    expect(stored!.subjectId).toBe(identity.stored!.id);

    const parsed = parseCodeReviewTriage(stored!.triageJson);
    expect(parsed?.recommendations.map((r) => r.findingId).sort()).toEqual(
      findings.map((f) => f.id).sort()
    );
    expect(recommendations).toHaveLength(2);

    // A second, independent repository instance against the SAME underlying
    // database sees the identical row — this is a durable write, not state
    // held only by the service instance (or the in-memory triage() call)
    // that made it, which is what "survives an application restart" reduces
    // to at this layer: `tests/db/code-review-repository.test.ts` proves the
    // same row also survives closing and reopening the database FILE.
    const independentReviews = new SqliteCodeReviewRepository(value.harness.db, value.harness.clock);
    expect(independentReviews.getTriage(value.task.id)).toEqual(stored);

    // The positive case `codeReviewCurrentTriageRecommendations` exists to
    // recognize: freshly written, against the live subject and its live
    // findings, both recommendations are still current.
    expect(codeReviewCurrentTriageRecommendations(stored, identity.currentSha256, findings)).toHaveLength(2);
  });

  it('never shows a stored recommendation for a `needs_user` finding as something to apply', async () => {
    const { value, codex, triageService, findings } = await withTwoLiveFindings();
    codex.triageQueue.push([
      { findingRef: findings[0]!.id, recommendation: 'accept', reason: 'r', evidenceRef: 'e', confidence: 'high' },
      { findingRef: findings[1]!.id, recommendation: 'needs_user', reason: 'Ambiguous.', evidenceRef: 'e', confidence: 'low' }
    ]);
    const recommendations = await triageService.triage(value.task.id);

    const needsUser = recommendations.find((r) => r.findingRef === findings[1]!.id);
    expect(needsUser?.recommendation).toBe('needs_user');
    // The service itself never decides anything regardless of recommendation
    // — this is the renderer's contract (a `needs_user` recommendation is
    // never offered an "apply" affordance), proved here at the boundary the
    // renderer actually reads: the persisted, parsed recommendation itself.
    expect(value.reviews.latestDecision(findings[1]!.id)).toBeNull();
  });

  it('rejects a stored triage result once the subject changes, without deleting the durable row', async () => {
    const { value, triageService, findings } = await withTwoLiveFindings();
    await triageService.triage(value.task.id);
    const stored = value.reviews.getTriage(value.task.id)!;

    // A genuinely new capture: real file content changes on disk, which
    // changes the canonical snapshot and therefore the subject hash.
    const root = value.harness.worktreesRoot;
    mkdirSync(root, { recursive: true });
    const changed = join(root, 'changed.ts');
    writeFileSync(changed, 'const changed = 1;\n');
    value.snapshots.files = [
      { path: 'changed.ts', change: 'added', absolutePath: changed }
    ];
    const newSubject = await value.service.captureSubject(value.task.id);
    expect(newSubject.subjectSha256).not.toBe(stored.subjectSha256);

    // Nothing purges the old row on a later capture — it is one durable slot
    // per task, wholesale-replaced only by the NEXT triage run, not by a
    // capture.
    expect(value.reviews.getTriage(value.task.id)).toEqual(stored);
    // But it must never be shown as speaking for the new subject — a
    // subject mismatch is still an all-or-nothing gate.
    expect(codeReviewCurrentTriageRecommendations(stored, newSubject.subjectSha256, findings)).toEqual([]);
  });

  it('drops only the decided finding\'s own recommendation, keeping its sibling\'s recommendation current', async () => {
    const { value, triageService, findings } = await withTwoLiveFindings();
    await triageService.triage(value.task.id);
    const stored = value.reviews.getTriage(value.task.id)!;
    const identity = await value.service.subjectIdentity(value.task.id);

    await value.service.decide(value.task.id, {
      findingId: findings[0]!.id,
      action: 'accept',
      reason: 'Handled manually before the recommendation was applied.',
      expectedRevision: findings[0]!.revision,
      actor: 'operator',
      source: 'test'
    });

    const liveNow = value.reviews
      .listFindings(value.task.id)
      .filter((f) => f.subjectSha256 === identity.stored!.subjectSha256);
    // The subject itself never moved. Deciding finding 0 must drop ONLY its
    // own recommendation — finding 1's is untouched by anything that
    // happened to a sibling in the same analysis, and stays current.
    expect(identity.currentSha256).toBe(stored.subjectSha256);
    const current = codeReviewCurrentTriageRecommendations(stored, identity.currentSha256, liveNow);
    expect(current.map((r) => r.findingId)).toEqual([findings[1]!.id]);
  });
});
