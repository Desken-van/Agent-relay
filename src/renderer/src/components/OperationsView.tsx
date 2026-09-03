/**
 * The Operations screen.
 *
 * Separate from the development workflow in every sense that matters: it is
 * reachable with no project and no task selected, it never reads or writes one,
 * and nothing on it can change anything outside Agent Relay. A probe opens a
 * database read-only and reports metadata; there is no action here that writes,
 * deploys or asks for an approval, because there is nothing to approve.
 *
 * Two rules shape most of the code below.
 *
 *  * **Nothing runs by itself.** A probe starts on a click and on nothing else —
 *    not on mount, not on selecting a target, not on a refresh, not on coming
 *    back to the screen. Rendering must never be able to start work.
 *  * **What is shown is what was stored.** Every result on screen is a persisted
 *    `OperationDiagnosticRun` read back from the database, never an object the
 *    UI assembled from what it hoped had happened.
 */

import { useEffect, useMemo, useState } from 'react';
import type { SerializedError } from '@shared/domain/errors';
import {
  OPERATION_ENVIRONMENTS,
  newOperationTargetSchema,
  operationTargetPatchSchema,
  type NewOperationTargetInput,
  type OperationTarget,
  type OperationTargetPatch
} from '@shared/domain/operations';
import {
  DIAGNOSTIC_PROBE_DESCRIPTIONS,
  DIAGNOSTIC_PROBE_IDS,
  type DiagnosticProbeId,
  type OperationDiagnosticRun
} from '@shared/domain/operations-diagnostics';
import { formatDateTime } from '../lib/format';
import {
  HISTORY_LIMIT,
  useOperations,
  type RegistrationDraft
} from '../state/operations';
import { Card, Empty, Field, Notice, Scope, Spinner } from './primitives';

/** The one sentence every run screen repeats, because it is the whole promise. */
const READ_ONLY_NOTE =
  'Read-only, metadata only. The database is opened with SQLite’s read-only flag and no row of any user table is read.';

export function OperationsView(): React.JSX.Element {
  const {
    targets,
    targetsPhase,
    targetsError,
    targetsUncertain,
    targetsComplete,
    selectedTarget,
    loadTargets,
    selectTarget
  } = useOperations();

  // The one automatic call on this screen, and it only lists registrations —
  // nothing here opens a database. It fires on `idle` and on nothing else:
  // "no data and not loading" is also true after a *failed* load, so an effect
  // keyed on that retries for ever against a backend that has just said no.
  useEffect(() => {
    if (targetsPhase === 'idle') void loadTargets();
  }, [targetsPhase, loadTargets]);

  return (
    <div className="projects">
      <div className="stack">
        <Card
          title={`Targets${targets ? ` (${targets.length})` : ''}`}
          flush
          actions={
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => void loadTargets()}
            >
              Refresh
            </button>
          }
        >
          {targetsPhase === 'loading' && targets.length === 0 ? (
            <div style={{ padding: 16 }}>
              <Spinner /> <span className="faint">Loading targets…</span>
            </div>
          ) : targetsPhase === 'error' ? (
            <div style={{ padding: 16 }}>
              {targetsUncertain ? (
                <Notice tone="warn">
                  <strong>The list did not come back.</strong> {targetsUncertain} What is
                  registered is unknown until this succeeds.
                </Notice>
              ) : (
                <Notice tone="error">
                  <strong>Could not load targets.</strong> {targetsError?.message}
                </Notice>
              )}
              {/* The only way back: nothing retries on its own. */}
              <button
                type="button"
                className="btn btn--sm"
                style={{ marginTop: 10 }}
                onClick={() => void loadTargets()}
              >
                Try again
              </button>
            </div>
          ) : targets.length === 0 && targetsComplete ? (
            <Empty
              title="No targets registered"
              hint="Register a local SQLite database to inspect it."
            />
          ) : (
            <div className="list">
              {/*
                A first read that a write overtook leaves only what that write
                added. Showing it as the registry would hide every existing
                registration behind a list that looks complete.
              */}
              {targetsComplete ? null : (
                <div style={{ padding: '12px 16px' }}>
                  <Notice tone="warn">
                    <strong>This list is incomplete.</strong> The first read of the
                    registry was overtaken by a change, so registrations may be
                    missing. Refresh to read it again.
                  </Notice>
                </div>
              )}
              {targets.map((target) => (
                <button
                  key={target.id}
                  type="button"
                  className="list__item"
                  aria-selected={target.id === selectedTarget?.id}
                  onClick={() => selectTarget(target.id)}
                >
                  <div className="list__name">
                    {target.name}
                    {target.enabled ? null : <span className="tag" style={{ marginLeft: 8 }}>Disabled</span>}
                  </div>
                  <div className="list__meta">
                    {target.environment} · {target.config.databasePath}
                  </div>
                </button>
              ))}
            </div>
          )}
        </Card>

        <Card title="Register a target">
          <RegisterForm />
        </Card>
      </div>

      <div className="stack">
        {selectedTarget ? (
          // Keyed by target: the editor's draft and the run panel's choice are
          // per target by construction, so a slow answer for one can never be
          // painted into another's form.
          <TargetPanel key={selectedTarget.id} target={selectedTarget} />
        ) : (
          <Empty
            title="No target selected"
            hint="Choose a target to inspect it, or register one."
          />
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Registering                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The registration form's fields.
 *
 * Defined by the provider rather than here: an unresolved create keeps its
 * draft there, so navigating away and back does not make the operator retype
 * a registration whose fate is still unknown.
 */
type Draft = RegistrationDraft;

const EMPTY_DRAFT: Draft = { name: '', environment: '', databasePath: '' };

/**
 * Validate a draft with the shared schema.
 *
 * The renderer owns no rules of its own: the same schema the IPC layer parses
 * against decides whether Save is available, so the button can never be enabled
 * for something the main process is about to refuse.
 */
function validateDraft(
  draft: Draft
): { ok: true; value: NewOperationTargetInput } | { ok: false; message: string } {
  if (draft.environment === '') {
    return { ok: false, message: 'Choose the environment this target belongs to.' };
  }

  const parsed = newOperationTargetSchema.safeParse({
    name: draft.name,
    environment: draft.environment,
    config: { version: 1, adapterType: 'local_sqlite', databasePath: draft.databasePath }
  });

  if (parsed.success) return { ok: true, value: parsed.data };

  const issue = parsed.error.issues[0];
  return { ok: false, message: issue?.message ?? 'This target is not valid.' };
}

function RegisterForm(): React.JSX.Element {
  const {
    createTarget,
    creating,
    createDraft,
    setCreateDraft,
    createUnconfirmed,
    targetsComplete,
    rereadRegistry
  } = useOperations();
  // Held in the provider, so an unresolved create survives this form being
  // unmounted by navigation and the operator does not retype it.
  const draft = createDraft ?? EMPTY_DRAFT;
  const setDraft = (next: Draft | ((current: Draft) => Draft)): void =>
    setCreateDraft(typeof next === 'function' ? next(draft) : next);
  const [saving, setSaving] = useState(false);
  // This form's own error, so a refusal from somewhere else on the screen
  // cannot appear here as a reason this target could not be saved.
  const [error, setError] = useState<SerializedError | null>(null);

  const dirty =
    draft.name !== '' || draft.environment !== '' || draft.databasePath !== '';
  const validation = validateDraft(draft);
  // `creating` and `createUnconfirmed` are the provider's own, so a second Save
  // is refused even if this component was remounted while the first was still
  // in the air or still unresolved. `targetsComplete` is the narrow fix for a
  // create racing the very first list read: until the registry has been read
  // once in full, there is nothing to add a registration to safely.
  const canSave =
    dirty &&
    validation.ok &&
    !saving &&
    !creating &&
    createUnconfirmed === null &&
    targetsComplete;

  return (
    <form
      className="stack stack--tight"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSave || !validation.ok) return;

        setSaving(true);
        setError(null);
        void (async () => {
          const outcome = await createTarget(validation.value);
          setSaving(false);
          // The draft survives anything but a confirmed success — including an
          // outcome nobody knows, where clearing the form would suggest the
          // target had been registered.
          if (outcome.ok) setCreateDraft(null);
          else setError(outcome.error);
        })();
      }}
    >
      <Field label="Name">
        <input
          className="input"
          aria-label="Name"
          value={draft.name}
          maxLength={200}
          onChange={(event) => {
            setError(null);
            setDraft((current) => ({ ...current, name: event.target.value }));
          }}
        />
      </Field>

      <Field
        label="Environment"
        hint="Stated, never guessed — a name or a path that says “production” proves nothing."
      >
        <select
          className="select"
          aria-label="Environment"
          value={draft.environment}
          onChange={(event) => {
            setError(null);
            setDraft((current) => ({
              ...current,
              environment: event.target.value as Draft['environment']
            }));
          }}
        >
          <option value="">Choose…</option>
          {OPERATION_ENVIRONMENTS.map((environment) => (
            <option key={environment} value={environment}>
              {environment}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Adapter">
        <input className="input" value="local_sqlite" readOnly aria-label="Adapter" />
      </Field>

      <Field label="Database path" hint="An absolute path to a SQLite file on this machine.">
        <input
          className="input input--mono"
          aria-label="Database path"
          value={draft.databasePath}
          onChange={(event) => {
            setError(null);
            setDraft((current) => ({ ...current, databasePath: event.target.value }));
          }}
        />
      </Field>

      {dirty && !validation.ok ? <Notice tone="warn">{validation.message}</Notice> : null}
      {targetsComplete ? null : (
        <Notice tone="warn">
          The registry has not been read in full yet. Registering now could hide
          existing targets behind a partial list, so this waits for a complete
          read.
        </Notice>
      )}
      {createUnconfirmed ? (
        <div className="stack stack--tight">
          <Notice tone="warn">
            <strong>The last registration was not confirmed.</strong> Whether it was
            applied is unknown, and the registry could not be re-read. Your entry has
            been kept. Nothing was submitted again.
          </Notice>
          <div>
            {/* The safe half of the operation, and only that half. */}
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => void rereadRegistry()}
            >
              Re-read the registry
            </button>
          </div>
        </div>
      ) : null}
      {error ? <WriteErrorNotice error={error} /> : null}

      <div className="row">
        <button type="submit" className="btn btn--primary" disabled={!canSave}>
          <Scope kind="local" />
          {saving ? 'Saving…' : 'Register target'}
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          disabled={!dirty || saving}
          onClick={() => {
            setError(null);
            setCreateDraft(null);
          }}
        >
          Clear
        </button>
      </div>
    </form>
  );
}

function WriteErrorNotice({ error }: { error: SerializedError }): React.JSX.Element {
  return (
    <Notice tone="error">
      <div>{error.message}</div>
      {error.remediation ? <div className="faint">{error.remediation}</div> : null}
    </Notice>
  );
}

/* -------------------------------------------------------------------------- */
/* One target                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Why this target cannot be acted on, and the safe way forward.
 *
 * Only rendered for the two states that are not merely transient: a run the
 * backend is still executing, and an outcome nobody has confirmed. A spinner
 * on its own would say "wait" without saying what for, or for how long.
 */
function BlockNotice({ target }: { target: OperationTarget }): React.JSX.Element | null {
  const {
    backendRuns,
    unconfirmed,
    reconciling,
    blockedReason,
    loadHistory,
    rereadRegistry,
    stopTrackingRun
  } = useOperations();

  const backendRun = backendRuns[target.id];
  const doubt = unconfirmed[target.id];
  if (backendRun === undefined && doubt === undefined) return null;

  const reason = blockedReason(target.id);

  return (
    <Card title="This target is in use">
      <Notice tone="warn">{reason}</Notice>
      <p className="faint">
        Running a diagnostic, editing, disabling and removing are unavailable
        until this is resolved. Nothing is retried automatically.
      </p>
      <div className="row" style={{ marginTop: 10 }}>
        {backendRun ? (
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void loadHistory(target.id)}
          >
            <Scope kind="read" />
            Refresh history
          </button>
        ) : null}
        {/* Not offered while a read is already in flight: there is nothing to
            retry until that one has said something. */}
        {doubt && reconciling[target.id] !== true ? (
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => void rereadRegistry(target.id)}
          >
            <Scope kind="read" />
            Re-read the registry
          </button>
        ) : null}
        {backendRun?.searchedDeeply ? (
          // The last resort, offered only once a search to the channel's
          // deepest page has already failed to account for the run. Without it
          // a run that finished and then scrolled out of reach would lock this
          // target for the life of the window.
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => stopTrackingRun(target.id)}
          >
            Stop tracking this run
          </button>
        ) : null}
      </div>
    </Card>
  );
}

function TargetPanel({ target }: { target: OperationTarget }): React.JSX.Element {
  return (
    <>
      <BlockNotice target={target} />
      <TargetEditor target={target} />
      <RunPanel target={target} />
      <ResultPanel target={target} />
      <HistoryPanel target={target} />
    </>
  );
}

function TargetEditor({ target }: { target: OperationTarget }): React.JSX.Element {
  const { updateTarget, deleteTarget, isBusy } = useOperations();
  // This panel's own error, for the same reason the registration form keeps
  // its own: a refusal here must not appear anywhere else on the screen.
  const [writeError, setWriteError] = useState<SerializedError | null>(null);
  const clearWriteError = (): void => setWriteError(null);

  const original: Draft = useMemo(
    () => ({
      name: target.name,
      environment: target.environment,
      databasePath: target.config.databasePath
    }),
    [target]
  );

  const [draft, setDraft] = useState<Draft>(original);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Provider-level, so it survives this component being unmounted and
  // remounted, and covers a probe as well as a write.
  const busy = isBusy(target.id);
  const dirty =
    draft.name !== original.name ||
    draft.environment !== original.environment ||
    draft.databasePath !== original.databasePath;

  const validation = validateDraft(draft);
  const canSave = editing && dirty && validation.ok && !saving && !busy;

  return (
    <Card
      title={target.name}
      actions={
        <span className="tag">{target.enabled ? 'Enabled' : 'Disabled'}</span>
      }
    >
      {editing ? (
        <form
          className="stack stack--tight"
          onSubmit={(event) => {
            event.preventDefault();
            if (!canSave || !validation.ok) return;

            setSaving(true);
            void (async () => {
              const parsed = operationTargetPatchSchema.safeParse({
                name: draft.name,
                environment: draft.environment,
                config: {
                  version: 1,
                  adapterType: 'local_sqlite',
                  databasePath: draft.databasePath
                }
              });
              if (!parsed.success) {
                setSaving(false);
                return;
              }

              const patch: OperationTargetPatch = parsed.data;
              const outcome = await updateTarget(target.id, patch);
              setSaving(false);
              // Only a success closes the editor; a refusal keeps the draft
              // exactly as the operator left it.
              if (outcome.ok) setEditing(false);
              else setWriteError(outcome.error);
            })();
          }}
        >
          <Field label="Name">
            <input
              className="input"
              aria-label="Name"
              value={draft.name}
              maxLength={200}
              onChange={(event) => {
                clearWriteError();
                setDraft((current) => ({ ...current, name: event.target.value }));
              }}
            />
          </Field>

          <Field label="Environment">
            <select
              className="select"
              aria-label="Environment"
              value={draft.environment}
              onChange={(event) => {
                clearWriteError();
                setDraft((current) => ({
                  ...current,
                  environment: event.target.value as Draft['environment']
                }));
              }}
            >
              <option value="">Choose…</option>
              {OPERATION_ENVIRONMENTS.map((environment) => (
                <option key={environment} value={environment}>
                  {environment}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Database path">
            <input
              className="input input--mono"
              aria-label="Database path"
              value={draft.databasePath}
              onChange={(event) => {
                clearWriteError();
                setDraft((current) => ({ ...current, databasePath: event.target.value }));
              }}
            />
          </Field>

          {dirty && !validation.ok ? <Notice tone="warn">{validation.message}</Notice> : null}
          {writeError ? <WriteErrorNotice error={writeError} /> : null}

          <div className="row">
            <button type="submit" className="btn btn--primary" disabled={!canSave}>
              <Scope kind="local" />
              {saving ? 'Saving…' : 'Save changes'}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={saving}
              onClick={() => {
                // Cancelling writes nothing and restores what is stored.
                clearWriteError();
                setDraft(original);
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="kv">
            <span className="kv__k">Environment</span>
            <span className="kv__v">{target.environment}</span>
            <span className="kv__k">Adapter</span>
            <span className="kv__v">{target.adapterType}</span>
            <span className="kv__k">Database path</span>
            <span className="kv__v mono">{target.config.databasePath}</span>
            <span className="kv__k">Registered</span>
            <span className="kv__v">{formatDateTime(target.createdAt)}</span>
          </div>

          {writeError ? (
            <div style={{ marginTop: 12 }}>
              {/*
                The backend's own message and remediation, verbatim and once.
                Restating the advice here would be a second copy of a sentence
                the registry already owns, and the two would eventually disagree.
              */}
              <WriteErrorNotice error={writeError} />
            </div>
          ) : null}

          <div className="row" style={{ marginTop: 14 }}>
            <button
              type="button"
              className="btn btn--sm"
              disabled={busy}
              onClick={() => {
                clearWriteError();
                setDraft(original);
                setEditing(true);
              }}
            >
              Edit
            </button>

            <button
              type="button"
              className="btn btn--sm"
              disabled={busy}
              onClick={() => {
                clearWriteError();
                void (async () => {
                  const outcome = await updateTarget(target.id, { enabled: !target.enabled });
                  if (!outcome.ok) setWriteError(outcome.error);
                })();
              }}
            >
              {target.enabled ? 'Disable' : 'Enable'}
            </button>

            {confirmingDelete ? null : (
              <button
                type="button"
                className="btn btn--sm btn--danger"
                disabled={busy}
                onClick={() => {
                  clearWriteError();
                  setConfirmingDelete(true);
                }}
              >
                Remove registration
              </button>
            )}
          </div>

          {confirmingDelete ? (
            <div style={{ marginTop: 12 }}>
              <Notice tone="warn">
                This removes the registration from Agent Relay only. The SQLite file at{' '}
                <span className="mono">{target.config.databasePath}</span> is not touched, moved or
                deleted.
              </Notice>
              <div className="row" style={{ marginTop: 10 }}>
                <button
                  type="button"
                  className="btn btn--sm btn--danger"
                  disabled={busy}
                  onClick={() => {
                    void (async () => {
                      const outcome = await deleteTarget(target.id);
                      // A refusal leaves the panel exactly as it was, with the
                      // backend's reason on screen.
                      if (outcome.ok) setConfirmingDelete(false);
                      else setWriteError(outcome.error);
                    })();
                  }}
                >
                  Yes, remove the registration
                </button>
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  onClick={() => setConfirmingDelete(false)}
                >
                  Keep it
                </button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Running a probe                                                             */
/* -------------------------------------------------------------------------- */

function RunPanel({ target }: { target: OperationTarget }): React.JSX.Element {
  const { runDiagnostic, running, uncertain, runError, isBusy } = useOperations();
  const [probeId, setProbeId] = useState<DiagnosticProbeId>('connection_health');

  const probing = running[target.id] === true;
  // Any action for this target blocks a probe, not just another probe: a
  // target being re-pointed is not a target worth reading, and a run the
  // backend is still executing is not one to start again.
  const busy = isBusy(target.id);
  const note = uncertain[target.id];

  return (
    <Card title="Run a diagnostic">
      <Field label="Diagnostic">
        <select
          className="select"
          aria-label="Diagnostic"
          value={probeId}
          disabled={busy}

          onChange={(event) => setProbeId(event.target.value as DiagnosticProbeId)}
        >
          {DIAGNOSTIC_PROBE_IDS.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </Field>

      <p className="faint" style={{ marginTop: -4 }}>
        {DIAGNOSTIC_PROBE_DESCRIPTIONS[probeId]}
      </p>

      {/* Exactly what is about to be inspected, before anything is inspected. */}
      <div className="kv" style={{ marginTop: 10 }}>
        <span className="kv__k">Target</span>
        <span className="kv__v">{target.name}</span>
        <span className="kv__k">Environment</span>
        <span className="kv__v">{target.environment}</span>
        <span className="kv__k">Database path</span>
        <span className="kv__v mono">{target.config.databasePath}</span>
        <span className="kv__k">Diagnostic</span>
        <span className="kv__v">{probeId}</span>
      </div>

      <div style={{ marginTop: 12 }}>
        <Notice tone="info">{READ_ONLY_NOTE}</Notice>
      </div>

      {target.enabled ? null : (
        <Notice tone="warn">This target is disabled. Enable it before running a diagnostic.</Notice>
      )}

      {note ? (
        <Notice tone="warn">
          <strong>The request did not come back.</strong> {note} Whether the diagnostic ran is
          unknown — the history below is what the application has on record. Nothing was retried
          automatically.
        </Notice>
      ) : null}

      {runError[target.id] ? <WriteErrorNotice error={runError[target.id]!} /> : null}

      <div className="row" style={{ marginTop: 12 }}>
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy || !target.enabled}
          onClick={() => void runDiagnostic(target.id, probeId)}
        >
          <Scope kind="read" />
          {probing ? 'Running…' : busy ? 'Waiting…' : 'Run diagnostic'}
        </button>
        {busy ? <Spinner /> : null}
      </div>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Results                                                                     */
/* -------------------------------------------------------------------------- */

/** A value that may genuinely be unknown, rendered as unknown rather than as 0 or false. */
function Unknown({ value }: { value: string | number | null }): React.JSX.Element {
  if (value === null) return <span className="faint">unknown</span>;
  return <>{String(value)}</>;
}

function statusTone(run: OperationDiagnosticRun): string {
  if (run.status === 'succeeded') return 'tag tag--ok';
  if (run.status === 'running') return 'tag tag--warn';
  return 'tag tag--danger';
}

function ResultPanel({ target }: { target: OperationTarget }): React.JSX.Element | null {
  const { lastRun } = useOperations();
  const run = lastRun[target.id];
  if (!run) return null;

  return (
    <Card title="Latest result">
      <RunDetail run={run} />
    </Card>
  );
}

export function RunDetail({ run }: { run: OperationDiagnosticRun }): React.JSX.Element {
  return (
    <div className="stack stack--tight">
      <div className="kv">
        <span className="kv__k">Run</span>
        <span className="kv__v mono">{run.id}</span>
        <span className="kv__k">Diagnostic</span>
        <span className="kv__v">{run.probeId}</span>
        <span className="kv__k">Status</span>
        <span className="kv__v">
          <span className={statusTone(run)}>{run.status}</span>
        </span>
        <span className="kv__k">Started</span>
        <span className="kv__v">{formatDateTime(run.startedAt)}</span>
        <span className="kv__k">Finished</span>
        <span className="kv__v">
          {run.finishedAt === null ? <span className="faint">not finished</span> : formatDateTime(run.finishedAt)}
        </span>
      </div>

      {run.status !== 'succeeded' && run.failureKind ? (
        <Notice tone={run.failureKind === 'error' ? 'error' : 'warn'}>
          <div>
            <strong>{run.failureKind}</strong> — {run.errorMessage}
          </div>
          {run.failureKind === 'timeout' ||
          run.failureKind === 'cancelled' ||
          run.failureKind === 'malformed' ? (
            <div className="faint">
              This says the diagnostic did not finish, not that the database is unhealthy. Nothing
              was learned about the target either way.
            </div>
          ) : null}
        </Notice>
      ) : null}

      {run.result === null ? (
        run.status === 'succeeded' ? (
          <Notice tone="warn">This run is recorded as a success but carries no result.</Notice>
        ) : null
      ) : run.result.probeId === 'connection_health' ? (
        <ConnectionHealth result={run.result} />
      ) : (
        <SchemaSummary result={run.result} />
      )}

      {run.result && run.result.warnings.length > 0 ? (
        <Notice tone="warn">
          <strong>Warnings</strong>
          <ul className="bullets">
            {run.result.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
    </div>
  );
}

function ConnectionHealth({
  result
}: {
  result: Extract<OperationDiagnosticRun['result'], { probeId: 'connection_health' }>;
}): React.JSX.Element {
  return (
    <div className="kv">
      <span className="kv__k">Opened</span>
      <span className="kv__v">{result.opened ? 'yes' : 'no'}</span>
      <span className="kv__k">Read-only</span>
      <span className="kv__v">{result.readOnly ? 'yes' : 'no'}</span>
      <span className="kv__k">query_only</span>
      <span className="kv__v">{result.queryOnly ? 'yes' : 'no'}</span>
      <span className="kv__k">SQLite version</span>
      <span className="kv__v">
        <Unknown value={result.sqliteVersion} />
      </span>
      <span className="kv__k">File exists</span>
      <span className="kv__v">{result.fileExists ? 'yes' : 'no'}</span>
      <span className="kv__k">File readable</span>
      <span className="kv__v">{result.fileReadable ? 'yes' : 'no'}</span>
      <span className="kv__k">File size</span>
      <span className="kv__v">
        {result.fileSizeBytes === null ? (
          <span className="faint">unknown</span>
        ) : (
          `${result.fileSizeBytes} bytes`
        )}
      </span>
      <span className="kv__k">File modified</span>
      <span className="kv__v">
        {result.fileModifiedAt === null ? (
          <span className="faint">unknown</span>
        ) : (
          formatDateTime(result.fileModifiedAt)
        )}
      </span>
      <span className="kv__k">Duration</span>
      <span className="kv__v">{result.durationMs} ms</span>
    </div>
  );
}

function SchemaSummary({
  result
}: {
  result: Extract<OperationDiagnosticRun['result'], { probeId: 'schema_summary' }>;
}): React.JSX.Element {
  return (
    <div className="stack stack--tight">
      <div className="kv">
        <span className="kv__k">Tables listed</span>
        <span className="kv__v">{result.tables.length}</span>
        <span className="kv__k">Tables omitted</span>
        <span className="kv__v">{result.omittedTables}</span>
        <span className="kv__k">Columns omitted</span>
        <span className="kv__v">{result.omittedColumns}</span>
        <span className="kv__k">Duration</span>
        <span className="kv__v">{result.durationMs} ms</span>
      </div>

      {result.truncated ? (
        <Notice tone="warn">
          <strong>This summary is incomplete.</strong> {result.omittedTables} table(s) and{' '}
          {result.omittedColumns} column(s) were left out because the run's limits were reached.
        </Notice>
      ) : null}

      {result.tables.length === 0 ? (
        <p className="faint">No user tables were listed.</p>
      ) : (
        result.tables.map((table) => (
          <div key={table.name} className="card" style={{ marginTop: 6 }}>
            <div className="card__head">
              <span className="card__title mono">{table.name}</span>
              {table.omittedColumns > 0 ? (
                <span className="tag tag--warn">{table.omittedColumns} column(s) omitted</span>
              ) : null}
            </div>
            <div className="card__body">
              {table.columns.length === 0 ? (
                <p className="faint">No columns listed for this table.</p>
              ) : (
                <div className="list">
                  {table.columns.map((column) => (
                    <div key={column.name} className="filerow">
                      <span className="filerow__path mono">{column.name}</span>
                      <span className="filerow__stat">
                        {column.declaredType || '—'}
                        {column.primaryKey ? ' · primary key' : ''}
                        {column.nullable ? ' · nullable' : ' · not null'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* History                                                                     */
/* -------------------------------------------------------------------------- */

function HistoryPanel({ target }: { target: OperationTarget }): React.JSX.Element {
  const { history, historyPhase, historyError, loadHistory } = useOperations();
  const runs = history[target.id];
  const phase = historyPhase[target.id] ?? 'idle';
  const error = historyError[target.id];

  // Reading the recorded history is not running anything: it is the one call
  // this panel makes, and it opens no database. Phase-driven for the same
  // reason as the target list — a failed read must not re-fire on every
  // render — and kept per target, so one target's failure says nothing about
  // another's.
  useEffect(() => {
    if (phase === 'idle') void loadHistory(target.id);
  }, [phase, loadHistory, target.id]);

  return (
    <Card
      title="History"
      actions={
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={() => void loadHistory(target.id)}
        >
          Refresh
        </button>
      }
    >
      {phase === 'loading' && runs === undefined ? (
        <div>
          <Spinner /> <span className="faint">Loading history…</span>
        </div>
      ) : phase === 'error' ? (
        <Notice tone="error">Could not load the history. {error?.message}</Notice>
      ) : (runs ?? []).length === 0 ? (
        <Empty title="No diagnostics recorded" hint="Run one to see it here." />
      ) : (
        <div className="stack stack--tight">
          <p className="faint">
            Showing the last {HISTORY_LIMIT} runs, newest first. This is not the whole history.
          </p>
          {(runs ?? []).map((run) => (
            <details key={run.id} className="card">
              <summary className="card__head" style={{ cursor: 'pointer' }}>
                <span className="card__title">{run.probeId}</span>
                <span className={statusTone(run)}>{run.status}</span>
                <span className="faint">{formatDateTime(run.startedAt)}</span>
                {/*
                  The environment comes from the result, not from the target as
                  it is configured today: a target renamed or re-pointed after
                  the fact must not relabel what an older run actually looked at.
                */}
                <span className="faint">
                  {run.result ? run.result.environment : <span className="faint">environment not recorded</span>}
                </span>
              </summary>
              <div className="card__body">
                <RunDetail run={run} />
              </div>
            </details>
          ))}
        </div>
      )}
    </Card>
  );
}
