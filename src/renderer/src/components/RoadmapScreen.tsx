import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RoadmapDependency, RoadmapItemRef, RoadmapNode, RoadmapNodeKind, RoadmapTaskPlacement } from '@shared/domain/roadmap';
import { effectiveWaits, type RoadmapView } from '@shared/domain/roadmap-operations';
import type { Task } from '@shared/domain/models';
import type { IpcResult } from '@shared/ipc';
import { call } from '../lib/api';
import { useStore } from '../state/store';
import { Card, Empty, Field, Notice, Spinner } from './primitives';

type Write = (request: (revision: number) => Promise<IpcResult<RoadmapView>>, action: string) => Promise<boolean>;
type Tab = 'tree' | 'board' | 'dependencies';
interface CriterionDraft { key: string; id?: string; text: string }
interface NodeDraft {
  baseRevision: number;
  title: string;
  description: string;
  criteria: CriterionDraft[];
}
let nextCriterionKey = 0;

const byPosition = <T extends { position: number; id?: string; taskId?: string }>(rows: readonly T[]): T[] =>
  [...rows].sort((a, b) => a.position - b.position || (a.id ?? a.taskId ?? '').localeCompare(b.id ?? b.taskId ?? ''));

function itemKey(ref: RoadmapItemRef): string {
  return ref.kind === 'node' ? `node:${ref.nodeId}` : `task:${ref.taskId}`;
}

function itemFromKey(value: string): RoadmapItemRef {
  return value.startsWith('node:')
    ? { kind: 'node', nodeId: value.slice(5) }
    : { kind: 'task', taskId: value.slice(5) };
}

function itemName(ref: RoadmapItemRef, view: RoadmapView, tasks: readonly Task[]): string {
  if (ref.kind === 'node') return view.nodes.find((node) => node.id === ref.nodeId)?.title ?? ref.nodeId;
  return tasks.find((task) => task.id === ref.taskId)?.title ?? ref.taskId;
}

/** The selected project's roadmap is deliberately local to this screen. Tasks and Run keep their own workflow state. */
export function RoadmapScreen(): React.JSX.Element {
  const { selectedProject, tasks, refreshTasks, selectTask, setSection } = useStore();
  const projectId = selectedProject?.id;
  const projectTasks = useMemo(() => tasks.filter((task) => task.projectId === projectId), [tasks, projectId]);
  useEffect(() => {
    if (projectId) void refreshTasks(projectId);
  }, [projectId, refreshTasks]);
  if (!selectedProject) return <Card><Empty title="No project selected" hint="Choose a project before opening its roadmap." /></Card>;
  return (
    <RoadmapProject
      key={selectedProject.id}
      projectId={selectedProject.id}
      tasks={projectTasks}
      openTask={(taskId) => { selectTask(taskId); setSection('run'); }}
    />
  );
}

function RoadmapProject({ projectId, tasks, openTask }: {
  projectId: string;
  tasks: readonly Task[];
  openTask: (taskId: string) => void;
}): React.JSX.Element {
  const [view, setView] = useState<RoadmapView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const busy = busyAction !== null;
  const [tab, setTab] = useState<Tab>('tree');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, NodeDraft>>({});
  const requestSerial = useRef(0);
  const alive = useRef(false);
  const writing = useRef(false);

  const reload = useCallback(async (showLoading = false): Promise<void> => {
    const request = ++requestSerial.current;
    if (showLoading) setLoading(true);
    let result: IpcResult<RoadmapView>;
    try {
      result = await call('roadmap:get', { projectId });
    } catch (cause) {
      if (alive.current && request === requestSerial.current) {
        setView(null);
        setError(cause instanceof Error ? cause.message : String(cause));
        setLoading(false);
      }
      return;
    }
    if (!alive.current || request !== requestSerial.current) return;
    if (result.ok) {
      setView((current) => current && current.revision > result.data.revision ? current : result.data);
      setError(null);
      setConflict(false);
    } else {
      // Never render a possibly stale roadmap as editable after an integrity or transport failure.
      setView(null);
      setError(result.error.message);
    }
    setLoading(false);
  }, [projectId]);

  useEffect(() => {
    let disposed = false;
    alive.current = true;
    // Begin after the effect has installed its lifetime guard.
    queueMicrotask(() => { if (!disposed) void reload(); });
    return () => { disposed = true; alive.current = false; requestSerial.current += 1; };
  }, [reload]);

  useEffect(() => {
    if (typeof window.agentRelay?.onEvent !== 'function') return undefined;
    return window.agentRelay.onEvent((event) => {
      if (event.kind === 'roadmap-updated' && event.projectId === projectId) void reload();
    });
  }, [projectId, reload]);

  const write: Write = useCallback(async (request, action) => {
    if (writing.current || view === null || conflict) return false;
    writing.current = true;
    setBusyAction(action);
    try {
      const result = await request(view.revision);
      if (!alive.current) return false;
      if (!result.ok) {
        setError(result.error.message);
        if (result.error.code === 'ROADMAP_CHANGED') setConflict(true);
        return false;
      }
      setView((current) => current && current.revision > result.data.revision ? current : result.data);
      setError(null);
      return true;
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      writing.current = false;
      if (alive.current) setBusyAction(null);
    }
  }, [view, conflict]);

  const selectedNode = view?.nodes.find((node) => node.id === selectedNodeId)
    ?? view?.nodes.find((node) => node.kind === 'goal') ?? null;
  const canWrite = !busy && !conflict && view !== null;

  return <div className="roadmap">
    <header className="roadmap__header">
      <div>
        <h1>Roadmap</h1>
        <p>Plan the work around goals. Tasks still run from their own Run screen.</p>
      </div>
      <div className="roadmap__header-actions">
        {view ? <span className="roadmap__revision">Revision {view.revision}</span> : null}
        {busyAction ? <span role="status" className="roadmap__revision"><Spinner /> {busyAction}</span> : null}
        <button type="button" className="btn btn--sm" onClick={() => void reload(true)} disabled={loading || busy}>
          {loading ? <Spinner /> : null} Refresh
        </button>
      </div>
    </header>

    <div className="roadmap__tabs" role="tablist" aria-label="Roadmap views">
      {([['tree', 'Roadmap'], ['board', 'Kanban'], ['dependencies', 'Dependencies']] as const).map(([id, label]) =>
        <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>
      )}
    </div>

    {error ? <Notice tone="error" role="alert">
      <strong>{conflict ? 'The roadmap changed while you were editing.' : 'Roadmap could not be loaded or changed.'}</strong>
      <div>{error}</div>
      {conflict ? <div>Refresh before making another change. Your last action was not applied.</div> : null}
    </Notice> : null}
    {view && view.cyclicDependencyIds.length > 0 ? <Notice tone="warn">
      {view.cyclicDependencyIds.length} dependency {view.cyclicDependencyIds.length === 1 ? 'is' : 'are'} in a cycle. Affected work is blocked until an edge is removed.
    </Notice> : null}
    {view && view.unresolvedDependencies.length > 0 ? <Notice tone="warn">
      {view.unresolvedDependencies.length} dependency endpoint {view.unresolvedDependencies.length === 1 ? 'cannot' : 'endpoints cannot'} resolve a continuation. Check the affected tasks.
    </Notice> : null}

    {loading && !view ? <div className="empty"><Spinner /> Loading roadmap…</div> : null}
    {!loading && !view ? <Card title="Tasks remain available">
      <p className="muted">The roadmap is unavailable. You can still open and run tasks while the roadmap is repaired.</p>
      <div className="roadmap__fallback">{tasks.map((task) =>
        <button type="button" className="roadmap__fallback-task" key={task.id} onClick={() => openTask(task.id)}>
          <span>{task.title}</span><span className="faint">{task.status}</span>
        </button>
      )}</div>
    </Card> : null}

    {view && tab === 'tree' ? <div className="roadmap__split">
      <RoadmapTree view={view} selectedNodeId={selectedNode?.id ?? null} onSelect={setSelectedNodeId} write={write} canWrite={canWrite} />
      <div className="roadmap__detail">
        {selectedNode ? <NodeInspector
          key={selectedNode.id}
          node={selectedNode} view={view} tasks={tasks} write={write} canWrite={canWrite}
          draft={drafts[selectedNode.id] ?? null}
          onDraftChange={(next) => setDrafts((current) => ({ ...current, [selectedNode.id]: next }))}
          onDraftDiscard={() => setDrafts((current) => {
            const next = { ...current };
            delete next[selectedNode.id];
            return next;
          })}
        /> : <Card><Empty title="Start with a goal" hint="A goal contains phases, and each phase contains epics for tasks." /></Card>}
      </div>
    </div> : null}
    {view && tab === 'board' ? <KanbanBoard view={view} tasks={tasks} write={write} canWrite={canWrite} openTask={openTask} /> : null}
    {view && tab === 'dependencies' ? <DependenciesPanel view={view} tasks={tasks} write={write} canWrite={canWrite} /> : null}
  </div>;
}

function RoadmapTree({ view, selectedNodeId, onSelect, write, canWrite }: {
  view: RoadmapView;
  selectedNodeId: string | null;
  onSelect: (id: string) => void;
  write: Write;
  canWrite: boolean;
}): React.JSX.Element {
  const [addingGoal, setAddingGoal] = useState(false);
  const children = useMemo(() => {
    const groups = new Map<string | null, RoadmapNode[]>();
    for (const node of view.nodes) {
      const siblings = groups.get(node.parentId);
      if (siblings) siblings.push(node);
      else groups.set(node.parentId, [node]);
    }
    for (const [parent, rows] of groups) groups.set(parent, byPosition(rows));
    return groups;
  }, [view.nodes]);
  const branch = (node: RoadmapNode, depth: number): React.JSX.Element => {
    const progress = view.progress[node.id];
    const readiness = view.readiness.nodes[node.id];
    return <div className="roadmap__branch" key={node.id}>
      <button
        type="button" className="roadmap__node" aria-current={selectedNodeId === node.id}
        style={{ paddingLeft: `${14 + depth * 20}px` }} onClick={() => onSelect(node.id)}
      >
        <span className={`roadmap__node-mark roadmap__node-mark--${node.kind}`} aria-hidden />
        <span className="roadmap__node-name">{node.title}</span>
        <span className="roadmap__node-count" title="Done / total tasks">{progress?.counts.done ?? 0}/{progress?.counts.total ?? 0}</span>
        {readiness?.status === 'blocked' ? <span className="roadmap__blocked" title="Blocked by a dependency">!</span> : null}
      </button>
      {(children.get(node.id) ?? []).map((child) => branch(child, depth + 1))}
    </div>;
  };
  return <Card title="Goals, phases and epics" actions={
    <button type="button" className="btn btn--sm" disabled={!canWrite} onClick={() => setAddingGoal((value) => !value)}>+ Goal</button>
  } flush>
    {addingGoal ? <div className="roadmap__create"><CreateNodeForm kind="goal" parentId={null} projectId={view.projectId} write={write} canWrite={canWrite} onDone={() => setAddingGoal(false)} /></div> : null}
    {view.nodes.length === 0 ? <Empty title="No goals yet" hint="Create a goal to organise this project's work." /> : null}
    <div className="roadmap__tree">{(children.get(null) ?? []).map((node) => branch(node, 0))}</div>
  </Card>;
}

function CreateNodeForm({ kind, parentId, projectId, write, canWrite, onDone }: {
  kind: RoadmapNodeKind;
  parentId: string | null;
  projectId: string;
  write: Write;
  canWrite: boolean;
  onDone: () => void;
}): React.JSX.Element {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  return <form className="stack" onSubmit={(event) => {
    event.preventDefault();
    void write((expectedRevision) => call('roadmap:createNode', { projectId, expectedRevision, kind, parentId, title, description }), `Creating ${kind}…`)
      .then((saved) => { if (saved) onDone(); });
  }}>
    <Field label={`New ${kind} title`}><input className="input" required maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} /></Field>
    <Field label="Description"><textarea className="textarea" rows={3} value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
    <div className="row"><button className="btn btn--primary btn--sm" type="submit" disabled={!canWrite}>Create {kind}</button><button className="btn btn--ghost btn--sm" type="button" onClick={onDone}>Cancel</button></div>
  </form>;
}

function NodeInspector({ node, view, tasks, write, canWrite, draft, onDraftChange, onDraftDiscard }: {
  node: RoadmapNode;
  view: RoadmapView;
  tasks: readonly Task[];
  write: Write;
  canWrite: boolean;
  draft: NodeDraft | null;
  onDraftChange: (draft: NodeDraft) => void;
  onDraftDiscard: () => void;
}): React.JSX.Element {
  const editor = draft ?? {
    baseRevision: view.revision,
    title: node.title,
    description: node.description,
    criteria: node.acceptanceCriteria.map((criterion) => ({ key: criterion.id, ...criterion }))
  };
  const { title, description, criteria } = editor;
  const updateDraft = (changes: Partial<NodeDraft>) => onDraftChange({ ...editor, ...changes });
  const needsDecision = draft !== null && draft.baseRevision !== view.revision;
  const [addingChild, setAddingChild] = useState(false);
  const [acknowledgment, setAcknowledgment] = useState<{ revision: number; checked: boolean } | null>(null);
  const acknowledge = acknowledgment?.revision === view.revision && acknowledgment.checked;
  const open = node.state === 'open';
  const progress = view.progress[node.id];
  const readiness = view.readiness.nodes[node.id];
  const waits = effectiveWaits(view.readiness, { kind: 'node', nodeId: node.id });
  const siblings = byPosition(view.nodes.filter((row) => row.parentId === node.parentId));
  const index = siblings.findIndex((row) => row.id === node.id);
  const childKind = node.kind === 'goal' ? 'phase' : node.kind === 'phase' ? 'epic' : null;
  const parentOptions = node.kind === 'goal' ? [] : view.nodes.filter((row) =>
    row.kind === (node.kind === 'phase' ? 'goal' : 'phase') && row.state === 'open');
  const changed = title !== node.title || description !== node.description ||
    JSON.stringify(criteria.map(({ id, text }) => [id ?? null, text])) !==
      JSON.stringify(node.acceptanceCriteria.map(({ id, text }) => [id, text]));
  const move = (parentId: string | null, position: number) =>
    void write((expectedRevision) => call('roadmap:moveNode', { projectId: view.projectId, expectedRevision, nodeId: node.id, parentId, position }), `Moving ${node.kind}…`);
  const transition = (event: 'accept' | 'cancel' | 'reopen') =>
    void write((expectedRevision) => call('roadmap:transitionNode', {
      projectId: view.projectId, expectedRevision, nodeId: node.id, event,
      ...(event === 'accept' && acknowledge ? { acknowledgeStoppedWork: true } : {})
    }), `${event === 'accept' ? 'Accepting' : event === 'cancel' ? 'Cancelling' : 'Reopening'} ${node.kind}…`);

  return <div className="stack">
    <Card title={`${node.kind[0]!.toUpperCase() + node.kind.slice(1)} details`} actions={<span className={`roadmap__state roadmap__state--${node.state}`}>{node.state}</span>}>
      <div className="stack">
        <div className="roadmap__metrics">
          <span><strong>{progress?.counts.done ?? 0}/{progress?.counts.total ?? 0}</strong> tasks done</span>
          <span><strong>{progress?.display.replaceAll('_', ' ') ?? 'empty'}</strong> progress</span>
          <span><strong>{readiness?.status ?? 'ready'}</strong> readiness</span>
        </div>
        {progress?.hasStoppedWork ? <Notice tone="warn">Stopped work: {progress.stoppedTaskIds.map((id) => tasks.find((task) => task.id === id)?.title ?? id).join(', ')}</Notice> : null}
        {needsDecision ? <Notice tone="warn">
          <strong>Your unsaved draft is from revision {draft.baseRevision}; the roadmap is now at revision {view.revision}.</strong>
          <div>Review the saved version before choosing whether to use your draft. No edit has been retried.</div>
          <details>
            <summary>Current saved details</summary>
            <div>Title: {node.title}</div>
            <div className="roadmap__saved-description">Description: {node.description || '(empty)'}</div>
            <div>Criteria: {node.acceptanceCriteria.length === 0 ? '(none)' : node.acceptanceCriteria.map((criterion) => criterion.text).join(' · ')}</div>
          </details>
          <div className="row row--wrap">
            <button type="button" className="btn btn--sm" disabled={!canWrite || !open}
              onClick={() => updateDraft({ baseRevision: view.revision })}>Use my draft</button>
            <button type="button" className="btn btn--sm btn--ghost" onClick={onDraftDiscard}>Discard draft</button>
          </div>
        </Notice> : null}
        <form className="stack" onSubmit={(event) => {
          event.preventDefault();
          void write((expectedRevision) => call('roadmap:updateNode', {
            projectId: view.projectId, expectedRevision, nodeId: node.id, title, description,
            acceptanceCriteria: criteria.map(({ id, text }) => ({ ...(id ? { id } : {}), text }))
          }), 'Saving details…').then((saved) => { if (saved) onDraftDiscard(); });
        }}>
          <Field label="Title"><input className="input" required maxLength={200} value={title} disabled={!open} onChange={(event) => updateDraft({ title: event.target.value })} /></Field>
          <Field label="Description"><textarea className="textarea" rows={4} value={description} disabled={!open} onChange={(event) => updateDraft({ description: event.target.value })} /></Field>
          <div className="field__label">Acceptance criteria</div>
          {criteria.length === 0 ? <span className="faint">No criteria recorded.</span> : null}
          {criteria.map((criterion, criterionIndex) => <div className="roadmap__criterion" key={criterion.key}>
            <input className="input" aria-label={`Criterion ${criterionIndex + 1}`} value={criterion.text} disabled={!open}
              onChange={(event) => updateDraft({ criteria: criteria.map((row) => row.key === criterion.key ? { ...row, text: event.target.value } : row) })} />
            {open ? <button type="button" className="btn btn--sm btn--ghost" aria-label={`Move criterion ${criterionIndex + 1} up`}
              disabled={criterionIndex === 0} onClick={() => {
                const reordered = [...criteria];
                [reordered[criterionIndex - 1], reordered[criterionIndex]] = [reordered[criterionIndex]!, reordered[criterionIndex - 1]!];
                updateDraft({ criteria: reordered });
              }}>↑</button> : null}
            {open ? <button type="button" className="btn btn--sm btn--ghost" aria-label={`Move criterion ${criterionIndex + 1} down`}
              disabled={criterionIndex === criteria.length - 1} onClick={() => {
                const reordered = [...criteria];
                [reordered[criterionIndex], reordered[criterionIndex + 1]] = [reordered[criterionIndex + 1]!, reordered[criterionIndex]!];
                updateDraft({ criteria: reordered });
              }}>↓</button> : null}
            {open ? <button type="button" className="btn btn--sm btn--ghost" aria-label={`Remove criterion ${criterionIndex + 1}`}
              onClick={() => updateDraft({ criteria: criteria.filter((row) => row.key !== criterion.key) })}>Remove</button> : null}
          </div>)}
          {open ? <div className="row row--wrap">
            <button type="button" className="btn btn--sm" disabled={!canWrite || criteria.length >= 50}
              onClick={() => { nextCriterionKey += 1; updateDraft({ criteria: [...criteria, { key: `new-${nextCriterionKey}`, text: '' }] }); }}>+ Criterion</button>
            <button type="submit" className="btn btn--sm btn--primary" disabled={!canWrite || needsDecision || !changed || criteria.some((row) => !row.text.trim())}>Save details</button>
          </div> : null}
        </form>
      </div>
    </Card>
    <Card title="Structure and status">
      <div className="stack">
        {childKind && open ? <div>
          <button type="button" className="btn btn--sm" disabled={!canWrite} onClick={() => setAddingChild((value) => !value)}>+ {childKind}</button>
          {addingChild ? <div className="roadmap__create"><CreateNodeForm kind={childKind} parentId={node.id} projectId={view.projectId} write={write} canWrite={canWrite} onDone={() => setAddingChild(false)} /></div> : null}
        </div> : null}
        {open ? <div className="row row--wrap">
          <button type="button" className="btn btn--sm" disabled={!canWrite || index <= 0} onClick={() => move(node.parentId, index - 1)}>Move up</button>
          <button type="button" className="btn btn--sm" disabled={!canWrite || index >= siblings.length - 1} onClick={() => move(node.parentId, index + 1)}>Move down</button>
          {parentOptions.length > 0 ? <select className="input roadmap__parent-select" aria-label="Move to parent" value={node.parentId ?? ''}
            disabled={!canWrite} onChange={(event) => {
              const parentId = event.target.value;
              if (parentId !== node.parentId) move(parentId, view.nodes.filter((row) => row.parentId === parentId).length);
            }}>
            {parentOptions.map((parent) => <option key={parent.id} value={parent.id}>{parent.title}</option>)}
          </select> : null}
        </div> : null}
        {open && progress?.hasStoppedWork ? <label className="roadmap__ack"><input type="checkbox" checked={acknowledge} onChange={(event) => setAcknowledgment({ revision: view.revision, checked: event.target.checked })} /> I acknowledge the stopped work above.</label> : null}
        <div className="row row--wrap">
          {open ? <>
            <button type="button" className="btn btn--sm btn--recommended" disabled={!canWrite || (progress?.hasStoppedWork && !acknowledge)} onClick={() => transition('accept')}>Accept {node.kind}</button>
            <button type="button" className="btn btn--sm" disabled={!canWrite} onClick={() => {
              if (window.confirm(`Cancel ${node.title}? Its history will remain visible.`)) transition('cancel');
            }}>Cancel {node.kind}</button>
            <button type="button" className="btn btn--sm btn--danger" disabled={!canWrite} onClick={() => {
              if (window.confirm(`Remove empty ${node.kind} ${node.title}?`)) {
                void write((expectedRevision) => call('roadmap:removeNode', { projectId: view.projectId, expectedRevision, nodeId: node.id }), `Removing ${node.kind}…`);
              }
            }}>Remove empty {node.kind}</button>
          </> : <button type="button" className="btn btn--sm" disabled={!canWrite} onClick={() => transition('reopen')}>Reopen {node.kind}</button>}
        </div>
        {!open ? <p className="faint">Reopen this {node.kind} before changing its contents.</p> : null}
      </div>
    </Card>
    <Card title="What this item waits for">
      <WaitList waits={waits} view={view} tasks={tasks} />
    </Card>
  </div>;
}

function WaitList({ waits, view, tasks }: {
  waits: ReturnType<typeof effectiveWaits>;
  view: RoadmapView;
  tasks: readonly Task[];
}): React.JSX.Element {
  if (waits.length === 0) return <p className="faint">No dependency is holding this item.</p>;
  return <ul className="roadmap__waits">{waits.map((wait) =>
    <li key={`${wait.dependencyId}:${wait.inheritedFrom ?? 'own'}`}>
      <span className={`roadmap__readiness roadmap__readiness--${wait.state}`}>{wait.state}</span>
      <span>{wait.resolvedPrerequisite ? itemName(wait.resolvedPrerequisite, view, tasks) : 'Unresolved continuation'}</span>
      <span className="faint">{wait.reason.replaceAll('_', ' ')}{wait.inheritedFrom ? ` · inherited from ${view.nodes.find((node) => node.id === wait.inheritedFrom)?.title ?? wait.inheritedFrom}` : ''}</span>
    </li>
  )}</ul>;
}

function KanbanBoard({ view, tasks, write, canWrite, openTask }: {
  view: RoadmapView;
  tasks: readonly Task[];
  write: Write;
  canWrite: boolean;
  openTask: (taskId: string) => void;
}): React.JSX.Element {
  const phases = byPosition(view.nodes.filter((node) => node.kind === 'phase'));
  const [phaseId, setPhaseId] = useState<string | null>(null);
  const phase = phases.find((node) => node.id === phaseId) ?? phases[0] ?? null;
  const epics = byPosition(view.nodes.filter((node) => node.kind === 'epic' && node.parentId === phase?.id));
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const factById = new Map(view.tasks.map((fact) => [fact.id, fact]));
  const placementByTask = new Map(view.placements.map((placement) => [placement.taskId, placement]));
  const placementsByEpic = new Map<string, RoadmapTaskPlacement[]>();
  for (const placement of view.placements) {
    const rows = placementsByEpic.get(placement.epicId);
    if (rows) rows.push(placement);
    else placementsByEpic.set(placement.epicId, [placement]);
  }
  const columns: { id: string | null; title: string; rows: RoadmapTaskPlacement[]; taskIds: readonly string[]; node: RoadmapNode | null }[] = [
    { id: null, title: 'Unassigned', rows: [], taskIds: view.unassignedTaskIds, node: null },
    ...epics.map((epic) => {
      const rows = byPosition(placementsByEpic.get(epic.id) ?? []);
      return { id: epic.id, title: epic.title, rows, taskIds: rows.map((row) => row.taskId), node: epic };
    })
  ];
  const destinations = byPosition(view.nodes.filter((node) => node.kind === 'epic' && node.state === 'open'));
  return <div className="stack">
    <div className="roadmap__board-toolbar">
      <div><h2>Tasks by epic</h2><p>Moving a card changes only its roadmap placement.</p></div>
      {phases.length > 0 ? <select className="input" aria-label="Phase on Kanban" value={phase?.id ?? ''} onChange={(event) => setPhaseId(event.target.value)}>
        {phases.map((row) => <option value={row.id} key={row.id}>{row.title}</option>)}
      </select> : null}
    </div>
    {phases.length === 0 ? <Notice tone="info">Create a goal and phase on the Roadmap tab to add epic columns. Existing tasks stay in Unassigned.</Notice> : null}
    <div className="roadmap__board">
      {columns.map((column) => <section className="roadmap__column" key={column.id ?? 'unassigned'}>
        <header><h3>{column.title}</h3><span>{column.taskIds.length}</span></header>
        {column.node ? <div className="roadmap__column-progress">{view.progress[column.node.id]?.counts.done ?? 0}/{view.progress[column.node.id]?.counts.total ?? 0} done · {view.readiness.nodes[column.node.id]?.status ?? 'ready'}</div> : null}
        {column.taskIds.length === 0 ? <p className="roadmap__column-empty">No tasks here.</p> : null}
        {column.taskIds.map((taskId, index) => {
          const task = taskById.get(taskId);
          const fact = factById.get(taskId);
          const placement = placementByTask.get(taskId);
          const readiness = view.readiness.tasks[taskId];
          const waits = effectiveWaits(view.readiness, { kind: 'task', taskId });
          const frozen = column.node !== null && column.node.state !== 'open';
          return <article className="roadmap__task" key={taskId}>
            <button className="roadmap__task-title" type="button" onClick={() => openTask(taskId)}>{task?.title ?? taskId}</button>
            <div className="roadmap__task-meta"><span>{task?.status ?? fact?.status ?? 'unknown'}</span><span className={`roadmap__readiness roadmap__readiness--${readiness?.status ?? 'ready'}`}>{readiness?.status ?? 'ready'}</span></div>
            <select className="input" aria-label={`Place ${task?.title ?? taskId}`} value={placement?.epicId ?? ''} disabled={!canWrite || frozen}
              onChange={(event) => {
                const epicId = event.target.value;
                if (!epicId) void write((expectedRevision) => call('roadmap:unassignTask', { projectId: view.projectId, expectedRevision, taskId }), 'Unassigning task…');
                else void write((expectedRevision) => call('roadmap:placeTask', { projectId: view.projectId, expectedRevision, taskId, epicId }), 'Placing task…');
              }}>
              <option value="">Unassigned</option>
              {destinations.map((epic) => <option key={epic.id} value={epic.id}>{epic.title}</option>)}
              {frozen && column.node ? <option value={column.node.id}>{column.node.title} (closed)</option> : null}
            </select>
            {placement && !frozen ? <div className="roadmap__task-order">
              <button className="btn btn--sm btn--ghost" type="button" disabled={!canWrite || index === 0} onClick={() =>
                void write((expectedRevision) => call('roadmap:placeTask', { projectId: view.projectId, expectedRevision, taskId, epicId: placement.epicId, position: index - 1 }), 'Moving task…')}>Up</button>
              <button className="btn btn--sm btn--ghost" type="button" disabled={!canWrite || index === column.taskIds.length - 1} onClick={() =>
                void write((expectedRevision) => call('roadmap:placeTask', { projectId: view.projectId, expectedRevision, taskId, epicId: placement.epicId, position: index + 1 }), 'Moving task…')}>Down</button>
            </div> : null}
            {frozen ? <span className="faint">Reopen the epic to move this task.</span> : null}
            {waits.length > 0 ? <details className="roadmap__task-waits"><summary>{waits.length} {waits.length === 1 ? 'wait' : 'waits'}</summary><WaitList waits={waits} view={view} tasks={tasks} /></details> : null}
          </article>;
        })}
      </section>)}
    </div>
  </div>;
}

function DependenciesPanel({ view, tasks, write, canWrite }: {
  view: RoadmapView;
  tasks: readonly Task[];
  write: Write;
  canWrite: boolean;
}): React.JSX.Element {
  const nodeNames = useMemo(() => new Map(view.nodes.map((node) => [node.id, node.title])), [view.nodes]);
  const taskNames = useMemo(() => new Map(tasks.map((task) => [task.id, task.title])), [tasks]);
  const options: { ref: RoadmapItemRef; label: string }[] = useMemo(() => [
    ...view.nodes.map((node) => ({ ref: { kind: 'node', nodeId: node.id } as const, label: `${node.kind}: ${node.title}` })),
    ...view.tasks.map((fact) => ({ ref: { kind: 'task', taskId: fact.id } as const, label: `task: ${taskNames.get(fact.id) ?? fact.id}` }))
  ], [view.nodes, view.tasks, taskNames]);
  const [dependent, setDependent] = useState('');
  const [prerequisite, setPrerequisite] = useState('');
  const label = (ref: RoadmapItemRef) => ref.kind === 'node'
    ? nodeNames.get(ref.nodeId) ?? ref.nodeId
    : taskNames.get(ref.taskId) ?? ref.taskId;
  return <div className="roadmap__dependencies">
    <Card title="Add dependency">
      <p className="muted">The dependent waits until the prerequisite is accepted or completed. Readiness is guidance; it does not start or stop tasks.</p>
      <form className="stack" onSubmit={(event) => {
        event.preventDefault();
        if (!dependent || !prerequisite) return;
        void write((expectedRevision) => call('roadmap:addDependency', {
          projectId: view.projectId, expectedRevision, dependent: itemFromKey(dependent), prerequisite: itemFromKey(prerequisite)
        }), 'Adding dependency…').then((saved) => { if (saved) { setDependent(''); setPrerequisite(''); } });
      }}>
        <Field label="Dependent"><select className="input" required value={dependent} onChange={(event) => setDependent(event.target.value)}>
          <option value="">Choose an item</option>{options.map(({ ref, label }) => <option value={itemKey(ref)} key={itemKey(ref)}>{label}</option>)}
        </select></Field>
        <Field label="Waits for"><select className="input" required value={prerequisite} onChange={(event) => setPrerequisite(event.target.value)}>
          <option value="">Choose an item</option>{options.map(({ ref, label }) => <option value={itemKey(ref)} key={itemKey(ref)}>{label}</option>)}
        </select></Field>
        <button className="btn btn--primary" type="submit" disabled={!canWrite || !dependent || !prerequisite || dependent === prerequisite}>Add dependency</button>
      </form>
    </Card>
    <Card title={`Dependencies (${view.dependencies.length})`} flush>
      {view.dependencies.length === 0 ? <Empty title="No dependencies" hint="Add one when work must wait for another item." /> : null}
      <div className="roadmap__dependency-list">{view.dependencies.map((dependency: RoadmapDependency) => {
        const judged = view.readiness.dependencies[dependency.id];
        const cyclic = view.cyclicDependencyIds.includes(dependency.id);
        return <div className="roadmap__dependency" key={dependency.id}>
          <div><strong>{label(dependency.dependent)}</strong><span className="faint"> waits for </span><strong>{label(dependency.prerequisite)}</strong>
            <div className="faint">{cyclic ? 'dependency cycle' : judged?.reason.replaceAll('_', ' ') ?? 'unknown'} · {judged?.state ?? 'unknown'}</div>
          </div>
          <button className="btn btn--sm btn--ghost" type="button" disabled={!canWrite}
            onClick={() => void write((expectedRevision) => call('roadmap:removeDependency', { projectId: view.projectId, expectedRevision, dependencyId: dependency.id }), 'Removing dependency…')}>Remove</button>
        </div>;
      })}</div>
    </Card>
  </div>;
}
