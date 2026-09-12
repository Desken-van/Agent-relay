import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS, ipcInputSchemas } from '../../src/shared/ipc';

describe('workflow:continue IPC contract', () => {
  it('is registered and accepts only the failed source task id', () => {
    expect(IPC_CHANNELS).toContain('workflow:continue');
    expect(ipcInputSchemas['workflow:continue'].parse({ taskId: 'source-1' })).toEqual({ taskId: 'source-1' });
    for (const extra of [
      { path: 'C:/worktree' }, { branch: 'feature' }, { specification: {} },
      { command: 'npm run verify' }, { provider: 'codex' }, { evidence: {} },
      { result: 'approved' }, { maxRounds: 20 }
    ]) {
      expect(ipcInputSchemas['workflow:continue'].safeParse({ taskId: 'source-1', ...extra }).success).toBe(false);
    }
  });
});
