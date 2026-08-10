import { useEffect, useState } from 'react';
import { expect } from '../lib/api';
import { formatDateTime, truncateMiddle } from '../lib/format';
import { useStore } from '../state/store';
import { Card, Empty, Field, Notice, Rounds, Scope, StatusBadge } from './primitives';

export function TasksView(): React.JSX.Element {
  const {
    selectedProject,
    tasks,
    selectedTaskId,
    selectTask,
    setSection,
    refreshTasks,
    perform,
    notify,
    settings
  } = useStore();

  const [title, setTitle] = useState('');
  const [request, setRequest] = useState('');

  // The round budget is derived, not synchronised: the settings ceiling is the
  // default, and an explicit choice is clamped to it. Lowering the ceiling in
  // Settings therefore takes effect immediately without a sync effect.
  const maxRounds = settings?.maxReviewRounds ?? 3;
  const [chosenRounds, setChosenRounds] = useState<number | null>(null);
  const rounds = Math.min(chosenRounds ?? maxRounds, maxRounds);

  useEffect(() => {
    if (selectedProject) void refreshTasks(selectedProject.id);
  }, [selectedProject, refreshTasks]);

  if (!selectedProject) {
    return (
      <Card>
        <Empty title="No project selected" hint="Pick one on the Projects screen first." />
      </Card>
    );
  }

  return (
    <div className="content--split" style={{ display: 'grid' }}>
      <div className="stack">
        <Card
          title={`Tasks in ${selectedProject.name}`}
          flush
          actions={
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => void refreshTasks(selectedProject.id)}
            >
              Refresh
            </button>
          }
        >
          {tasks.length === 0 ? (
            <Empty title="No tasks yet" hint="Describe what you want built, on the right." />
          ) : (
            <div className="list">
              {tasks.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  className="taskrow"
                  aria-selected={task.id === selectedTaskId}
                  onClick={() => selectTask(task.id)}
                  onDoubleClick={() => {
                    selectTask(task.id);
                    setSection('run');
                  }}
                >
                  <div className="taskrow__main">
                    <div className="taskrow__title">{task.title}</div>
                    <div className="taskrow__meta">
                      <span>{formatDateTime(task.createdAt)}</span>
                      {task.branchName ? (
                        <span className="mono">{truncateMiddle(task.branchName, 38)}</span>
                      ) : null}
                      {task.codexThreadId ? <span title="Codex thread stored">codex ✓</span> : null}
                      {task.claudeSessionId ? <span title="Claude session stored">claude ✓</span> : null}
                    </div>
                  </div>
                  <Rounds used={task.currentRound} max={task.maxRounds} />
                  <StatusBadge status={task.status} />
                </button>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div className="stack">
        <Card title="New task">
          <div className="stack">
            <Field label="Title" hint="A short name. Codex may refine it in the specification.">
              <input
                className="input"
                value={title}
                placeholder="Add a /health endpoint"
                onChange={(e) => setTitle(e.target.value)}
              />
            </Field>

            <Field
              label="What do you want done?"
              hint="Plain language. Codex turns this into a structured specification."
            >
              <textarea
                className="textarea"
                value={request}
                rows={9}
                placeholder="Describe the change, any constraints, and how you would know it works."
                onChange={(e) => setRequest(e.target.value)}
              />
            </Field>

            <Field
              label={`Maximum review rounds: ${rounds}`}
              hint={`The relay loop stops after this many Codex reviews. Ceiling from Settings: ${maxRounds}.`}
            >
              <input
                type="range"
                min={1}
                max={maxRounds}
                value={rounds}
                onChange={(e) => setChosenRounds(Number(e.target.value))}
              />
            </Field>

            <button
              type="button"
              className="btn btn--primary"
              disabled={!title.trim() || !request.trim()}
              onClick={() =>
                void perform('create-task', 'Could not create the task', async () => {
                  const task = await expect('tasks:create', {
                    projectId: selectedProject.id,
                    title: title.trim(),
                    originalRequest: request.trim(),
                    maxRounds: rounds
                  });
                  setTitle('');
                  setRequest('');
                  await refreshTasks(selectedProject.id);
                  selectTask(task.id);
                  setSection('run');
                  notify({ tone: 'success', title: 'Task created', body: 'Generate a specification to begin.' });
                })
              }
            >
              <Scope kind="read" /> Create task
            </button>

            <Notice tone="info">
              Creating a task writes nothing to your repository. The isolated branch and worktree are
              created later, when you send the approved specification to Claude.
            </Notice>
          </div>
        </Card>
      </div>
    </div>
  );
}
