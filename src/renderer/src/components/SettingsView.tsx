import { useState } from 'react';
import type { ToolDiagnostic } from '@shared/domain/diagnostics';
import type { Settings } from '@shared/domain/models';
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
  const { settings, diagnostics, refreshDiagnostics, refreshSettings, perform, notify } = useStore();

  // Only the user's unsaved edits are held locally; the baseline is whatever the
  // store currently has. Deriving rather than copying means a settings refresh
  // cannot silently clobber an in-progress edit, and there is no sync effect.
  const [edits, setEdits] = useState<Settings | null>(null);
  const draft = edits ?? settings;
  const [checking, setChecking] = useState(false);

  const tools: ToolDiagnostic[] = diagnostics
    ? [diagnostics.codex, diagnostics.claude, diagnostics.git, diagnostics.github]
    : [];

  const set = <K extends keyof Settings>(key: K, value: Settings[K]): void => {
    if (!draft) return;
    setEdits({ ...draft, [key]: value });
  };

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

                <Field label="Codex model" hint="Leave empty to use the Codex default.">
                  <input
                    className="input input--mono"
                    value={draft.codexModel ?? ''}
                    placeholder="(default)"
                    onChange={(e) => set('codexModel', e.target.value.trim() || null)}
                  />
                </Field>
              </div>
            </Card>

            <div className="row">
              <button
                type="button"
                className="btn btn--primary"
                onClick={() =>
                  void perform('save-settings', 'Could not save settings', async () => {
                    await expect('settings:update', draft);
                    setEdits(null);
                    await refreshSettings();
                    await refreshDiagnostics(true);
                    notify({ tone: 'success', title: 'Settings saved' });
                  })
                }
              >
                Save settings
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => setEdits(null)}>
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
