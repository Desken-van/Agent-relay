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
import { call, expect } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { useStore } from '../state/store';
import { Card, Field, Notice, Spinner, ToolDot } from './primitives';

const TOOL_TITLES: Record<string, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  git: 'Git',
  github: 'GitHub CLI'
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

  const tools: ToolDiagnostic[] = diagnostics
    ? [diagnostics.codex, diagnostics.claude, diagnostics.git, diagnostics.github]
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
    blockingProblems: verificationProblems.length
  });

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
                  hint="An agent run is cancelled after this long."
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
                  label="Claude verification commands"
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
