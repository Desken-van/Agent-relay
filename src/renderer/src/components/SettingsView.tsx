import { useEffect, useMemo, useState } from 'react';
import {
  COAI_CONNECTION_PROBE_SETTINGS_KEYS,
  type CoaiConnectionDiagnostic
} from '@shared/domain/coai-diagnostics';
import type { ToolDiagnostic } from '@shared/domain/diagnostics';
import {
  resolveVerificationConfig,
  type RuleProblem
} from '@shared/domain/claude-tool-rules';
import {
  DEFAULT_CLAUDE_ALLOWED_TOOLS,
  DEFAULT_CLAUDE_VERIFICATION_TOOLS,
  clearLocalEdits,
  resetPermissionRules,
  settingsSaveState,
  type Settings
} from '@shared/domain/models';
import {
  chatTemplateParametersSchema,
  localInferenceProfilesSettingsSchema,
  type LocalInferenceProfile,
  type LocalInferenceProfilesSettings
} from '@shared/domain/local-inference';
import { containsSecretShape } from '@shared/util/redact';
import { call, expect } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { useStore, type SettingsFocus } from '../state/store';
import { LocalInferenceLifecyclePanel } from './LocalInferenceLifecyclePanel';
import { Card, Field, Notice, Spinner, ToolDot } from './primitives';

/** A unique value JSON.parse can never produce, so a parse failure is unambiguous. */
const JSON_PARSE_FAILED = Symbol('json-parse-failed');

function parseJsonOrFailure(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return JSON_PARSE_FAILED;
  }
}

/**
 * Only the fields "Recheck connection" actually exercises — read from
 * {@link COAI_CONNECTION_PROBE_SETTINGS_KEYS}, the SAME list the backend
 * probe itself is built from, rather than a second hand-maintained list here
 * that could name a different set of fields than the ones that actually
 * change what gets dialed. Compared between the saved settings and the draft
 * so the button can refuse to test a configuration the user has not saved
 * yet — see `coaiSettingsUnsaved` below.
 */
function coaiRelevantSettings(settings: Settings): unknown {
  const picked: Partial<Record<(typeof COAI_CONNECTION_PROBE_SETTINGS_KEYS)[number], unknown>> = {};
  for (const key of COAI_CONNECTION_PROBE_SETTINGS_KEYS) picked[key] = settings[key];
  return picked;
}

const TOOL_TITLES: Record<string, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  git: 'Git',
  github: 'GitHub CLI',
  ornith: 'Ornith'
};

/** Element ids of the controls another screen can send the operator to. */
const SETTINGS_FOCUS_IDS: Record<SettingsFocus, string> = { maxStoredLogBytes: 'setting-stored-log-budget' };

export function SettingsView(): React.JSX.Element {
  const { settingsFocus, clearSettingsFocus } = useStore();
  const { settings, diagnostics, refreshDiagnostics, refreshSettings, refreshCodexModels, perform, notify } =
    useStore();

  // Only the user's unsaved edits are held locally; the baseline is whatever the
  // store currently has. Deriving rather than copying means a settings refresh
  // cannot silently clobber an in-progress edit, and there is no sync effect.
  const [edits, setEdits] = useState<Settings | null>(null);
  const draft = edits ?? settings;
  // Arrived from a screen that named one control (the Run screen's output-limit notice): bring it into view
  // and focus it, once. Navigation only — nothing is read or written here. `draft` is a dependency, not
  // just `settingsFocus`, because the field this targets renders only once settings have loaded (below,
  // `{!draft ? … : …}`); an operator can reach Settings before that IPC round-trip finishes, and clearing
  // the flag on a `document.getElementById` miss then would discard the request permanently. Retrying as
  // `draft` changes catches the field the moment it mounts, without a timer.
  useEffect(() => {
    if (settingsFocus === null) return;
    const field = document.getElementById(SETTINGS_FOCUS_IDS[settingsFocus]);
    if (field === null) return;
    field.scrollIntoView?.({ block: 'center' });
    field.querySelector('input')?.focus();
    clearSettingsFocus();
  }, [settingsFocus, clearSettingsFocus, draft]);
  const [checking, setChecking] = useState(false);
  // Raw textarea contents for the permission rules, kept separately so partially
  // typed lines survive; null means "show whatever the draft holds".
  const [rulesText, setRulesText] = useState<string | null>(null);
  const [verificationText, setVerificationText] = useState<string | null>(null);
  const [mcpArgumentsText, setMcpArgumentsText] = useState<string | null>(null);
  const [conventionPathsText, setConventionPathsText] = useState<string | null>(null);
  const [fixedArgumentsText, setFixedArgumentsText] = useState<string | null>(null);
  const [chatTemplateParametersText, setChatTemplateParametersText] = useState<string | null>(null);
  // Set only while the raw JSON textarea holds text that does not parse into a
  // valid chat-template parameter map. `draft.localInference` keeps its last
  // good value in the meantime, so a typo cannot corrupt the rest of the form.
  const [chatTemplateParametersJsonError, setChatTemplateParametersJsonError] = useState<
    string | null
  >(null);
  const [coaiChecking, setCoaiChecking] = useState(false);
  const [coaiDiagnostic, setCoaiDiagnostic] = useState<CoaiConnectionDiagnostic | null>(null);
  const [coaiCheckError, setCoaiCheckError] = useState<string | null>(null);

  const checkCoaiConnection = async (): Promise<void> => {
    setCoaiChecking(true);
    setCoaiCheckError(null);
    try {
      const response = await call('coai:checkConnection', {});
      if (response.ok) {
        setCoaiDiagnostic(response.data);
      } else {
        setCoaiCheckError(response.error.message);
      }
    } finally {
      setCoaiChecking(false);
    }
  };

  const tools: ToolDiagnostic[] = diagnostics
    ? [diagnostics.codex, diagnostics.claude, diagnostics.git, diagnostics.github, diagnostics.ornith]
    : [];

  const set = <K extends keyof Settings>(key: K, value: Settings[K]): void => {
    if (!draft) return;
    setEdits({ ...draft, [key]: value });
  };

  /**
   * Verification rules that cannot be used, in the user's own words.
   *
   * Uses the same validator the main process runs before spawning Claude, so
   * the form and the gate can never disagree about what is acceptable. This is
   * a convenience, not a boundary — the main process re-checks regardless of
   * what the renderer decided.
   */
  const verificationProblems = useMemo<string[]>(() => {
    if (!draft) return [];

    const config = resolveVerificationConfig(
      draft.claudeAllowedTools,
      draft.claudeVerificationTools
    );
    if (config.ok) return [];

    return config.problems.map((problem) => {
      if (problem.code === 'empty') {
        return 'At least one verification rule is required, or no round could ever be published.';
      }
      if (problem.code === 'not_allowed') {
        return `${problem.rule ?? 'A rule'} is missing from the pre-approved list above.`;
      }
      return `${problem.rule ?? 'A rule'} ${VERIFICATION_RULE_PROBLEMS[problem.detail ?? 'syntax']}`;
    });
  }, [draft]);

  const externalReviewProblems = useMemo<string[]>(() => {
    if (!draft) return [];
    const problems: string[] = [];
    const absolute = (value: string): boolean => /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value);
    // eslint-disable-next-line no-control-regex
    const hasControl = (value: string): boolean => /[\u0000-\u001f\u007f]/.test(value);
    if (
      draft.coaiMcpExecutablePath !== null &&
      (!absolute(draft.coaiMcpExecutablePath) || hasControl(draft.coaiMcpExecutablePath))
    ) {
      problems.push('The MCP executable must be an absolute path without control characters.');
    } else if (draft.externalPlanReviewEnabled && draft.coaiMcpExecutablePath === null) {
      problems.push('Enabled external plan review requires an absolute MCP executable path.');
    }
    if (
      draft.coaiMcpArguments.some(
        (argument) =>
          hasControl(argument) ||
          /^--?(?:[^=]*[-_])?(?:token|password|passwd|secret|api[-_]?key|credential)(?:=|$)/i.test(
            argument
          )
      ) ||
      containsSecretShape(JSON.stringify(draft.coaiMcpArguments))
    ) {
      problems.push('MCP arguments cannot contain control characters or credential material.');
    }
    if (
      draft.coaiMcpWorkingDirectory !== null &&
      (!absolute(draft.coaiMcpWorkingDirectory) || hasControl(draft.coaiMcpWorkingDirectory))
    ) {
      problems.push('The MCP working directory must be an absolute path without control characters.');
    }
    if (
      draft.conventionsRepositoryPath !== null &&
      (!absolute(draft.conventionsRepositoryPath) || hasControl(draft.conventionsRepositoryPath))
    ) {
      problems.push('The conventions repository must be an absolute path without control characters.');
    }
    const conventionParts = [
      draft.conventionsRepositoryPath !== null,
      draft.conventionsExpectedRevision !== null,
      draft.conventionsRulePaths.length > 0
    ];
    if (conventionParts.some(Boolean) && !conventionParts.every(Boolean)) {
      problems.push('Conventions need a repository path, exact full revision, and selected files.');
    }
    if (
      draft.conventionsExpectedRevision !== null &&
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(draft.conventionsExpectedRevision)
    ) {
      problems.push('The conventions revision must be a full lowercase 40- or 64-character Git SHA.');
    }
    if (
      draft.conventionsRulePaths.some((path) => {
        const segments = path.split('/');
        return (
          path.includes('\\') ||
          path.includes(':') ||
          path.startsWith('/') ||
          segments.some((segment) => segment === '' || segment === '.' || segment === '..')
        );
      })
    ) {
      problems.push('Convention files must use clean repository-relative POSIX paths.');
    }
    return problems;
  }, [draft]);

  const setLocalInference = (next: LocalInferenceProfilesSettings): void => set('localInference', next);

  /** Which profile the form below edits. Defaults to the first configured one, or none if there is none yet. */
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const editingIndex = draft?.localInference.profiles.findIndex((profile) => profile.id === editingProfileId) ?? -1;
  const editingProfile = editingIndex >= 0 ? draft!.localInference.profiles[editingIndex]! : null;

  /** A fresh profile, distinct id from every one already configured, sensible starting values to edit. */
  const newProfile = (): LocalInferenceProfile => {
    const existing = new Set((draft?.localInference.profiles ?? []).map((profile) => profile.id));
    let n = (draft?.localInference.profiles.length ?? 0) + 1;
    let id = `profile-${n}`;
    while (existing.has(id)) { n += 1; id = `profile-${n}`; }
    return {
      id,
      displayName: `Local model ${n}`,
      enabled: false,
      adapterKind: 'llama_cpp',
      executable: { kind: 'discovered', command: 'llama-server' },
      model: { id: 'local-model', source: { kind: 'runtime_id', runtimeModelId: 'local-model' } },
      fixedArguments: [],
      port: 8080,
      contextLimitTokens: 4096,
      startupTimeoutMs: 600_000,
      healthTimeoutMs: 60_000,
      inferenceTimeoutMs: 1_800_000,
      shutdownTimeoutMs: 60_000,
      requestDefaults: { maxOutputTokens: 4096, chatTemplateParameters: {} }
    };
  };

  const addProfile = (): void => {
    if (!draft) return;
    const profile = newProfile();
    setLocalInference({
      ...draft.localInference,
      profiles: [...draft.localInference.profiles, profile],
      defaultProfileId: draft.localInference.defaultProfileId ?? profile.id
    });
    setEditingProfileId(profile.id);
    setFixedArgumentsText(null);
    setChatTemplateParametersText(null);
    setChatTemplateParametersJsonError(null);
  };

  const deleteProfile = (id: string): void => {
    if (!draft) return;
    const profiles = draft.localInference.profiles.filter((profile) => profile.id !== id);
    setLocalInference({
      ...draft.localInference,
      profiles,
      // A default that no longer exists is not left dangling — the New-task form must never pre-select a
      // profile that is gone, and "no default, choose explicitly" is itself a legitimate, visible state.
      defaultProfileId: draft.localInference.defaultProfileId === id ? null : draft.localInference.defaultProfileId
    });
    if (editingProfileId === id) {
      setEditingProfileId(null);
      setFixedArgumentsText(null);
      setChatTemplateParametersText(null);
      setChatTemplateParametersJsonError(null);
    }
  };

  const setEditingProfile = (next: LocalInferenceProfile): void => {
    if (!draft || editingIndex < 0) return;
    const profiles = draft.localInference.profiles.slice();
    profiles[editingIndex] = next;
    setLocalInference({ ...draft.localInference, profiles });
  };

  /**
   * Local-inference validation, in the user's own words.
   *
   * Uses the shared schema directly, so the form can never accept something
   * main-process validation would refuse. A JSON parse failure in the raw
   * chat-template textarea is tracked separately, since a failed parse never
   * reaches the draft at all.
   */
  const localInferenceProblems = useMemo<string[]>(() => {
    if (!draft) return [];
    const problems: string[] = [];
    if (chatTemplateParametersJsonError) problems.push(chatTemplateParametersJsonError);

    const validated = localInferenceProfilesSettingsSchema.safeParse(draft.localInference);
    if (!validated.success) {
      for (const issue of validated.error.issues) {
        const path = issue.path.join('.');
        problems.push(path ? `${path}: ${issue.message}` : issue.message);
      }
    }
    return problems;
  }, [draft, chatTemplateParametersJsonError]);

  /**
   * **Reset**: put the permission rules back to the shipped defaults.
   *
   * The rules live in two places — the parsed array in `edits` and the raw
   * textarea text — so both have to be set, or Reset would leave the old text
   * on screen while the value behind it had already changed.
   *
   * Restores the defaults rather than the last saved values because this is the
   * way out of a saved configuration the validator now rejects: reverting to
   * the rejected text would leave the Save button disabled and no way forward.
   */
  const resetToDefaults = (): void => {
    const next = resetPermissionRules();
    setEdits(
      settings === null
        ? null
        : {
            ...settings,
            claudeAllowedTools: next.claudeAllowedTools,
            claudeVerificationTools: next.claudeVerificationTools
          }
    );
    setRulesText(next.allowedText);
    setVerificationText(next.verificationText);
  };

  /**
   * After a successful **Save**: drop the local draft so the form re-reads what
   * was stored.
   *
   * Emphatically not the same thing as Reset. Sharing one function made a
   * successful save replace the user's own rules with the defaults on screen —
   * and then write those defaults on the next save.
   */
  const clearEdits = (): void => {
    const cleared = clearLocalEdits();
    setEdits(cleared.draft);
    setRulesText(cleared.allowedText);
    setVerificationText(cleared.verificationText);
    setMcpArgumentsText(null);
    setConventionPathsText(null);
    setFixedArgumentsText(null);
    setChatTemplateParametersText(null);
    setChatTemplateParametersJsonError(null);
  };

  /**
   * Whether Save has anything to do.
   *
   * Validity alone is not enough: with no unsaved change, saving would write
   * the values that are already there and tell the user nothing. Comparing the
   * draft against the store is also what makes Reset honest — restoring
   * defaults that are already stored leaves the form clean rather than
   * pretending there is work pending.
   */
  const saveState = settingsSaveState({
    saved: settings,
    draft,
    blockingProblems:
      verificationProblems.length + externalReviewProblems.length + localInferenceProblems.length
  });

  const localInferenceUnsaved =
    settings !== null &&
    draft !== null &&
    JSON.stringify(settings.localInference) !== JSON.stringify(draft.localInference);

  /**
   * "Recheck connection" dials the SAVED executable, arguments, working
   * directory and process timeout — it calls the main process, which only
   * ever reads persisted settings (see `COAI_CONNECTION_PROBE_SETTINGS_KEYS`
   * for exactly which fields those are, and why the review-enabled switches
   * and the conventions fields are deliberately NOT among them: neither
   * changes what this probe dials). With unsaved edits to any of the fields
   * that DO, a check would silently test the configuration still on disk
   * while the form shows something else, and whatever it reports could be
   * mistaken for a verdict on the draft. Save first is the smaller and safer
   * fix; the button is disabled with an explanation instead.
   */
  const coaiSettingsUnsaved =
    settings !== null &&
    draft !== null &&
    JSON.stringify(coaiRelevantSettings(settings)) !== JSON.stringify(coaiRelevantSettings(draft));

  return (
    <div className="content--split" style={{ display: 'grid' }}>
      <div className="stack">
        <Card
          title="Tool diagnostics"
          flush
          actions={
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              disabled={checking}
              onClick={async () => {
                setChecking(true);
                await refreshDiagnostics(true);
                setChecking(false);
              }}
            >
              {checking ? <Spinner /> : null} Re-check
            </button>
          }
        >
          {tools.length === 0 ? (
            <div style={{ padding: 16 }} className="muted">
              Running diagnostics…
            </div>
          ) : (
            tools.map((tool) => <ToolCard key={tool.tool} tool={tool} />)
          )}
          {diagnostics ? (
            <div className="legend">Last checked {formatDateTime(diagnostics.checkedAt)}</div>
          ) : null}
        </Card>

        <Notice tone="info">
          Agent Relay never stores an API key, token, or password. Each tool authenticates itself:
          <span className="mono"> codex login</span>, <span className="mono">claude</span>, and{' '}
          <span className="mono">gh auth login</span>. Diagnostics show account names only, never
          credentials.
        </Notice>
      </div>

      <div className="stack">
        {!draft ? (
          <Card>
            <div className="muted">Loading settings…</div>
          </Card>
        ) : (
          <>
            <Card title="Executables" >
              <div className="stack">
                <Field
                  label="Claude Code path"
                  hint="Leave empty to auto-discover on PATH and in the standard Windows install locations."
                >
                  <input
                    className="input input--mono"
                    value={draft.claudeExecutablePath ?? ''}
                    placeholder="(auto-discover)"
                    onChange={(e) => set('claudeExecutablePath', e.target.value.trim() || null)}
                  />
                </Field>
                <Field label="Codex path" hint="Leave empty to use the bundled Codex binary or PATH.">
                  <input
                    className="input input--mono"
                    value={draft.codexExecutablePath ?? ''}
                    placeholder="(auto-discover)"
                    onChange={(e) => set('codexExecutablePath', e.target.value.trim() || null)}
                  />
                </Field>
                <Field label="GitHub CLI path" hint="Leave empty to use PATH.">
                  <input
                    className="input input--mono"
                    value={draft.ghExecutablePath ?? ''}
                    placeholder="(auto-discover)"
                    onChange={(e) => set('ghExecutablePath', e.target.value.trim() || null)}
                  />
                </Field>
              </div>
            </Card>

            <Card title="Local inference">
              <div className="stack">
                <Notice tone="info">
                  Selecting Ornith as a task&apos;s implementation provider runs it through Agent
                  Relay&apos;s own local coding-agent protocol against one of the profiles below — never a
                  second executable or endpoint to set up, only a choice of which model. Choosing Ornith
                  never starts anything: the profile a task is bound to must already be selected and
                  started below, and Healthy. Every Ornith implementation rechecks health itself
                  immediately before it runs, and Stop here remains independent of any running task.
                </Notice>
                <label className="row" style={{ alignItems: 'flex-start' }}>
                  <input
                    type="checkbox"
                    checked={draft.localInference.enabled}
                    onChange={(event) =>
                      setLocalInference({ ...draft.localInference, enabled: event.target.checked })
                    }
                  />
                  <span>
                    <strong>Enable local inference</strong>
                    <span className="muted" style={{ display: 'block', marginTop: 3 }}>
                      Off by default. No executable is discovered, launched or contacted for any profile
                      while disabled — the lifecycle panel below stays inert.
                    </span>
                  </span>
                </label>

                <div className="stack stack--tight" aria-label="Local-model profiles">
                  <div className="section-title">Model profiles</div>
                  {draft.localInference.profiles.length === 0 ? (
                    <p className="hint">No profiles configured yet.</p>
                  ) : (
                    draft.localInference.profiles.map((profile) => (
                      <div className="filerow" key={profile.id}>
                        <label className="row" style={{ gap: 6 }}>
                          <input
                            type="radio"
                            name="default-local-inference-profile"
                            checked={draft.localInference.defaultProfileId === profile.id}
                            onChange={() => setLocalInference({ ...draft.localInference, defaultProfileId: profile.id })}
                            aria-label={`Set "${profile.displayName}" as the default profile`}
                          />
                          <span className="faint" title="Default profile for a new task that names none explicitly">default</span>
                        </label>
                        <label className="row" style={{ gap: 6 }}>
                          <input
                            type="checkbox"
                            checked={profile.enabled}
                            onChange={(event) => {
                              const profiles = draft.localInference.profiles.map((p) =>
                                p.id === profile.id ? { ...p, enabled: event.target.checked } : p
                              );
                              setLocalInference({ ...draft.localInference, profiles });
                            }}
                            aria-label={`Enable "${profile.displayName}" for new task selection`}
                          />
                          <span className="faint">enabled</span>
                        </label>
                        <button
                          type="button"
                          className="filerow__path"
                          style={{ background: 'none', border: 'none', textAlign: 'left', cursor: 'pointer', color: 'inherit', font: 'inherit', padding: 0 }}
                          onClick={() => {
                            setEditingProfileId(profile.id);
                            setFixedArgumentsText(null);
                            setChatTemplateParametersText(null);
                            setChatTemplateParametersJsonError(null);
                          }}
                        >
                          {profile.displayName}{' '}
                          <span className="mono faint">({profile.id})</span>
                        </button>
                        <button type="button" className="btn btn--sm btn--ghost" onClick={() => deleteProfile(profile.id)}>
                          Delete
                        </button>
                      </div>
                    ))
                  )}
                  <button type="button" className="btn btn--sm" onClick={addProfile}>
                    Add profile
                  </button>
                </div>

                {editingProfile ? (
                  <div className="stack" aria-label={`Editing profile ${editingProfile.displayName}`}>
                    <div className="section-title">Editing: {editingProfile.displayName}</div>

                    <Field label="Profile name" hint="Shown wherever this profile is offered, e.g. on the New task screen.">
                      <input
                        className="input"
                        value={editingProfile.displayName}
                        onChange={(event) => setEditingProfile({ ...editingProfile, displayName: event.target.value })}
                      />
                    </Field>

                    <Field label="Executable" hint="Discover llama-server on PATH, or name an absolute path explicitly.">
                      <select
                        className="input"
                        value={editingProfile.executable.kind}
                        onChange={(event) =>
                          setEditingProfile({
                            ...editingProfile,
                            executable:
                              event.target.value === 'discovered'
                                ? { kind: 'discovered', command: 'llama-server' }
                                : { kind: 'explicit_path', path: '' }
                          })
                        }
                      >
                        <option value="discovered">Discover llama-server on PATH</option>
                        <option value="explicit_path">Explicit executable path</option>
                      </select>
                    </Field>
                    {editingProfile.executable.kind === 'explicit_path' ? (
                      <Field label="Executable path">
                        <input
                          className="input input--mono"
                          value={editingProfile.executable.path}
                          onChange={(event) =>
                            setEditingProfile({
                              ...editingProfile,
                              executable: { kind: 'explicit_path', path: event.target.value }
                            })
                          }
                        />
                      </Field>
                    ) : null}

                    <Field label="Model id" hint="The stable identity used in --alias and in every request/response. Never a path.">
                      <input
                        className="input input--mono"
                        value={editingProfile.model.id}
                        onChange={(event) =>
                          setEditingProfile({
                            ...editingProfile,
                            model: { ...editingProfile.model, id: event.target.value }
                          })
                        }
                      />
                    </Field>
                    <Field label="Model source" hint="Where the runtime finds the weights.">
                      <select
                        className="input"
                        value={editingProfile.model.source.kind}
                        onChange={(event) =>
                          setEditingProfile({
                            ...editingProfile,
                            model: {
                              ...editingProfile.model,
                              source:
                                event.target.value === 'path'
                                  ? { kind: 'path', path: '' }
                                  : { kind: 'runtime_id', runtimeModelId: '' }
                            }
                          })
                        }
                      >
                        <option value="path">Model file path</option>
                        <option value="runtime_id">Runtime-resolved identifier</option>
                      </select>
                    </Field>
                    {editingProfile.model.source.kind === 'path' ? (
                      <Field label="Model path">
                        <input
                          className="input input--mono"
                          value={editingProfile.model.source.path}
                          onChange={(event) =>
                            setEditingProfile({
                              ...editingProfile,
                              model: {
                                ...editingProfile.model,
                                source: { kind: 'path', path: event.target.value }
                              }
                            })
                          }
                        />
                      </Field>
                    ) : (
                      <Field label="Runtime model identifier">
                        <input
                          className="input input--mono"
                          value={editingProfile.model.source.runtimeModelId}
                          onChange={(event) =>
                            setEditingProfile({
                              ...editingProfile,
                              model: {
                                ...editingProfile.model,
                                source: { kind: 'runtime_id', runtimeModelId: event.target.value }
                              }
                            })
                          }
                        />
                      </Field>
                    )}

                    <Field
                      label="Fixed runtime arguments"
                      hint="One argv entry per line. Never shell-parsed. Model, alias, host, port and context flags are owned by Agent Relay and cannot be overridden here."
                    >
                      <textarea
                        className="input input--mono"
                        rows={3}
                        spellCheck={false}
                        value={fixedArgumentsText ?? editingProfile.fixedArguments.join('\n')}
                        onChange={(event) => {
                          setFixedArgumentsText(event.target.value);
                          setEditingProfile({
                            ...editingProfile,
                            fixedArguments: event.target.value
                              .split('\n')
                              .map((line) => line.trim())
                              .filter((line) => line.length > 0)
                          });
                        }}
                      />
                    </Field>

                    <Field label="Port" hint="Loopback only (127.0.0.1); the host is never configurable.">
                      <input
                        type="number"
                        className="input"
                        value={editingProfile.port}
                        onChange={(event) => setEditingProfile({ ...editingProfile, port: Number(event.target.value) })}
                      />
                    </Field>
                    <Field label="Context size (tokens)">
                      <input
                        type="number"
                        className="input"
                        value={editingProfile.contextLimitTokens}
                        onChange={(event) =>
                          setEditingProfile({ ...editingProfile, contextLimitTokens: Number(event.target.value) })
                        }
                      />
                    </Field>
                    <Field label="Default max output tokens" hint="May not exceed the context size.">
                      <input
                        type="number"
                        className="input"
                        value={editingProfile.requestDefaults.maxOutputTokens}
                        onChange={(event) =>
                          setEditingProfile({
                            ...editingProfile,
                            requestDefaults: {
                              ...editingProfile.requestDefaults,
                              maxOutputTokens: Number(event.target.value)
                            }
                          })
                        }
                      />
                    </Field>

                    <Field label="Startup timeout (ms)">
                      <input
                        type="number"
                        className="input"
                        value={editingProfile.startupTimeoutMs}
                        onChange={(event) =>
                          setEditingProfile({ ...editingProfile, startupTimeoutMs: Number(event.target.value) })
                        }
                      />
                    </Field>
                    <Field label="Health timeout (ms)">
                      <input
                        type="number"
                        className="input"
                        value={editingProfile.healthTimeoutMs}
                        onChange={(event) =>
                          setEditingProfile({ ...editingProfile, healthTimeoutMs: Number(event.target.value) })
                        }
                      />
                    </Field>
                    <Field label="Inference timeout (ms)">
                      <input
                        type="number"
                        className="input"
                        value={editingProfile.inferenceTimeoutMs}
                        onChange={(event) =>
                          setEditingProfile({ ...editingProfile, inferenceTimeoutMs: Number(event.target.value) })
                        }
                      />
                    </Field>
                    <Field label="Stop timeout (ms)">
                      <input
                        type="number"
                        className="input"
                        value={editingProfile.shutdownTimeoutMs}
                        onChange={(event) =>
                          setEditingProfile({ ...editingProfile, shutdownTimeoutMs: Number(event.target.value) })
                        }
                      />
                    </Field>

                    <Field
                      label="Default chat-template parameters"
                      hint={
                        'A flat JSON object of strings, numbers or booleans, e.g. Ornith: ' +
                        '{"enable_thinking": false, "preserve_thinking": false}. Empty {} sends none.'
                      }
                    >
                      <textarea
                        className="input input--mono"
                        rows={3}
                        spellCheck={false}
                        value={
                          chatTemplateParametersText ??
                          JSON.stringify(editingProfile.requestDefaults.chatTemplateParameters)
                        }
                        onChange={(event) => {
                          const raw = event.target.value;
                          setChatTemplateParametersText(raw);
                          // A blank or whitespace-only textarea is the empty map,
                          // not a JSON parse failure — clearing every configured
                          // parameter must not require typing a literal "{}".
                          const candidate = raw.trim().length === 0 ? {} : parseJsonOrFailure(raw);
                          if (candidate === JSON_PARSE_FAILED) {
                            setChatTemplateParametersJsonError(
                              'Chat-template parameters must be valid JSON.'
                            );
                            return;
                          }
                          const validated = chatTemplateParametersSchema.safeParse(candidate);
                          if (!validated.success) {
                            setChatTemplateParametersJsonError(
                              'Chat-template parameters must be a flat object of strings, numbers or booleans.'
                            );
                            return;
                          }
                          setChatTemplateParametersJsonError(null);
                          setEditingProfile({
                            ...editingProfile,
                            requestDefaults: {
                              ...editingProfile.requestDefaults,
                              chatTemplateParameters: validated.data
                            }
                          });
                        }}
                      />
                    </Field>
                  </div>
                ) : (
                  <p className="hint">Select a profile above to edit it, or add a new one.</p>
                )}

                {localInferenceProblems.length > 0 ? (
                  <Notice tone="error">
                    <strong>Local inference settings cannot be saved.</strong>
                    <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                      {localInferenceProblems.map((problem) => (
                        <li key={problem}>{problem}</li>
                      ))}
                    </ul>
                  </Notice>
                ) : null}
              </div>
            </Card>

            <LocalInferenceLifecyclePanel
              enabled={settings?.localInference.enabled ?? false}
              unsaved={localInferenceUnsaved}
            />

            <Card title="Locations">
              <div className="stack">
                <Field label="GitHub owner" hint="Default owner for repositories Agent Relay creates.">
                  <input
                    className="input input--mono"
                    value={draft.githubOwner}
                    onChange={(e) => set('githubOwner', e.target.value)}
                  />
                </Field>
                <Field label="Projects root" hint="Default parent folder for new projects.">
                  <input
                    className="input input--mono"
                    value={draft.projectsRoot}
                    onChange={(e) => set('projectsRoot', e.target.value)}
                  />
                </Field>
                <Field
                  label="Worktrees root"
                  hint="Every task worktree is created here. A worktree outside this folder is rejected."
                >
                  <input
                    className="input input--mono"
                    value={draft.worktreesRoot}
                    onChange={(e) => set('worktreesRoot', e.target.value)}
                  />
                </Field>
              </div>
            </Card>

            <Card title="External plan review">
              <div className="stack">
                <label className="row" style={{ alignItems: 'flex-start' }}>
                  <input
                    type="checkbox"
                    checked={draft.externalPlanReviewEnabled}
                    onChange={(event) => set('externalPlanReviewEnabled', event.target.checked)}
                  />
                  <span>
                    <strong>Enable task-level rule binding and external plan review</strong>
                    <span className="muted" style={{ display: 'block', marginTop: 3 }}>
                      Each task opts in permanently when you capture its rules. No existing task is changed.
                    </span>
                  </span>
                </label>

                <label className="row" style={{ alignItems: 'flex-start' }}>
                  <input
                    type="checkbox"
                    checked={draft.externalCodeReviewEnabled}
                    onChange={(event) => set('externalCodeReviewEnabled', event.target.checked)}
                  />
                  <span>
                    <strong>Also allow external code review</strong>
                    <span className="muted" style={{ display: 'block', marginTop: 3 }}>
                      Separate because the capability is separate: code review needs an MCP server that
                      advertises the addressable round tools. The Coai build shipped today does not, and
                      the reviewer reports that rather than running anything.
                    </span>
                  </span>
                </label>

                <Field label="MCP executable" hint="Absolute path only. Authentication remains owned by the MCP server.">
                  <input
                    className="input input--mono"
                    value={draft.coaiMcpExecutablePath ?? ''}
                    placeholder="(required when enabled)"
                    onChange={(event) => set('coaiMcpExecutablePath', event.target.value.trim() || null)}
                  />
                </Field>
                <Field label="MCP arguments" hint="One fixed argument per line. Never put a token or password here.">
                  <textarea
                    className="input input--mono"
                    rows={3}
                    spellCheck={false}
                    value={mcpArgumentsText ?? draft.coaiMcpArguments.join('\n')}
                    onChange={(event) => {
                      setMcpArgumentsText(event.target.value);
                      set(
                        'coaiMcpArguments',
                        event.target.value.split('\n').map((line) => line.trim()).filter(Boolean)
                      );
                    }}
                  />
                </Field>
                <Field label="MCP working directory" hint="Optional absolute directory.">
                  <input
                    className="input input--mono"
                    value={draft.coaiMcpWorkingDirectory ?? ''}
                    onChange={(event) => set('coaiMcpWorkingDirectory', event.target.value.trim() || null)}
                  />
                </Field>

                <CoaiConnectionPanel
                  checking={coaiChecking}
                  diagnostic={coaiDiagnostic}
                  checkError={coaiCheckError}
                  contractChanged={coaiDiagnostic?.contractChangedSinceLastKnown ?? false}
                  unsaved={coaiSettingsUnsaved}
                  onCheck={checkCoaiConnection}
                />

                <Field label="Conventions repository" hint="Optional. Project rules are always captured; add a clean conventions repository here.">
                  <input
                    className="input input--mono"
                    value={draft.conventionsRepositoryPath ?? ''}
                    onChange={(event) => set('conventionsRepositoryPath', event.target.value.trim() || null)}
                  />
                </Field>
                <Field label="Conventions revision" hint="Exact full Git SHA; moving branch names are refused.">
                  <input
                    className="input input--mono"
                    value={draft.conventionsExpectedRevision ?? ''}
                    onChange={(event) => set('conventionsExpectedRevision', event.target.value.trim() || null)}
                  />
                </Field>
                <Field label="Selected convention files" hint="One repository-relative POSIX path per line.">
                  <textarea
                    className="input input--mono"
                    rows={4}
                    spellCheck={false}
                    value={conventionPathsText ?? draft.conventionsRulePaths.join('\n')}
                    onChange={(event) => {
                      setConventionPathsText(event.target.value);
                      set(
                        'conventionsRulePaths',
                        event.target.value.split('\n').map((line) => line.trim()).filter(Boolean)
                      );
                    }}
                  />
                </Field>

                {externalReviewProblems.length > 0 ? (
                  <Notice tone="error">
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {externalReviewProblems.map((problem) => <li key={problem}>{problem}</li>)}
                    </ul>
                  </Notice>
                ) : null}
                <Notice tone="info">
                  Captured rule bytes and their Git identity are frozen on the task. Changing these
                  settings later does not rewrite evidence already bound to a task.
                </Notice>
              </div>
            </Card>

            <Card title="Limits">
              <div className="stack">
                <Field
                  label={`Maximum review rounds: ${draft.maxReviewRounds}`}
                  hint="Ceiling for new tasks. This is what stops the relay loop running forever."
                >
                  <input
                    type="range"
                    min={1}
                    max={10}
                    value={draft.maxReviewRounds}
                    onChange={(e) => set('maxReviewRounds', Number(e.target.value))}
                  />
                </Field>

                <Field
                  label={`Process timeout: ${Math.round(draft.processTimeoutMs / 60_000)} minutes`}
                  hint="An agent run is cancelled after this long. Coai MCP calls keep their separate 30-minute safety ceiling."
                >
                  <input
                    type="range"
                    min={1}
                    max={180}
                    value={Math.round(draft.processTimeoutMs / 60_000)}
                    onChange={(e) => set('processTimeoutMs', Number(e.target.value) * 60_000)}
                  />
                </Field>

                <Field
                  label={`Claude max turns: ${draft.claudeMaxTurns}`}
                  hint="Passed to Claude Code as --max-turns."
                >
                  <input
                    type="range"
                    min={5}
                    max={300}
                    step={5}
                    value={draft.claudeMaxTurns}
                    onChange={(e) => set('claudeMaxTurns', Number(e.target.value))}
                  />
                </Field>

                <Field
                  id={SETTINGS_FOCUS_IDS.maxStoredLogBytes}
                  label={`Stored log budget: ${(draft.maxStoredLogBytes / 1000).toLocaleString()}k characters per run`}
                  hint="Beyond this, events stream live but are not persisted."
                >
                  <input
                    type="range"
                    min={100_000}
                    max={10_000_000}
                    step={100_000}
                    value={draft.maxStoredLogBytes}
                    onChange={(e) => set('maxStoredLogBytes', Number(e.target.value))}
                  />
                </Field>

                <Field
                  label={`Diff budget for review: ${(draft.maxDiffBytes / 1000).toLocaleString()}k characters`}
                  hint="Diffs larger than this are truncated before being sent to Codex."
                >
                  <input
                    type="range"
                    min={20_000}
                    max={2_000_000}
                    step={20_000}
                    value={draft.maxDiffBytes}
                    onChange={(e) => set('maxDiffBytes', Number(e.target.value))}
                  />
                </Field>

                <Field
                  label="Default Codex model for new tasks"
                  hint="Pre-selects the picker on the New task form. Leave empty for the Codex default."
                >
                  <input
                    className="input input--mono"
                    value={draft.codexModel ?? ''}
                    placeholder="(tool default)"
                    onChange={(e) => set('codexModel', e.target.value.trim() || null)}
                  />
                </Field>

                <Field
                  label="Default Claude model for new tasks"
                  hint="Pre-selects the picker on the New task form. An alias such as opus, or a full model id."
                >
                  <input
                    className="input input--mono"
                    value={draft.claudeModel ?? ''}
                    placeholder="(tool default)"
                    onChange={(e) => set('claudeModel', e.target.value.trim() || null)}
                  />
                </Field>

                <Notice tone="info">
                  These two are only defaults for the <strong>New task</strong> form. Each task
                  stores its own pair when it is created, so changing them here never affects a task
                  that already exists.
                </Notice>
              </div>
            </Card>

            <Card title="Claude permissions">
              <div className="stack">
                <Field
                  label="Shell commands pre-approved for Claude"
                  hint="One Claude Code permission rule per line, e.g. Bash(npm test *). Matching commands run unattended, without a prompt. The default pre-approves npm test through both Bash and PowerShell."
                >
                  <textarea
                    className="input input--mono"
                    rows={4}
                    spellCheck={false}
                    value={rulesText ?? draft.claudeAllowedTools.join('\n')}
                    placeholder={DEFAULT_CLAUDE_ALLOWED_TOOLS.join('\n')}
                    onChange={(e) => {
                      // The textarea keeps the raw text so a blank line being
                      // typed does not vanish under the cursor; only non-empty
                      // lines are committed to the settings draft.
                      setRulesText(e.target.value);
                      set(
                        'claudeAllowedTools',
                        e.target.value
                          .split('\n')
                          .map((line) => line.trim())
                          .filter((line) => line.length > 0)
                      );
                    }}
                  />
                </Field>

                <Notice tone="warn">
                  These rules <strong>pre-approve</strong> matching commands — they are not the
                  full limit of what Claude can do. Under <span className="mono">acceptEdits</span>{' '}
                  it also edits files in its worktree, and some read-only commands run
                  automatically. Keep the list narrow: prefer{' '}
                  <span className="mono">Bash(npm test *)</span> over a blanket{' '}
                  <span className="mono">Bash(*)</span>.
                </Notice>

                <Notice tone="info">
                  Your personal Claude settings and plugins are excluded from task runs, but the
                  target repository&apos;s own project settings still load and may add permissions
                  or hooks. Commit, push, reset, clean, checkout, switch, merge, rebase and{' '}
                  <span className="mono">gh</span> are refused when a command names them directly —
                  a pattern filter, not a sandbox, so a project script that wraps them is not
                  caught. Publishing still requires the confirmation dialog.
                </Notice>

                <Field
                  label="Implementation verification commands (Claude and Codex)"
                  hint="One rule per line. A round has to run one of these successfully before it can be published."
                >
                  <textarea
                    className="input input--mono"
                    rows={3}
                    spellCheck={false}
                    value={verificationText ?? draft.claudeVerificationTools.join('\n')}
                    placeholder={DEFAULT_CLAUDE_VERIFICATION_TOOLS.join('\n')}
                    onChange={(e) => {
                      setVerificationText(e.target.value);
                      set(
                        'claudeVerificationTools',
                        e.target.value
                          .split('\n')
                          .map((line) => line.trim())
                          .filter((line) => line.length > 0)
                      );
                    }}
                  />
                </Field>

                {verificationProblems.length > 0 ? (
                  <Notice tone="error">
                    <strong>These verification rules cannot be used.</strong> Settings will not
                    save until they are fixed.
                    <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                      {verificationProblems.map((problem: string) => (
                        <li key={problem}>{problem}</li>
                      ))}
                    </ul>
                  </Notice>
                ) : null}

                <Notice tone="info">
                  These decide which commands count as <strong>checking the work</strong> — they
                  are not a second permission list. Every rule here must also appear above, since
                  Claude could not otherwise run it. Only{' '}
                  <span className="mono">Bash(…)</span> and{' '}
                  <span className="mono">PowerShell(…)</span> are supported, with at most one
                  trailing <span className="mono">*</span>. Like the list above this is a pattern
                  filter, not a sandbox: chained commands such as{' '}
                  <span className="mono">npm test; git status</span> never count as verification,
                  and neither does a command that wraps another.
                </Notice>
              </div>
            </Card>

            <div className="row">
              <button
                type="button"
                className="btn btn--primary"
                disabled={!saveState.canSave}
                onClick={() =>
                  void perform('save-settings', 'Could not save settings', async () => {
                    // Captured before the write, so the comparison below is
                    // against what was actually stored a moment ago.
                    const codexPathChanged =
                      settings?.codexExecutablePath !== draft.codexExecutablePath;

                    // Only after the write succeeds: a rejected save must leave
                    // the user's text on screen to correct, not discard it.
                    await expect('settings:update', draft);
                    clearEdits();
                    await refreshSettings();
                    await refreshDiagnostics(true);

                    // A different Codex binary is a different catalogue. Fetch
                    // it now rather than making the user press Refresh models.
                    if (codexPathChanged) await refreshCodexModels(true);

                    notify({ tone: 'success', title: 'Settings saved' });
                  })
                }
              >
                Save settings
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                title="Restore the shipped Claude permission and verification rules."
                onClick={resetToDefaults}
              >
                Reset
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ToolCard({ tool }: { tool: ToolDiagnostic }): React.JSX.Element {
  return (
    <div style={{ padding: '13px 16px', borderBottom: '1px solid var(--border)' }}>
      <div className="row">
        <ToolDot status={tool.status} />
        <strong style={{ fontSize: 13 }}>{TOOL_TITLES[tool.tool] ?? tool.tool}</strong>
        <span className={`tag ${tool.status === 'ok' ? 'tag--ok' : tool.status === 'unauthenticated' ? 'tag--warn' : tool.status === 'missing' ? '' : 'tag--danger'}`}>
          {tool.status}
        </span>
        {tool.version ? <span className="faint mono">{tool.version}</span> : null}
      </div>

      <div className="muted selectable" style={{ marginTop: 5, fontSize: 12 }}>
        {tool.detail}
      </div>

      {tool.executablePath ? (
        <div className="faint mono selectable" style={{ marginTop: 3 }}>
          {tool.executablePath}
        </div>
      ) : null}

      {tool.accounts && tool.accounts.length > 0 ? (
        <div className="row row--wrap" style={{ marginTop: 6 }}>
          {tool.accounts.map((account) => (
            <span key={account} className={`tag ${account === tool.activeAccount ? 'tag--ok' : ''}`}>
              {account}
              {account === tool.activeAccount ? ' · active' : ''}
            </span>
          ))}
        </div>
      ) : null}

      {tool.remediation ? (
        <div style={{ marginTop: 8 }}>
          <Notice tone="warn">{tool.remediation}</Notice>
        </div>
      ) : null}
    </div>
  );
}

function CapabilityTag({
  label,
  available
}: {
  label: string;
  available: boolean;
}): React.JSX.Element {
  return (
    <span className={`tag ${available ? 'tag--ok' : ''}`}>
      {label}: {available ? 'available' : 'unavailable'}
    </span>
  );
}

/**
 * Read-only Coai connection/capability check. Plan review, human escalation,
 * durable code review and reconciliation are shown independently, on
 * purpose — one being unavailable is never evidence about another, and this
 * panel exists specifically so that stops being a surprise discovered mid-task.
 */
function CoaiConnectionPanel({
  checking,
  diagnostic,
  checkError,
  contractChanged,
  unsaved,
  onCheck
}: {
  checking: boolean;
  diagnostic: CoaiConnectionDiagnostic | null;
  checkError: string | null;
  contractChanged: boolean;
  unsaved: boolean;
  onCheck: () => void;
}): React.JSX.Element {
  return (
    <div className="field" style={{ marginTop: 4 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="field__label">Coai connection</span>
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          disabled={checking || unsaved}
          title={unsaved ? 'Save your Coai changes first, then recheck.' : undefined}
          onClick={onCheck}
        >
          {checking ? <Spinner /> : null} Recheck connection
        </button>
      </div>

      {unsaved ? (
        <div style={{ marginTop: 6 }}>
          <Notice tone="warn">
            You have unsaved Coai changes. This checks the saved configuration, not the draft above
            — save first so a check tells you about what you are about to use.
          </Notice>
        </div>
      ) : null}

      {checkError ? (
        <div style={{ marginTop: 6 }}>
          <Notice tone="error">{checkError}</Notice>
        </div>
      ) : null}

      {contractChanged ? (
        <div style={{ marginTop: 6 }}>
          <Notice tone="warn">
            The server’s contract changed since the last time this build durably confirmed it.
            What changed is shown below.
          </Notice>
        </div>
      ) : null}

      {diagnostic ? (
        <div style={{ marginTop: 6 }}>
          <div className="row" style={{ alignItems: 'center', gap: 8 }}>
            <span className={`tag ${diagnostic.serverReached ? 'tag--ok' : 'tag--danger'}`}>
              {diagnostic.serverReached ? 'reached' : 'not reached'}
            </span>
            {diagnostic.serverName ? (
              <strong style={{ fontSize: 13 }}>{diagnostic.serverName}</strong>
            ) : null}
            {diagnostic.serverVersion ? (
              <span className="faint mono">{diagnostic.serverVersion}</span>
            ) : null}
          </div>

          <div className="row row--wrap" style={{ marginTop: 6, gap: 6 }}>
            <CapabilityTag label="Plan review" available={diagnostic.planReview === 'available'} />
            <CapabilityTag
              label="Human escalation"
              available={diagnostic.humanEscalation === 'available'}
            />
            <CapabilityTag label="Durable code review" available={diagnostic.codeReview === 'available'} />
            <CapabilityTag label="Reconciliation" available={diagnostic.reconciliation === 'available'} />
          </div>

          <div className="muted selectable" style={{ marginTop: 6, fontSize: 12 }}>
            {diagnostic.detail}
          </div>

          <div className="legend" style={{ marginTop: 4 }}>
            Last checked {formatDateTime(diagnostic.checkedAt)}
          </div>
        </div>
      ) : (
        <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
          Not checked yet this session.
        </div>
      )}
    </div>
  );
}

/** Re-exported so the rail can trigger a check without importing the view. */
export async function recheckTools(): Promise<void> {
  await call('diagnostics:run', { force: true });
}

/**
 * Rule problems, phrased as what to change.
 *
 * A total record over the problem codes, so a new kind of malformed rule cannot
 * be added without deciding what to tell the person who typed it.
 */
const VERIFICATION_RULE_PROBLEMS: Record<RuleProblem, string> = {
  syntax: 'is not written as Tool(command).',
  unsupported_tool: 'uses a tool other than Bash(…) or PowerShell(…).',
  empty_body: 'names no command.',
  wildcard: 'may only use a single * as its final character.',
  compound:
    'chains commands. A separator such as ; && || | or & never counts as verification, ' +
    'even inside quotes.',
  wrapper: 'runs another command, such as cmd /c, which cannot be verified.'
};
