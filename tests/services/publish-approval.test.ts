/**
 * The publishing gate.
 *
 * These are the tests that back the strongest claim Agent Relay makes: that no
 * commit, push, repository, or pull request can happen without the user saying
 * yes to a dialog the renderer does not control.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APPROVAL_ACTIONS, type ApprovalAction } from '../../src/shared/domain/models';
import { createHarness, runToReview, type Harness } from '../helpers/harness';
import { makeReview } from '../helpers/fakes';

let harness: Harness;

beforeEach(() => {
  harness = createHarness({ confirmAnswer: true });
});

afterEach(() => {
  harness.dispose();
});

/** Drive a task all the way to READY_TO_PUBLISH. */
async function readyToPublish(h: Harness): Promise<string> {
  const { task } = await runToReview(h);
  h.codex.reviewQueue = [makeReview({ verdict: 'approved' })];
  await h.orchestrator.reviewWithCodex(task.id);
  h.orchestrator.approveForPublishing(task.id);
  return task.id;
}

describe('publishing requires explicit confirmation', () => {
  it.each(APPROVAL_ACTIONS)(
    'performs nothing for "%s" when the user declines',
    async (action: ApprovalAction) => {
      const taskId = await readyToPublish(harness);
      harness.confirmation.setAnswer(false);

      const outcome = await harness.publishService.execute({
        taskId,
        action,
        commitMessage: 'nope',
        repositoryName: 'demo',
        owner: 'Desken-van'
      });

      expect(outcome.performed).toBe(false);
      expect(harness.git.commits).toHaveLength(0);
      expect(harness.git.pushes).toHaveLength(0);
      expect(harness.github.createdRepositories).toHaveLength(0);
      expect(harness.github.createdPullRequests).toHaveLength(0);

      // The refusal is recorded rather than forgotten.
      const approvals = harness.approvals.listByTask(taskId);
      expect(approvals).toHaveLength(1);
      expect(approvals[0]?.status).toBe('denied');
      expect(approvals[0]?.action).toBe(action);
    }
  );

  it('shows the user the account, repository, visibility, branch and action first', async () => {
    const taskId = await readyToPublish(harness);
    harness.confirmation.setAnswer(false);

    await harness.publishService.execute({
      taskId,
      action: 'create_repository',
      owner: 'Desken-van',
      repositoryName: 'relay-demo',
      visibility: 'private'
    });

    const shown = harness.confirmation.requests[0];
    expect(shown?.account).toBe('Desken-van');
    expect(shown?.repository).toBe('relay-demo');
    expect(shown?.visibility).toBe('private');
    expect(shown?.branch).toMatch(/^agent-relay\//);
    expect(shown?.headline).toMatch(/create a new repository on github/i);
    expect(shown?.affectsRemote).toBe(true);
  });

  it('marks local-only actions as not affecting the remote', async () => {
    const taskId = await readyToPublish(harness);
    harness.confirmation.setAnswer(false);

    await harness.publishService.execute({ taskId, action: 'commit' });
    expect(harness.confirmation.requests[0]?.affectsRemote).toBe(false);
  });

  it('records the approval before asking, so a crash mid-dialog leaves a trace', async () => {
    const taskId = await readyToPublish(harness);

    let approvalsDuringPrompt = 0;
    const service = harness.confirmation;
    const original = service.confirm.bind(service);
    service.confirm = async (request) => {
      approvalsDuringPrompt = harness.approvals.listByTask(taskId).length;
      return original(request);
    };

    await harness.publishService.execute({ taskId, action: 'commit' });
    expect(approvalsDuringPrompt).toBe(1);
  });
});

describe('publishing when approved', () => {
  it('creates a commit and stays ready for the next step', async () => {
    const taskId = await readyToPublish(harness);

    const outcome = await harness.publishService.execute({
      taskId,
      action: 'commit',
      commitMessage: 'feat: add health endpoint'
    });

    expect(outcome.performed).toBe(true);
    expect(harness.git.commits).toHaveLength(1);
    expect(harness.git.commits[0]?.message).toBe('feat: add health endpoint');
    expect(harness.tasks.findById(taskId)?.status).toBe('READY_TO_PUBLISH');
    expect(harness.approvals.findGranted(taskId, 'commit')).not.toBeNull();
  });

  it('refuses to commit when Git has no identity configured', async () => {
    const taskId = await readyToPublish(harness);
    harness.git.repository = { ...harness.git.repository, userName: null, userEmail: null };

    await expect(harness.publishService.execute({ taskId, action: 'commit' })).rejects.toThrow(
      /no commit identity/i
    );
    expect(harness.git.commits).toHaveLength(0);
  });

  it('refuses to push without an origin remote', async () => {
    const taskId = await readyToPublish(harness);
    harness.git.repository = { ...harness.git.repository, hasRemoteOrigin: false };

    await expect(harness.publishService.execute({ taskId, action: 'push' })).rejects.toThrow(
      /no "origin" remote/i
    );
    expect(harness.git.pushes).toHaveLength(0);
  });

  it('never force-pushes', async () => {
    const taskId = await readyToPublish(harness);
    await harness.publishService.execute({ taskId, action: 'push' });

    expect(harness.git.pushes).toHaveLength(1);
    expect(harness.git.pushes[0]?.remote).toBe('origin');
  });

  it('refuses to create a repository that already exists', async () => {
    const taskId = await readyToPublish(harness);
    harness.github.existingRepositories.add('Desken-van/demo');

    await expect(
      harness.publishService.execute({
        taskId,
        action: 'create_repository',
        owner: 'Desken-van',
        repositoryName: 'demo'
      })
    ).rejects.toThrow(/already exists/i);

    expect(harness.github.createdRepositories).toHaveLength(0);
  });

  it('completes the task when a pull request is opened', async () => {
    const taskId = await readyToPublish(harness);

    const outcome = await harness.publishService.execute({
      taskId,
      action: 'create_pull_request',
      pullRequestTitle: 'Add health endpoint'
    });

    expect(outcome.performed).toBe(true);
    expect(outcome.url).toContain('https://github.com/');
    expect(harness.github.createdPullRequests[0]?.title).toBe('Add health endpoint');
    expect(harness.tasks.findById(taskId)?.status).toBe('COMPLETED');
  });

  it('returns to READY_TO_PUBLISH when a publish step fails, so it can be retried', async () => {
    const taskId = await readyToPublish(harness);
    harness.github.existingRepositories.add('Desken-van/demo');

    await expect(
      harness.publishService.execute({
        taskId,
        action: 'create_repository',
        owner: 'Desken-van',
        repositoryName: 'demo'
      })
    ).rejects.toThrow();

    const after = harness.tasks.findById(taskId);
    expect(after?.status).toBe('READY_TO_PUBLISH');
    expect(after?.lastError).toContain('already exists');
  });
});

describe('publishing is blocked outside the publishable states', () => {
  it.each(['DRAFT', 'READY_FOR_IMPLEMENTATION', 'IMPLEMENTING', 'READY_FOR_REVIEW', 'APPROVED'] as const)(
    'refuses to act while the task is %s',
    async (status) => {
      const { task } = await runToReview(harness);
      harness.tasks.update(task.id, { status });

      await expect(
        harness.publishService.execute({ taskId: task.id, action: 'commit' })
      ).rejects.toThrow();

      expect(harness.git.commits).toHaveLength(0);
    }
  );

  it('still records the user\'s answer even when the state gate then rejects', async () => {
    const { task } = await runToReview(harness);
    harness.tasks.update(task.id, { status: 'APPROVED' });

    await expect(
      harness.publishService.execute({ taskId: task.id, action: 'commit' })
    ).rejects.toThrow();

    // The approval was granted by the user but the domain refused to proceed.
    const approvals = harness.approvals.listByTask(task.id);
    expect(approvals[0]?.status).toBe('granted');
    expect(harness.git.commits).toHaveLength(0);
  });
});

describe('prepare is side-effect free', () => {
  it('changes nothing and asks nothing', async () => {
    const taskId = await readyToPublish(harness);

    const confirmation = harness.publishService.prepare({
      taskId,
      action: 'create_pull_request'
    });

    expect(confirmation.action).toBe('create_pull_request');
    expect(harness.confirmation.requests).toHaveLength(0);
    expect(harness.approvals.listByTask(taskId)).toHaveLength(0);
    expect(harness.github.createdPullRequests).toHaveLength(0);
    expect(harness.tasks.findById(taskId)?.status).toBe('READY_TO_PUBLISH');
  });
});
