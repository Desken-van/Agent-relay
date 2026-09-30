/**
 * The Roadmap IPC surface: every channel registered and strictly validated, text normalised at the
 * boundary, and no shape through which a task could be created, changed or run.
 */

import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS, ipcInputSchemas, isIpcChannel } from '../../src/shared/ipc';

const ROADMAP_CHANNELS = [
  'roadmap:get',
  'roadmap:createNode',
  'roadmap:updateNode',
  'roadmap:moveNode',
  'roadmap:removeNode',
  'roadmap:transitionNode',
  'roadmap:placeTask',
  'roadmap:unassignTask',
  'roadmap:addDependency',
  'roadmap:removeDependency'
] as const;

const scope = { projectId: 'p1', expectedRevision: 3 };

describe('the Roadmap channels', () => {
  it('are all registered and validated', () => {
    for (const channel of ROADMAP_CHANNELS) {
      expect(IPC_CHANNELS).toContain(channel);
      expect(isIpcChannel(channel)).toBe(true);
    }
    expect(IPC_CHANNELS.filter((channel) => channel.startsWith('roadmap:')).sort()).toEqual([...ROADMAP_CHANNELS].sort());
  });

  it('refuse an unknown key on every channel', () => {
    const valid: Record<(typeof ROADMAP_CHANNELS)[number], object> = {
      'roadmap:get': { projectId: 'p1' },
      'roadmap:createNode': { ...scope, kind: 'goal', parentId: null, title: 'Goal' },
      'roadmap:updateNode': { ...scope, nodeId: 'n1', title: 'Goal' },
      'roadmap:moveNode': { ...scope, nodeId: 'n1', parentId: null, position: 0 },
      'roadmap:removeNode': { ...scope, nodeId: 'n1' },
      'roadmap:transitionNode': { ...scope, nodeId: 'n1', event: 'accept' },
      'roadmap:placeTask': { ...scope, taskId: 't1', epicId: 'e1' },
      'roadmap:unassignTask': { ...scope, taskId: 't1' },
      'roadmap:addDependency': { ...scope, dependent: { kind: 'task', taskId: 't1' }, prerequisite: { kind: 'node', nodeId: 'n1' } },
      'roadmap:removeDependency': { ...scope, dependencyId: 'd1' }
    };
    for (const channel of ROADMAP_CHANNELS) {
      expect(ipcInputSchemas[channel].safeParse(valid[channel]).success, channel).toBe(true);
      expect(ipcInputSchemas[channel].safeParse({ ...valid[channel], status: 'COMPLETED' }).success, channel).toBe(false);
    }
  });

  it('require a project and a non-negative integer revision for every write', () => {
    const create = ipcInputSchemas['roadmap:createNode'];
    const node = { kind: 'goal', parentId: null, title: 'Goal' };
    expect(create.safeParse({ ...node, expectedRevision: 0 }).success).toBe(false);
    expect(create.safeParse({ ...node, projectId: 'p1' }).success).toBe(false);
    for (const expectedRevision of [-1, 1.5, '3']) {
      expect(create.safeParse({ ...node, projectId: 'p1', expectedRevision }).success).toBe(false);
    }
  });

  it('normalise what a person typed and refuse what storage would', () => {
    const create = ipcInputSchemas['roadmap:createNode'];
    const parsed = create.parse({
      ...scope, kind: 'epic', parentId: 'ph1', title: '  Epic  ', description: 'a\r\nb  ', acceptanceCriteria: [' Done. ']
    });
    expect(parsed).toMatchObject({ title: 'Epic', description: 'a\nb', acceptanceCriteria: ['Done.'] });
    expect(create.safeParse({ ...scope, kind: 'goal', parentId: null, title: '   ' }).success).toBe(false);
    expect(create.safeParse({ ...scope, kind: 'goal', parentId: null, title: 'x'.repeat(201) }).success).toBe(false);
    expect(create.safeParse({ ...scope, kind: 'goal', parentId: null, title: 'Bell\u0007' }).success).toBe(false);
    expect(create.safeParse({ ...scope, kind: 'task', parentId: null, title: 'x' }).success).toBe(false);
  });

  it('accept only the node events and item references the domain defines', () => {
    const transition = ipcInputSchemas['roadmap:transitionNode'];
    for (const event of ['accept', 'cancel', 'reopen']) {
      expect(transition.safeParse({ ...scope, nodeId: 'n1', event }).success).toBe(true);
    }
    expect(transition.safeParse({ ...scope, nodeId: 'n1', event: 'complete' }).success).toBe(false);
    const add = ipcInputSchemas['roadmap:addDependency'];
    expect(add.safeParse({ ...scope, dependent: { kind: 'task', nodeId: 'x' }, prerequisite: { kind: 'node', nodeId: 'n1' } }).success).toBe(false);
    expect(add.safeParse({ ...scope, dependent: { kind: 'unassigned' }, prerequisite: { kind: 'node', nodeId: 'n1' } }).success).toBe(false);
  });

  it('take positions as non-negative integers only', () => {
    const move = ipcInputSchemas['roadmap:moveNode'];
    for (const position of [-1, 0.5, '1']) {
      expect(move.safeParse({ ...scope, nodeId: 'n1', parentId: null, position }).success).toBe(false);
    }
  });
});
