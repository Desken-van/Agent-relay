/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { App } from '../../src/renderer/src/App';
import { roadmapView } from '../../src/shared/domain/roadmap-operations';
import type { RoadmapNode } from '../../src/shared/domain/roadmap';
import { taskSchema } from '../../src/shared/domain/models';
import { fail, installBridge, ok, renderApp } from './harness';

const project = {
  id: 'p', name: 'Demo repository', localPath: 'C:/repo', projectType: 'existing' as const,
  defaultBranch: 'main', githubOwner: null, githubRepo: null,
  githubVisibility: 'private' as const, createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z'
};
const goal: RoadmapNode = {
  id: 'goal-1', projectId: 'p', kind: 'goal', parentId: null, title: 'Ship roadmap',
  description: '', acceptanceCriteria: [], position: 0, state: 'open',
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z'
};
const view = (revision: number, nodes: readonly RoadmapNode[] = []) =>
  roadmapView({ projectId: 'p', revision, nodes: [...nodes], placements: [], dependencies: [], tasks: [] }, []);

afterEach(() => {
  cleanup();
  delete (window as unknown as { agentRelay?: unknown }).agentRelay;
});

async function openRoadmap(): Promise<void> {
  fireEvent.click(await screen.findByText('Demo repository'));
  fireEvent.click(screen.getByRole('button', { name: 'Roadmap' }));
}

describe('Roadmap authoring through the renderer', () => {
  it('shows the selected project and sends a create with the displayed revision', async () => {
    const bridge = installBridge({
      'projects:list': () => ok<'projects:list'>([project]),
      'tasks:list': () => ok<'tasks:list'>([]),
      'roadmap:get': () => ok<'roadmap:get'>(view(4)),
      'roadmap:createNode': () => ok<'roadmap:createNode'>(view(5, [goal]))
    });
    renderApp(<App />);
    await openRoadmap();

    await screen.findByText('No goals yet');
    fireEvent.click(screen.getByRole('button', { name: '+ Goal' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New goal title' }), { target: { value: goal.title } });
    fireEvent.click(screen.getByRole('button', { name: 'Create goal' }));

    await screen.findByRole('button', { name: /Ship roadmap/ });
    expect(bridge.callsTo('roadmap:createNode')).toEqual([{
      channel: 'roadmap:createNode',
      input: { projectId: 'p', expectedRevision: 4, kind: 'goal', parentId: null, title: goal.title, description: '' }
    }]);
  });

  it('does not replay a stale write and enables a new edit only after refresh', async () => {
    let current = view(3);
    const bridge = installBridge({
      'projects:list': () => ok<'projects:list'>([project]),
      'tasks:list': () => ok<'tasks:list'>([]),
      'roadmap:get': () => ok<'roadmap:get'>(current),
      'roadmap:createNode': () => fail('Roadmap changed. Refresh.')
    });
    renderApp(<App />);
    await openRoadmap();
    await screen.findByText('No goals yet');
    fireEvent.click(screen.getByRole('button', { name: '+ Goal' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New goal title' }), { target: { value: goal.title } });
    fireEvent.click(screen.getByRole('button', { name: 'Create goal' }));

    await screen.findByText('The roadmap changed while you were editing.');
    expect(bridge.callsTo('roadmap:createNode')).toHaveLength(1);
    expect((screen.getByRole('button', { name: 'Create goal' }) as HTMLButtonElement).disabled).toBe(true);

    current = view(4);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByText('Revision 4')).toBeTruthy());
    expect(bridge.callsTo('roadmap:createNode')).toHaveLength(1);
    expect((screen.getByRole('button', { name: 'Create goal' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps the task navigation available when the roadmap cannot load', async () => {
    const task = taskSchema.parse({
      id: 'task-1', projectId: 'p', title: 'Existing task', originalRequest: 'Keep working',
      status: 'DRAFT', currentRound: 1, maxRounds: 3, codexThreadId: null, claudeSessionId: null,
      worktreePath: null, branchName: null, baseBranch: null, specificationJson: null,
      specificationApprovedAt: null, lastReviewJson: null, lastError: null, codexModel: null,
      claudeModel: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z'
    });
    installBridge({
      'projects:list': () => ok<'projects:list'>([project]),
      'tasks:list': () => ok<'tasks:list'>([task]),
      'roadmap:get': () => fail('Invalid roadmap snapshot.')
    });
    renderApp(<App />);
    await openRoadmap();
    await screen.findByText('Tasks remain available');
    expect(screen.getByRole('button', { name: /Existing task/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Tasks/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '+ Goal' })).toBeNull();
  });

  it('moves an Unassigned task to an epic without changing its workflow state', async () => {
    const stamp = '2026-10-01T00:00:00.000Z';
    const phase: RoadmapNode = { ...goal, id: 'phase-1', kind: 'phase', parentId: goal.id, title: 'Build' };
    const epic: RoadmapNode = { ...goal, id: 'epic-1', kind: 'epic', parentId: phase.id, title: 'Renderer' };
    const facts = [{ id: 'task-1', projectId: 'p', status: 'DRAFT' as const, continuedByTaskId: null }];
    const unassigned = roadmapView({
      projectId: 'p', revision: 7, nodes: [goal, phase, epic], placements: [], dependencies: [], tasks: facts
    }, ['task-1']);
    const placed = roadmapView({
      projectId: 'p', revision: 8, nodes: [goal, phase, epic],
      placements: [{ taskId: 'task-1', projectId: 'p', epicId: epic.id, position: 0, createdAt: stamp, updatedAt: stamp }],
      dependencies: [], tasks: facts
    }, []);
    const bridge = installBridge({
      'projects:list': () => ok<'projects:list'>([project]),
      'tasks:list': () => ok<'tasks:list'>([]),
      'roadmap:get': () => ok<'roadmap:get'>(unassigned),
      'roadmap:placeTask': () => ok<'roadmap:placeTask'>(placed)
    });
    renderApp(<App />);
    await openRoadmap();
    await screen.findByText('Ship roadmap');
    fireEvent.click(screen.getByRole('tab', { name: 'Kanban' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Place task-1' }), { target: { value: epic.id } });
    await waitFor(() => expect(screen.getByText('Revision 8')).toBeTruthy());
    expect(bridge.callsTo('roadmap:placeTask')[0]?.input).toEqual({
      projectId: 'p', expectedRevision: 7, taskId: 'task-1', epicId: epic.id
    });
    expect(screen.getByText('DRAFT')).toBeTruthy();
  });
});
