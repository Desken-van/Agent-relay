import { useMemo, useState } from 'react';
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
  localInferenceSettingsSchema,
  type LocalInferenceSettings
} from '@shared/domain/local-inference';
import { containsSecretShape } from '@shared/util/redact';
import { call, expect } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { useStore } from '../state/store';
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

const TOOL_TITLES: Record<string, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  git: 'Git',
  github: 'GitHub CLI',
  ornith: 'Ornith'
};

export function SettingsView(): React.JSX.Element {
  const { settings, diagnostics, refreshDiagnostics, refreshSettings, refreshCodexModels, perform, notify } =
    useStore();

  // Only the user's unsaved edits are held locally; the baseline is whatever the
  // store currently has. Deriving rather than copying means a settings refresh
  // cannot silently clobber an in-progress edit, and there is no sync effect.
  const [edits, setEdits] = useState<Settings | null>(null);
  const draft = edits ?? settings;
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

  const setLocalInference = (next: LocalInferenceSettings): void => set('localInference', next);

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

    const validated = localInferenceSettingsSchema.safeParse(draft.localInference);
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
                  Selecting Ornith as a task&apos;s implementation provider reuses this exact
                  configured runtime — there is no second executable, endpoint or model to set
                  up. Choosing Ornith never starts it: the runtime must already be started and
                  Healthy below. Every Ornith implementation rechecks health itself immediately
                  before it runs, and Stop here remains independent of any running task.
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
                      Off by default. No executable is discovered, launched or contacted while
                      disabled — the lifecycle panel below stays inert.
                    </span>
                  </span>
                </label>

                <Field label="Executable" hint="Discover llama-server on PATH, or name an absolute path explicitly.">
                  <select
                    className="input"
                    value={draft.localInference.executable.kind}
                    onChange={(event) =>
                      setLocalInference({
                        ...draft.localInference,
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
                {draft.localInference.executable.kind === 'explicit_path' ? (
                  <Field label="Executable path">
                    <input
                      className="input input--mono"
                      value={draft.localInference.executable.path}
                      onChange={(event) =>
                        setLocalInference({
                          ...draft.localInference,
                          executable: { kind: 'explicit_path', path: event.target.value }
                        })
                      }
                    />
                  </Field>
                ) : null}

                <Field label="Model id" hint="The stable identity used in --alias and in every request/response. Never a path.">
                  <input
                    className="input input--mono"
                    value={draft.localInference.model.id}
                    onChange={(event) =>
                      setLocalInference({
                        ...draft.localInference,
                        model: { ...draft.localInference.model, id: event.target.value }
                      })
                    }
                  />
                </Field>
                <Field label="Model source" hint="Where the runtime finds the weights.">
                  <select
                    className="input"
                    value={draft.localInference.model.source.kind}
                    onChange={(event) =>
                      setLocalInference({
                        ...draft.localInference,
                        model: {
                          ...draft.localInference.model,
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
                {draft.localInference.model.source.kind === 'path' ? (
                  <Field label="Model path">
                    <input
                      className="input input--mono"
                      value={draft.localInference.model.source.path}
                      onChange={(event) =>
                        setLocalInference({
                          ...draft.localInference,
                          model: {
                            ...draft.localInference.model,
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
                      value={draft.localInference.model.source.runtimeModelId}
                      onChange={(event) =>
                        setLocalInference({
                          ...draft.localInference,
                          model: {
                            ...draft.localInference.model,
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
                    value={fixedArgumentsText ?? draft.localInference.fixedArguments.join('\n')}
                    onChange={(event) => {
                      setFixedArgumentsText(event.target.value);
                      setLocalInference({
                        ...draft.localInference,
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
                    value={draft.localInference.port}
                    onChange={(event) =>
                      setLocalInference({ ...draft.localInference, port: Number(event.target.value) })
                    }
                  />
                </Field>
                <Field label="Context size (tokens)">
                  <input
                    type="number"
                    className="input"
                    value={draft.localInference.contextLimitTokens}
                    onChange={(event) =>
                      setLocalInference({
                        ...draft.localInference,
                        contextLimitTokens: Number(event.target.value)
                      })
                    }
                  />
                </Field>
                <Field label="Default max output tokens" hint="May not exceed the context size.">
                  <input
                    type="number"
                    className="input"
                    value={draft.localInference.requestDefaults.maxOutputTokens}
                    onChange={(event) =>
                      setLocalInference({
                        ...draft.localInference,
                        requestDefaults: {
                          ...draft.localInference.requestDefaults,
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
                    value={draft.localInference.startupTimeoutMs}
                    onChange={(event) =>
                      setLocalInference({
                        ...draft.localInference,
                        startupTimeoutMs: Number(event.target.value)
                      })
                    }
                  />
                </Field>
                <Field label="Health timeout (ms)">
                  <input
                    type="number"
                    className="input"
                    value={draft.localInference.healthTimeoutMs}
                    onChange={(event) =>
                      setLocalInference({
                        ...draft.localInference,
                        healthTimeoutMs: Number(event.target.value)
                      })
                    }
                  />
                </Field>
                <Field label="Inference timeout (ms)">
                  <input
                    type="number"
                    className="input"
                    value={draft.localInference.inferenceTimeoutMs}
                    onChange={(event) =>
                      setLocalInference({
                        ...draft.localInference,
                        inferenceTimeoutMs: Number(event.target.value)
                      })
                    }
                  />
                </Field>
                <Field label="Stop timeout (ms)">
                  <input
                    type="number"
                    className="input"
                    value={draft.localInference.shutdownTimeoutMs}
                    onChange={(event) =>
                      setLocalInference({
                        ...draft.localInference,
                        shutdownTimeoutMs: Number(event.target.value)
                      })
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
                      JSON.stringify(draft.localInference.requestDefaults.chatTemplateParameters)
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
                      setLocalInference({
                        ...draft.localInference,
                        requestDefaults: {
                          ...draft.localInference.requestDefaults,
                          chatTemplateParameters: validated.data
                        }
                      });
                    }}
                  />
                </Field>

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
