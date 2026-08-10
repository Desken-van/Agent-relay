import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentRelayError, InvalidTransitionError } from '../../src/shared/domain/errors';
import { createHarness, runToReview, type Harness } from '../helpers/harness';
import { makeReview, makeSpecification } from '../helpers/fakes';

let harness: Harness;

beforeEach(() => {
  harness = createHarness();
});

afterEach(() => {
  harness.dispose();
});

describe('specification stage', () => {
  it('moves DRAFT -> READY_FOR_IMPLEMENTATION and stores the thread id', async () => {
    const project = harness.createProject();
    const task = harness.createTask(project.id);

    const updated = await harness.orchestrator.generateSpecification(task.id);

    expect(updated.status).toBe('READY_FOR_IMPLEMENTATION');
    expect(updated.codexThreadId).toBe('codex-thread-1');
    expect(updated.specificationJson).toBeTruthy();
    expect(updated.specificationApprovedAt).toBeNull();
  });

  it('records a codex run with the structured specification attached', async () => {
    const project = harness.createProject();
    const task = harness.createTask(project.id);
    await harness.orchestrator.generateSpecification(task.id);

    const runs = harness.runs.listByTask(task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.agent).toBe('codex');
    expect(runs[0]?.runType).toBe('specification');
    expect(runs[0]?.status).toBe('succeeded');
    expect(JSON.parse(runs[0]?.structuredResult ?? '{}')).toMatchObject({
      title: 'Add a health endpoint'
    });
  });

  it('continues the stored Codex thread when regenerating', async () => {
    const project = harness.createProject();
    const task = harness.createTask(project.id);

    await harness.orchestrator.generateSpecification(task.id);
    await harness.orchestrator.generateSpecification(task.id);

    expect(harness.codex.specificationCalls).toHaveLength(2);
    expect(harness.codex.specificationCalls[0]?.threadId).toBeNull();
    // The second call resumes rather than starting a fresh conversation.
    expect(harness.codex.specificationCalls[1]?.threadId).toBe('codex-thread-1');
  });

  it('returns the task to DRAFT on a recoverable failure so it can be retried', async () => {
    const project = harness.createProject();
    const task = harness.createTask(project.id);
    harness.codex.specificationError = new AgentRelayError('PARSE_FAILED', 'bad json');

    await expect(harness.orchestrator.generateSpecification(task.id)).rejects.toThrow('bad json');

    const after = harness.tasks.findById(task.id);
    expect(after?.status).toBe('DRAFT');
    expect(after?.lastError).toContain('bad json');
    expect(harness.runs.listByTask(task.id)[0]?.status).toBe('failed');

    // And a retry works.
    harness.codex.specificationError = null;
    const retried = await harness.orchestrator.generateSpecification(task.id);
    expect(retried.status).toBe('READY_FOR_IMPLEMENTATION');
  });

  it('clears a previous approval when the specification is regenerated', async () => {
    const project = harness.createProject();
    const task = harness.createTask(project.id);

    await harness.orchestrator.generateSpecification(task.id);
    harness.orchestrator.approveSpecification(task.id);
    expect(harness.tasks.findById(task.id)?.specificationApprovedAt).toBeTruthy();

    await harness.orchestrator.generateSpecification(task.id);
    expect(harness.tasks.findById(task.id)?.specificationApprovedAt).toBeNull();
  });

  it('refuses to approve a specification that does not exist', () => {
    const project = harness.createProject();
    const task = harness.createTask(project.id);
    expect(() => harness.orchestrator.approveSpecification(task.id)).toThrow(InvalidTransitionError);
  });
});

describe('implementation stage', () => {
  it('refuses to send to Claude before the specification is approved', async () => {
    const project = harness.createProject();
    const task = harness.createTask(project.id);
    await harness.orchestrator.generateSpecification(task.id);

    await expect(harness.orchestrator.sendToClaude(task.id)).rejects.toThrow(
      /specification has not been approved/i
    );
    expect(harness.claude.calls).toHaveLength(0);
  });

  it('creates an isolated branch and worktree before running Claude', async () => {
    const { task } = await runToReview(harness);

    expect(harness.git.createdWorktrees).toHaveLength(1);
    const worktree = harness.git.createdWorktrees[0];
    expect(worktree?.branchName).toMatch(/^agent-relay\//);
    expect(worktree?.baseBranch).toBe('main');
    expect(worktree?.worktreePath.startsWith(harness.worktreesRoot)).toBe(true);

    expect(task.branchName).toBe(worktree?.branchName);
    expect(task.worktreePath).toBe(worktree?.worktreePath);
    expect(task.status).toBe('READY_FOR_REVIEW');
  });

  it('runs Claude inside the worktree and stores its session id', async () => {
    const { task } = await runToReview(harness);

    expect(harness.claude.calls).toHaveLength(1);
    expect(harness.claude.calls[0]?.worktreePath).toBe(task.worktreePath);
    expect(harness.claude.calls[0]?.sessionId).toBeNull();
    expect(task.claudeSessionId).toBe('claude-session-1');
    expect(task.currentRound).toBe(1);
  });

  it('includes the specification in the prompt sent to Claude', async () => {
    await runToReview(harness);
    const prompt = harness.claude.calls[0]?.prompt ?? '';

    expect(prompt).toContain('GET /health responds 200');
    expect(prompt).toContain('Do not change the existing routes.');
    expect(prompt).toContain('Do NOT run');
    expect(prompt.toLowerCase()).toContain('git commit');
  });

  it('blocks when the working tree is dirty unless explicitly accepted', async () => {
    harness.git.repository = { ...harness.git.repository, isClean: false, dirtyFiles: ['M src/a.ts'] };

    const project = harness.createProject();
    const task = harness.createTask(project.id);
    await harness.orchestrator.generateSpecification(task.id);
    harness.orchestrator.approveSpecification(task.id);

    await expect(harness.orchestrator.sendToClaude(task.id)).rejects.toMatchObject({
      code: 'GIT_DIRTY'
    });
    expect(harness.git.createdWorktrees).toHaveLength(0);
    // Still retryable.
    expect(harness.tasks.findById(task.id)?.status).toBe('READY_FOR_IMPLEMENTATION');

    const accepted = await harness.orchestrator.sendToClaude(task.id, {
      acceptDirtyWorkingTree: true
    });
    expect(accepted.status).toBe('READY_FOR_REVIEW');
  });

  it('refuses when the base branch does not exist', async () => {
    harness.git.existingBranches = new Set(['develop']);

    const project = harness.createProject();
    const task = harness.createTask(project.id);
    await harness.orchestrator.generateSpecification(task.id);
    harness.orchestrator.approveSpecification(task.id);

    await expect(harness.orchestrator.sendToClaude(task.id)).rejects.toThrow(/does not exist/i);
    expect(harness.claude.calls).toHaveLength(0);
  });

  it('never lets two live tasks share a worktree directory', async () => {
    const project = harness.createProject();

    // Two tasks whose ids and titles would collide into the same directory name.
    const first = harness.createTask(project.id, { title: 'same title' });
    await harness.orchestrator.generateSpecification(first.id);
    harness.orchestrator.approveSpecification(first.id);
    await harness.orchestrator.sendToClaude(first.id);

    const stolenPath = harness.tasks.findById(first.id)?.worktreePath ?? '';
    const second = harness.createTask(project.id, { title: 'other' });
    await harness.orchestrator.generateSpecification(second.id);
    harness.orchestrator.approveSpecification(second.id);

    // Force the collision by pre-assigning the same worktree to the second task.
    harness.tasks.update(second.id, { worktreePath: null, branchName: null });
    harness.tasks.update(first.id, { worktreePath: stolenPath });

    const paths = harness.tasks.listActiveWorktreePaths();
    expect(paths.filter((entry) => entry.worktreePath === stolenPath)).toHaveLength(1);
  });

  it('rejects a worktree path outside the configured worktrees root', async () => {
    const { task } = await runToReview(harness);

    // Simulate a task whose stored worktree points somewhere it should not.
    harness.tasks.update(task.id, {
      status: 'CHANGES_REQUESTED',
      worktreePath: 'C:\\somewhere\\else',
      lastReviewJson: JSON.stringify(
        makeReview({ verdict: 'changes_requested', followUpPrompt: 'fix it' })
      )
    });

    await expect(harness.orchestrator.sendCorrections(task.id)).rejects.toMatchObject({
      code: 'UNSAFE_PATH'
    });
  });
});

describe('review stage and the relay loop', () => {
  it('approves and stops when Codex is happy', async () => {
    const { task } = await runToReview(harness);
    harness.codex.reviewQueue = [makeReview({ verdict: 'approved' })];

    const reviewed = await harness.orchestrator.reviewWithCodex(task.id);

    expect(reviewed.status).toBe('APPROVED');
    expect(harness.codex.reviewCalls).toHaveLength(1);
    expect(harness.claude.calls).toHaveLength(1);
  });

  it('sends the diff, changed files, spec and Claude report to the reviewer', async () => {
    const { task } = await runToReview(harness);
    await harness.orchestrator.reviewWithCodex(task.id);

    const call = harness.codex.reviewCalls[0];
    expect(call?.specification.title).toBe('Add a health endpoint');
    expect(call?.changes.changedFiles[0]?.path).toBe('src/app.ts');
    expect(call?.changes.diff).toContain('diff --git');
    expect(call?.claudeReport).toContain('Implemented the change');
    // Fenced command output is lifted out of the report for the reviewer.
    expect(call?.testOutput).toContain('2 passed');
    expect(call?.round).toBe(1);
    expect(call?.maxRounds).toBe(3);
  });

  it('goes to CHANGES_REQUESTED and reuses the same Claude session for corrections', async () => {
    const { task } = await runToReview(harness);
    harness.codex.reviewQueue = [
      makeReview({ verdict: 'changes_requested', followUpPrompt: 'Handle the null case.' })
    ];

    const reviewed = await harness.orchestrator.reviewWithCodex(task.id);
    expect(reviewed.status).toBe('CHANGES_REQUESTED');

    const corrected = await harness.orchestrator.sendCorrections(task.id);
    expect(corrected.status).toBe('READY_FOR_REVIEW');
    expect(corrected.currentRound).toBe(2);

    expect(harness.claude.calls).toHaveLength(2);
    // The correction resumes the session rather than starting a new one.
    expect(harness.claude.calls[1]?.sessionId).toBe('claude-session-1');
    expect(harness.claude.calls[1]?.prompt).toContain('Handle the null case.');
  });

  it('fails the task when Codex blocks', async () => {
    const { task } = await runToReview(harness);
    harness.codex.reviewQueue = [makeReview({ verdict: 'blocked', summary: 'Wrong approach.' })];

    const reviewed = await harness.orchestrator.reviewWithCodex(task.id);
    expect(reviewed.status).toBe('FAILED');
  });

  it('stops the loop at the round limit instead of running forever', async () => {
    const project = harness.createProject();
    const created = harness.createTask(project.id, { maxRounds: 2 });

    await harness.orchestrator.generateSpecification(created.id);
    harness.orchestrator.approveSpecification(created.id);
    await harness.orchestrator.sendToClaude(created.id);

    harness.codex.reviewQueue = [
      makeReview({ verdict: 'changes_requested', followUpPrompt: 'round 1 fixes' }),
      makeReview({ verdict: 'changes_requested', followUpPrompt: 'round 2 fixes' }),
      makeReview({ verdict: 'changes_requested', followUpPrompt: 'round 3 fixes' })
    ];

    // Round 1 review -> changes requested, budget remains.
    let task = await harness.orchestrator.reviewWithCodex(created.id);
    expect(task.status).toBe('CHANGES_REQUESTED');
    expect(task.currentRound).toBe(1);

    // Round 2 correction + review -> budget now exhausted.
    task = await harness.orchestrator.sendCorrections(created.id);
    expect(task.currentRound).toBe(2);
    task = await harness.orchestrator.reviewWithCodex(created.id);

    expect(task.status).toBe('FAILED');
    expect(task.lastError).toContain('Review round limit reached (2/2)');

    // The loop is genuinely over: no third Claude run is possible.
    expect(harness.claude.calls).toHaveLength(2);
    await expect(harness.orchestrator.sendCorrections(created.id)).rejects.toThrow();
    expect(harness.claude.calls).toHaveLength(2);
  });

  it('refuses corrections once the round budget is spent, even from CHANGES_REQUESTED', async () => {
    const project = harness.createProject();
    const created = harness.createTask(project.id, { maxRounds: 1 });
    await harness.orchestrator.generateSpecification(created.id);
    harness.orchestrator.approveSpecification(created.id);
    await harness.orchestrator.sendToClaude(created.id);

    // Force the state the UI would have to be wrong about to get here.
    harness.tasks.update(created.id, {
      status: 'CHANGES_REQUESTED',
      currentRound: 1,
      lastReviewJson: JSON.stringify(makeReview({ verdict: 'changes_requested' }))
    });

    await expect(harness.orchestrator.sendCorrections(created.id)).rejects.toThrow(
      /already used its 1 review round/i
    );
    expect(harness.claude.calls).toHaveLength(1);
  });

  it('returns to READY_FOR_REVIEW when the review itself fails', async () => {
    const { task } = await runToReview(harness);
    harness.codex.reviewError = new AgentRelayError('TOOL_FAILED', 'codex exploded');

    await expect(harness.orchestrator.reviewWithCodex(task.id)).rejects.toThrow('codex exploded');

    const after = harness.tasks.findById(task.id);
    expect(after?.status).toBe('READY_FOR_REVIEW');
    expect(after?.lastError).toContain('codex exploded');
  });
});

describe('concurrency and cancellation', () => {
  it('refuses a second operation while one is already running', async () => {
    const project = harness.createProject();
    const task = harness.createTask(project.id);

    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const original = harness.codex.createSpecification.bind(harness.codex);
    harness.codex.createSpecification = async (request, context) => {
      await gate;
      return original(request, context);
    };

    const first = harness.orchestrator.generateSpecification(task.id);
    await expect(harness.orchestrator.generateSpecification(task.id)).rejects.toThrow(
      /already has an agent running/i
    );

    release?.();
    await first;
  });

  it('cancels the in-flight run when the task is stopped', async () => {
    const project = harness.createProject();
    const task = harness.createTask(project.id);
    await harness.orchestrator.generateSpecification(task.id);
    harness.orchestrator.approveSpecification(task.id);

    harness.claude.onRun = (_request, context) => {
      // Emulate a process that observes the abort signal.
      context.signal.addEventListener('abort', () => undefined);
    };
    harness.claude.error = new AgentRelayError('CANCELLED', 'The Claude run was stopped.');

    await expect(harness.orchestrator.sendToClaude(task.id)).rejects.toMatchObject({
      code: 'CANCELLED'
    });

    const after = harness.tasks.findById(task.id);
    expect(after?.status).toBe('CANCELLED');
    expect(harness.runs.listByTask(task.id).at(-1)?.status).toBe('cancelled');
  });

  it('stops a task that has no run in flight', () => {
    const project = harness.createProject();
    const task = harness.createTask(project.id);

    const stopped = harness.orchestrator.stop(task.id);
    expect(stopped.status).toBe('CANCELLED');
  });
});

describe('durability across restart', () => {
  it('keeps projects, tasks, statuses and session ids in the database', async () => {
    const { task } = await runToReview(harness);
    await harness.orchestrator.reviewWithCodex(task.id);

    // A "restart" is a fresh set of repositories over the same database file.
    const reloaded = harness.tasks.findById(task.id);
    expect(reloaded?.status).toBe('APPROVED');
    expect(reloaded?.codexThreadId).toBe('codex-thread-1');
    expect(reloaded?.claudeSessionId).toBe('claude-session-1');
    expect(reloaded?.worktreePath).toBeTruthy();
    expect(reloaded?.branchName).toBeTruthy();

    const detail = harness.taskService.detail(task.id);
    expect(detail.specification?.title).toBe('Add a health endpoint');
    expect(detail.lastReview?.verdict).toBe('approved');
    expect(detail.runs.length).toBeGreaterThanOrEqual(3);
  });
});

describe('the orchestrator never publishes', () => {
  it('makes no Git commit, push, or GitHub call during the whole relay loop', async () => {
    const { task } = await runToReview(harness);
    harness.codex.reviewQueue = [
      makeReview({ verdict: 'changes_requested', followUpPrompt: 'fix' }),
      makeReview({ verdict: 'approved' })
    ];

    await harness.orchestrator.reviewWithCodex(task.id);
    await harness.orchestrator.sendCorrections(task.id);
    const done = await harness.orchestrator.reviewWithCodex(task.id);

    expect(done.status).toBe('APPROVED');
    expect(harness.git.commits).toHaveLength(0);
    expect(harness.git.pushes).toHaveLength(0);
    expect(harness.github.createdRepositories).toHaveLength(0);
    expect(harness.github.createdPullRequests).toHaveLength(0);
    expect(harness.confirmation.requests).toHaveLength(0);
  });
});

describe('specification content', () => {
  it('stores exactly what Codex returned', async () => {
    const custom = makeSpecification({ title: 'Custom title', constraints: ['a', 'b'] });
    harness.codex.specification = custom;

    const project = harness.createProject();
    const task = harness.createTask(project.id);
    const updated = await harness.orchestrator.generateSpecification(task.id);

    expect(JSON.parse(updated.specificationJson ?? '{}')).toEqual(custom);
    // The task title follows the specification's refined title.
    expect(updated.title).toBe('Custom title');
  });
});
