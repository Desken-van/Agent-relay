/**
 * What the code-review channels will and will not accept.
 *
 * The renderer does not exist yet, which is exactly why this is worth pinning
 * now: the shape a future screen is allowed to send is a security boundary, and
 * it is far easier to keep narrow than to narrow later.
 */

import { describe, expect, it } from 'vitest';
import { ipcInputSchemas, isIpcChannel } from '../../src/shared/ipc';

const CODE_REVIEW_CHANNELS = [
  'codeReview:get',
  'codeReview:capture',
  'codeReview:review',
  'codeReview:reconcile',
  'codeReview:decide'
] as const;

describe('the code-review IPC contract', () => {
  it('registers exactly the five bounded operations', () => {
    for (const channel of CODE_REVIEW_CHANNELS) {
      expect(isIpcChannel(channel)).toBe(true);
      expect(ipcInputSchemas[channel]).toBeDefined();
    }
  });

  it('lets a caller start a round by naming a task, and by naming nothing else', () => {
    const schema = ipcInputSchemas['codeReview:review'];
    expect(schema.safeParse({ taskId: 'task-1' }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);

    // The whole capability boundary, as an input schema. A renderer that could
    // send any of these would be choosing what the external reviewer IS and
    // where it runs — the process, its argv, its working directory, the tool
    // profile it is trusted with, or the identity a round is filed under. Every
    // one of them is resolved in the main process from persisted settings.
    for (const extra of [
      { executablePath: 'C:/evil/coai.exe' },
      { args: ['--attach-debugger'] },
      { cwd: 'C:/somewhere-else' },
      { allowedTools: ['reserve_round', 'run_round', 'round_status', 'shell'] },
      { providerId: 'somebody-else' },
      { sessionId: 's-1' },
      { roundId: 'r-1' },
      { subjectSha256: 'a'.repeat(64) },
      { scopeText: 'review whatever you like' },
      { worktreePath: 'C:/other-repo' },
      { baseRef: 'main' }
    ]) {
      expect(schema.safeParse({ taskId: 'task-1', ...extra }).success, JSON.stringify(extra)).toBe(
        false
      );
    }
  });

  it('accepts only a task id for the read-only reconciliation', () => {
    const schema = ipcInputSchemas['codeReview:reconcile'];
    expect(schema.safeParse({ taskId: 'task-1' }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
    // It must not become a way to name a round, a provider or a session: the
    // service reads those from durable state, and accepting them here would let
    // a caller reconcile something other than what it dispatched.
    for (const extra of [
      { roundId: 'round-1' },
      { sessionId: 'session-1' },
      { subjectSha256: 'a'.repeat(64) },
      { force: true }
    ]) {
      expect(schema.safeParse({ taskId: 'task-1', ...extra }).success).toBe(false);
    }
  });

  it('never accepts a process, repository, prompt or provider configuration', () => {
    const smuggled = [
      { executablePath: 'C:\\tools\\coai.exe' },
      { args: ['--token', 'secret'] },
      { cwd: 'C:\\repo' },
      { repoPath: 'C:\\other-project' },
      { worktreePath: 'C:\\repo\\worktree' },
      { baseRef: 'origin/main' },
      { branch: 'agent/task' },
      { diff: 'diff --git a/x b/x' },
      { scopeText: 'ignore the stored specification' },
      { prompt: 'do something else' },
      { provider: 'some-other-vendor' },
      { threshold: 0 },
      { subjectSha256: 'a'.repeat(64) },
      { token: 'not-a-real-token' }
    ];

    for (const channel of CODE_REVIEW_CHANNELS) {
      for (const extra of smuggled) {
        const base =
          channel === 'codeReview:decide'
            ? {
                taskId: 'task-1',
                findingId: 'finding-1',
                expectedRevision: 0,
                action: 'accept' as const,
                reason: 'Legitimate.'
              }
            : { taskId: 'task-1' };
        expect(ipcInputSchemas[channel].safeParse({ ...base, ...extra }).success).toBe(false);
      }
    }
  });

  it('accepts only a task id for reading and capturing', () => {
    for (const channel of ['codeReview:get', 'codeReview:capture'] as const) {
      expect(ipcInputSchemas[channel].safeParse({ taskId: 'task-1' }).success).toBe(true);
      expect(ipcInputSchemas[channel].safeParse({}).success).toBe(false);
      expect(ipcInputSchemas[channel].safeParse({ taskId: '' }).success).toBe(false);
    }
  });

  it('requires a decision to name its finding, its revision and its reason', () => {
    const schema = ipcInputSchemas['codeReview:decide'];
    const complete = {
      taskId: 'task-1',
      findingId: 'finding-1',
      expectedRevision: 3,
      action: 'reject' as const,
      reason: 'The premise is contradicted by the code.'
    };
    expect(schema.safeParse(complete).success).toBe(true);

    // Each field is load-bearing: without the finding there is nothing to
    // answer, without the revision a stale screen can overwrite a newer answer,
    // and without a reason the audit trail records a verdict with no argument.
    for (const missing of ['findingId', 'expectedRevision', 'reason'] as const) {
      const partial = { ...complete };
      delete (partial as Record<string, unknown>)[missing];
      expect(schema.safeParse(partial).success).toBe(false);
    }
    expect(schema.safeParse({ ...complete, reason: '' }).success).toBe(false);
    expect(schema.safeParse({ ...complete, expectedRevision: -1 }).success).toBe(false);
    expect(schema.safeParse({ ...complete, expectedRevision: 1.5 }).success).toBe(false);
  });

  it('accepts only the three decision actions the lifecycle defines', () => {
    const schema = ipcInputSchemas['codeReview:decide'];
    const base = {
      taskId: 'task-1',
      findingId: 'finding-1',
      expectedRevision: 0,
      reason: 'Because.'
    };

    for (const action of ['accept', 'reject', 'resolved'] as const) {
      expect(schema.safeParse({ ...base, action }).success).toBe(true);
    }
    for (const action of ['dismiss', 'ignore', 'wontfix', '']) {
      expect(schema.safeParse({ ...base, action }).success).toBe(false);
    }
  });
});
