import { useEffect, useState } from 'react';
import { CLAUDE_MODEL_ALIASES } from '@shared/domain/models';
import {
  choiceFromModel,
  choiceToModel,
  isChoiceIncomplete,
  type ModelChoice
} from '@shared/domain/model-choice';
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
    settings,
    codexModels,
    codexModelsLoading,
    refreshCodexModels
  } = useStore();

  const [title, setTitle] = useState('');
  const [request, setRequest] = useState('');

  // The round budget is derived, not synchronised: the settings ceiling is the
  // default, and an explicit choice is clamped to it. Lowering the ceiling in
  // Settings therefore takes effect immediately without a sync effect.
  const maxRounds = settings?.maxReviewRounds ?? 3;
  const [chosenRounds, setChosenRounds] = useState<number | null>(null);
  const rounds = Math.min(chosenRounds ?? maxRounds, maxRounds);

  // `null` means "untouched": the picker follows the current Settings default,
  // and re-derives when the catalogue arrives so a known slug shows as a named
  // preset rather than Custom. The moment the user picks anything, their choice
  // is stored and a later catalogue update cannot overwrite it.
  const [codexChoice, setCodexChoice] = useState<ModelChoice | null>(null);
  const [claudeChoice, setClaudeChoice] = useState<ModelChoice | null>(null);

  const codexPresets = (codexModels?.models ?? []).map((option) => ({
    value: option.model,
    label: option.isDefault ? `${option.displayName} (default)` : option.displayName
  }));

  const codexSelection =
    codexChoice ?? choiceFromModel(settings?.codexModel ?? null, codexPresets);
  const claudeSelection =
    claudeChoice ?? choiceFromModel(settings?.claudeModel ?? null, CLAUDE_MODEL_ALIASES);

  const codexModel = choiceToModel(codexSelection);
  const claudeModel = choiceToModel(claudeSelection);

  // An empty Custom box is not the same as Tool default, so it blocks Create
  // instead of quietly submitting null.
  const modelsIncomplete =
    isChoiceIncomplete(codexSelection) || isChoiceIncomplete(claudeSelection);

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
                      <span
                        className="mono"
                        title={`Codex: ${task.codexModel ?? 'Tool default'} · Claude: ${task.claudeModel ?? 'Tool default'}`}
                      >
                        {codexModelLabel(task.codexModel, codexModels?.models ?? [])} /{' '}
                        {task.claudeModel ?? 'default'}
                      </span>
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

            <ModelPicker
              label="Codex model — specification + review"
              hint="Fixed for the life of the task. Its Codex thread is resumed for every review, so the model cannot change later."
              presets={codexPresets}
              choice={codexSelection}
              onChange={setCodexChoice}
              footer={
                codexModels && !codexModels.available ? (
                  <Notice tone="warn">
                    {codexModels.detail ?? 'The Codex model list is unavailable.'} You can still
                    choose <strong>Tool default</strong> or type an exact model ID.{' '}
                    <button
                      type="button"
                      className="btn btn--sm btn--ghost"
                      disabled={codexModelsLoading}
                      onClick={() => void refreshCodexModels(true)}
                    >
                      {codexModelsLoading ? 'Retrying…' : 'Retry'}
                    </button>
                  </Notice>
                ) : (
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost"
                    disabled={codexModelsLoading}
                    onClick={() => void refreshCodexModels(true)}
                  >
                    {codexModelsLoading ? 'Refreshing…' : 'Refresh models'}
                  </button>
                )
              }
            />

            <ModelPicker
              label="Claude model — implementation + corrections"
              hint="Fixed for the life of the task. Availability depends on your Claude account, not on this list."
              presets={CLAUDE_MODEL_ALIASES}
              choice={claudeSelection}
              onChange={setClaudeChoice}
            />

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
              disabled={!title.trim() || !request.trim() || modelsIncomplete}
              onClick={() =>
                void perform('create-task', 'Could not create the task', async () => {
                  const task = await expect('tasks:create', {
                    projectId: selectedProject.id,
                    title: title.trim(),
                    originalRequest: request.trim(),
                    maxRounds: rounds,
                    // Always the actual choice, never omitted: sending `null`
                    // for "Tool default" is what stops a configured Settings
                    // default from being inherited against the user's wish.
                    codexModel,
                    claudeModel
                  });
                  setTitle('');
                  setRequest('');
                  // Back to whatever Settings currently defaults to.
                  setCodexChoice(null);
                  setClaudeChoice(null);
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

/** Sentinel values for the two non-model entries in the dropdown. */
const TOOL_DEFAULT = '__tool_default__';
const CUSTOM = '__custom__';

/**
 * A model chooser: tool default, a preset, or an exact id typed by hand.
 *
 * Fully controlled — the mode lives in the parent alongside the value, so there
 * is no local state to drift out of step with a catalogue that loads later or a
 * form that gets reset.
 *
 * `presets` is a convenience list, never a validation allow-list: a model the
 * list has never heard of is a legitimate choice, and only the tool knows what
 * an account may actually use. An empty `presets` still gives a usable picker.
 */
function ModelPicker({
  label,
  hint,
  presets,
  choice,
  onChange,
  footer
}: {
  label: string;
  hint: string;
  presets: readonly { readonly value: string; readonly label: string }[];
  choice: ModelChoice;
  onChange: (next: ModelChoice) => void;
  footer?: React.ReactNode;
}): React.JSX.Element {
  const selected =
    choice.kind === 'default' ? TOOL_DEFAULT : choice.kind === 'preset' ? choice.value : CUSTOM;

  return (
    <Field label={label} hint={hint}>
      <select
        className="input"
        value={selected}
        onChange={(e) => {
          const next = e.target.value;
          if (next === TOOL_DEFAULT) onChange({ kind: 'default' });
          else if (next === CUSTOM) onChange({ kind: 'custom', draft: '' });
          else onChange({ kind: 'preset', value: next });
        }}
      >
        <option value={TOOL_DEFAULT}>Tool default</option>
        {presets.map((preset) => (
          <option key={preset.value} value={preset.value}>
            {preset.label}
          </option>
        ))}
        <option value={CUSTOM}>Custom model ID…</option>
      </select>

      {choice.kind === 'custom' ? (
        <>
          <input
            className="input input--mono"
            placeholder="exact model id, e.g. gpt-5.6-sol"
            value={choice.draft}
            spellCheck={false}
            // Stored untrimmed so typing a space does not fight the caret; the
            // trim happens in choiceToModel and again in the IPC schema.
            onChange={(e) => onChange({ kind: 'custom', draft: e.target.value })}
          />
          {isChoiceIncomplete(choice) ? (
            <div className="faint" style={{ fontSize: 12 }}>
              Enter a model ID, or choose <strong>Tool default</strong>.
            </div>
          ) : null}
        </>
      ) : null}
      {footer}
    </Field>
  );
}

/**
 * Show a model the way the user chose it: the catalogue's display name when we
 * recognise the slug, the raw slug when we do not (an old task, a hand-typed
 * id, or an unreachable catalogue), and "default" for no override.
 */
export function codexModelLabel(
  model: string | null,
  catalogue: readonly { readonly model: string; readonly displayName: string }[]
): string {
  if (model === null) return 'default';
  return catalogue.find((option) => option.model === model)?.displayName ?? model;
}
