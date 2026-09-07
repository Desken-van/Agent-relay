/**
 * The lifecycle: durable intent, stale results, and decisions that stay put.
 *
 * The reviewer and the Git snapshot are fakes, deliberately: what is under test
 * is what Agent Relay writes and refuses, and a real provider would make the
 * ordering non-deterministic without proving anything extra. The snapshot's own
 * fidelity is proved separately, against a real repository.
 */

import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteCodeReviewRepository } from '../../src/main/db/repositories/code-review-repository';
import {
  CodeReviewClaims,
  CodeReviewService,
  type CodeReviewRoundOutcome
} from '../../src/main/services/code-review';
import { UnconfiguredCodeReviewer } from '../../src/main/services/code-review-provider';
import type {
  CodeReviewerAvailability,
  CodeSnapshotRequest,
  CodeSnapshotSource,
  ExternalCodeReviewer,
  ExternalCodeReviewRound,
  ExternalCodeReviewSubject,
  RawCheckoutIdentity,
  RawCodeSnapshot,
  RawCodeSnapshotFile
} from '../../src/main/ports';
import type { ProviderCodeFinding } from '../../src/shared/domain/code-review';
import { createHarness, type Harness } from '../helpers/harness';

const BASE = '1'.repeat(40);

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

  async capture(request: CodeSnapshotRequest): Promise<RawCodeSnapshot> {
    this.calls.push(request);
    if (this.error) throw this.error;
    return {
      baseCommit: BASE,
      headCommit: this.headCommit,
      branch: 'agent/task-1',
      files: this.files,
      truncated: this.truncated,
      hasUncommittedState: this.hasUncommittedState
    };
  }
}

class FakeCodeReviewer implements ExternalCodeReviewer {
  readsUncommittedWorktreeState = true;
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
  readonly calls: { subject: ExternalCodeReviewSubject; scopeText: string }[] = [];
  /** Runs at the moment the call is dispatched, before it answers. */
  onCall: (() => void) | null = null;
  error: Error | null = null;
  answer: ExternalCodeReviewRound = {
    reviewedSubjectSha256: null,
    verdict: 'revise',
    gatingCount: 1,
    threshold: 0,
    reviewers: 'all 3 reviewers answered',
    findings: [],
    instruction: 'resolve every finding',
    sessionId: 'session-1',
    serverName: 'coai-mcp',
    serverVersion: '1.2.3',
    tokensIn: 100,
    tokensOut: 20
  };

  async availability(): Promise<CodeReviewerAvailability> {
    this.availabilityCalls.push(this.calls.length);
    return this.available;
  }

  async reviewCode(
    subject: ExternalCodeReviewSubject,
    scopeText: string
  ): Promise<ExternalCodeReviewRound> {
    this.calls.push({ subject, scopeText });
    this.onCall?.();
    if (this.error) throw this.error;
    return {
      ...this.answer,
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
  const build = (): CodeReviewService =>
    new CodeReviewService({
      tasks: harness.tasks,
      projects: harness.projects,
      reviews,
      snapshots,
      reviewer,
      claims,
      clock: harness.clock,
      ids: harness.ids
    });

  const project = harness.createProject();
  const task = harness.createTask(project.id, {
    status: 'READY_FOR_IMPLEMENTATION',
    worktreePath: harness.worktreesRoot,
    branchName: 'agent/task-1',
    baseBranch: 'main'
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
  it('captures without staging, committing or otherwise touching the worktree', async () => {
    const value = setup();
    await value.service.captureSubject(value.task.id);

    // The only Git contact is the read-only snapshot source; nothing in this
    // service can reach a mutating command. The fake Git adapter the harness
    // installs records every worktree it was asked to create or commit to.
    expect(value.snapshots.calls).toHaveLength(1);
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
    expect(round?.lastError).toMatch(/never answered/);

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
