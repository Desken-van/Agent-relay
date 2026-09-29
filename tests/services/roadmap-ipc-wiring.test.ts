/**
 * The Roadmap through the composition root and the IPC boundary: a real container, the real handler table,
 * only Electron's `ipcMain` replaced — so a request passes the same schema validation, handler and error
 * serialisation a renderer's does.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => ({ invoke: null as null | ((event: unknown, payload: unknown) => Promise<unknown>) }));
vi.mock('electron/main', () => ({
  dialog: {},
  ipcMain: {
    handle: (_channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.invoke = handler;
    },
    removeHandler: () => undefined
  }
}));
vi.mock('electron/common', () => ({ shell: {} }));

import { buildApplication, type Application } from '../../src/main/container';
import { registerIpc } from '../../src/main/ipc/register-ipc';
import { InMemoryEventPublisher } from '../../src/main/services/event-bus';
import type { RoadmapView } from '../../src/shared/domain/roadmap-operations';
import type { IpcResult } from '../../src/shared/ipc';
import { RecordingConfirmationService } from '../helpers/fakes';

let root: string;
let app: Application;
let events: InMemoryEventPublisher;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-relay-roadmap-ipc-'));
  events = new InMemoryEventPublisher();
  app = buildApplication({
    paths: { dataDir: root, documentsDir: root },
    databaseFile: ':memory:',
    events,
    confirmation: new RecordingConfirmationService(false)
  });
  registerIpc({ app, getWindow: () => null });
  for (const id of ['project-1', 'project-2']) {
    app.projects.create({
      id, name: id, localPath: join(root, id), projectType: 'existing', defaultBranch: 'main',
      githubOwner: null, githubRepo: null, githubVisibility: 'private'
    });
  }
  for (const [id, projectId] of [['task-1', 'project-1'], ['task-2', 'project-2']] as const) {
    app.tasks.create({
      id, projectId, title: 'Task', originalRequest: 'Request', status: 'DRAFT', currentRound: 0, maxRounds: 3,
      codexThreadId: null, claudeSessionId: null, codexModel: null, claudeModel: null, worktreePath: null,
      branchName: null, baseBranch: null, specificationJson: null, specificationApprovedAt: null,
      lastReviewJson: null, lastError: null
    });
  }
});

afterEach(() => {
  app.close();
  rmSync(root, { recursive: true, force: true });
  handlers.invoke = null;
});

async function invoke<T = RoadmapView>(channel: string, input: unknown): Promise<IpcResult<T>> {
  if (!handlers.invoke) throw new Error('IPC was not registered');
  return (await handlers.invoke({}, { channel, input })) as IpcResult<T>;
}

async function ok(channel: string, input: unknown): Promise<RoadmapView> {
  const result = await invoke(channel, input);
  if (!result.ok) throw new Error(`${channel} failed: ${result.error.message} ${result.error.details ?? ''}`);
  return result.data;
}

const roadmapRows = () => Object.fromEntries(
  ['roadmap_heads', 'roadmap_nodes', 'roadmap_task_placements', 'roadmap_dependencies']
    .map((table) => [table, app.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])
);

describe('Roadmap over IPC', () => {
  it('builds, places and reads a roadmap, publishing one event per committed write', async () => {
    let view = await ok('roadmap:createNode', { projectId: 'project-1', expectedRevision: 0, kind: 'goal', parentId: null, title: ' Goal ' });
    const goal = view.nodes[0]!.id;
    view = await ok('roadmap:createNode', { projectId: 'project-1', expectedRevision: 1, kind: 'phase', parentId: goal, title: 'Phase' });
    view = await ok('roadmap:createNode', { projectId: 'project-1', expectedRevision: 2, kind: 'epic', parentId: view.nodes.find((node) => node.kind === 'phase')!.id, title: 'Epic' });
    const epic = view.nodes.find((node) => node.kind === 'epic')!.id;
    view = await ok('roadmap:placeTask', { projectId: 'project-1', expectedRevision: 3, taskId: 'task-1', epicId: epic });

    expect(view.nodes[0]!.title).toBe('Goal');
    expect(view.placements).toMatchObject([{ taskId: 'task-1', epicId: epic, position: 0 }]);
    expect(view.progress[goal]).toMatchObject({ counts: { notStarted: 1, total: 1 }, display: 'not_started' });
    expect(await ok('roadmap:get', { projectId: 'project-1' })).toEqual(view);
    expect(events.events.filter((event) => event.kind === 'roadmap-updated').map((event) => event.kind === 'roadmap-updated' && event.revision))
      .toEqual([1, 2, 3, 4]);
    // The task itself is unchanged by being placed.
    expect(app.tasks.findById('task-1')?.status).toBe('DRAFT');
  });

  it('refuses an invalid payload before any handler runs, with a serialised error and nothing written', async () => {
    const rows = roadmapRows();
    const result = await invoke('roadmap:createNode', { projectId: 'project-1', expectedRevision: 0, kind: 'goal', parentId: null, title: 'x', status: 'COMPLETED' });
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', message: 'Invalid input for "roadmap:createNode".' } });
    expect(roadmapRows()).toEqual(rows);
    expect(events.events).toEqual([]);
  });

  it('serialises a policy refusal and a stale revision without writing or publishing', async () => {
    await ok('roadmap:createNode', { projectId: 'project-1', expectedRevision: 0, kind: 'goal', parentId: null, title: 'Goal' });
    const rows = roadmapRows();
    const published = events.events.length;
    expect(await invoke('roadmap:createNode', { projectId: 'project-1', expectedRevision: 0, kind: 'goal', parentId: null, title: 'Late' }))
      .toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED', message: 'Roadmap changed. Refresh.' } });
    expect(await invoke('roadmap:createNode', { projectId: 'project-1', expectedRevision: 1, kind: 'epic', parentId: null, title: 'Orphan' }))
      .toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    expect(roadmapRows()).toEqual(rows);
    expect(events.events).toHaveLength(published);
  });

  it('keeps projects apart: another project’s task or node cannot be named', async () => {
    const view = await ok('roadmap:createNode', { projectId: 'project-1', expectedRevision: 0, kind: 'goal', parentId: null, title: 'Goal' });
    const goal = view.nodes[0]!.id;
    expect(await invoke('roadmap:createNode', { projectId: 'project-2', expectedRevision: 0, kind: 'phase', parentId: goal, title: 'Stolen' }))
      .toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await invoke('roadmap:addDependency', {
      projectId: 'project-1', expectedRevision: 1, dependent: { kind: 'node', nodeId: goal }, prerequisite: { kind: 'task', taskId: 'task-2' }
    })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await ok('roadmap:get', { projectId: 'project-2' })).toMatchObject({ revision: 0, nodes: [], unassignedTaskIds: ['task-2'] });
  });

  it('keeps the task list reachable while the roadmap is damaged', async () => {
    await ok('roadmap:createNode', { projectId: 'project-1', expectedRevision: 0, kind: 'goal', parentId: null, title: 'Goal' });
    app.db.prepare(`UPDATE roadmap_nodes SET acceptance_criteria_json = 'not-json'`).run();
    expect(await invoke('roadmap:get', { projectId: 'project-1' })).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    const tasks = await invoke<{ id: string }[]>('tasks:list', { projectId: 'project-1' });
    expect(tasks).toMatchObject({ ok: true, data: [{ id: 'task-1' }] });
  });
});
