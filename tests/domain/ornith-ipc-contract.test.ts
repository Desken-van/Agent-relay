/**
 * `tasks:create` and `workflow:configureProviders` accept Ornith only as an
 * implementation provider, reject it as a review provider, reject unknown
 * provider strings and extra fields, and expose no model-tool IPC channel.
 */

import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS, ipcInputSchemas } from '../../src/shared/ipc';

describe('Ornith IPC contract', () => {
  it('tasks:create accepts implementationProvider: "ornith"', () => {
    const result = ipcInputSchemas['tasks:create'].safeParse({
      projectId: 'p1',
      title: 'Task',
      originalRequest: 'Do the thing',
      implementationProvider: 'ornith'
    });
    expect(result.success).toBe(true);
  });

  it('tasks:create rejects reviewProvider: "ornith"', () => {
    const result = ipcInputSchemas['tasks:create'].safeParse({
      projectId: 'p1',
      title: 'Task',
      originalRequest: 'Do the thing',
      reviewProvider: 'ornith'
    });
    expect(result.success).toBe(false);
  });

  it('tasks:create rejects an unknown implementation provider string', () => {
    const result = ipcInputSchemas['tasks:create'].safeParse({
      projectId: 'p1',
      title: 'Task',
      originalRequest: 'Do the thing',
      implementationProvider: 'gpt5'
    });
    expect(result.success).toBe(false);
  });

  it('tasks:create preserves the default of Claude implementation / Codex review when provider fields are omitted', () => {
    const result = ipcInputSchemas['tasks:create'].safeParse({
      projectId: 'p1',
      title: 'Task',
      originalRequest: 'Do the thing'
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('implementationProvider' in result.data).toBe(false);
      expect('reviewProvider' in result.data).toBe(false);
    }
  });

  it('tasks:create rejects extra fields (strict)', () => {
    const result = ipcInputSchemas['tasks:create'].safeParse({
      projectId: 'p1',
      title: 'Task',
      originalRequest: 'Do the thing',
      implementationProvider: 'ornith',
      ornithToolAction: { action: 'run_shell', command: 'ls' }
    });
    expect(result.success).toBe(false);
  });

  it('workflow:configureProviders accepts implementationProvider: "ornith" with a claude/codex reviewProvider', () => {
    const result = ipcInputSchemas['workflow:configureProviders'].safeParse({
      taskId: 't1',
      expectedRevision: 0,
      implementationProvider: 'ornith',
      reviewProvider: 'codex'
    });
    expect(result.success).toBe(true);
  });

  it('workflow:configureProviders rejects reviewProvider: "ornith"', () => {
    const result = ipcInputSchemas['workflow:configureProviders'].safeParse({
      taskId: 't1',
      expectedRevision: 0,
      implementationProvider: 'claude',
      reviewProvider: 'ornith'
    });
    expect(result.success).toBe(false);
  });

  it('workflow:configureProviders requires both fields (no implicit default)', () => {
    const result = ipcInputSchemas['workflow:configureProviders'].safeParse({
      taskId: 't1',
      expectedRevision: 0,
      implementationProvider: 'ornith'
    });
    expect(result.success).toBe(false);
  });

  it('exposes no model-tool IPC channel for Ornith', () => {
    const toolLikeChannels = IPC_CHANNELS.filter((channel) => channel.toLowerCase().includes('ornith'));
    expect(toolLikeChannels).toEqual([]);
  });
});
