import type { ToolDiagnostic, ToolId } from '@shared/domain/diagnostics';
import { useStore, type Section } from '../state/store';
import { ToolDot } from './primitives';

const SECTIONS: ReadonlyArray<{ id: Section; label: string; glyph: string }> = [
  { id: 'projects', label: 'Projects', glyph: '▤' },
  { id: 'tasks', label: 'Tasks', glyph: '◈' },
  { id: 'run', label: 'Run', glyph: '⟳' },
  { id: 'operations', label: 'Operations', glyph: '◎' },
  { id: 'settings', label: 'Settings', glyph: '⚙' }
];

const TOOL_LABELS: Record<ToolId, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  git: 'Git',
  github: 'GitHub CLI'
};

export function AppRail(): React.JSX.Element {
  const { section, setSection, selectedProjectId, selectedTaskId, tasks, diagnostics } = useStore();

  const tools: ToolDiagnostic[] = diagnostics
    ? [diagnostics.codex, diagnostics.claude, diagnostics.git, diagnostics.github]
    : [];

  return (
    <nav className="rail">
      <div className="rail__brand">
        <div className="rail__mark" />
        <div>
          <div className="rail__title">Agent Relay</div>
          <div className="rail__sub">Codex ⇄ Claude</div>
        </div>
      </div>

      <div className="rail__nav">
        {SECTIONS.map((item) => {
          const disabled =
            (item.id === 'tasks' && !selectedProjectId) || (item.id === 'run' && !selectedTaskId);

          return (
            <button
              key={item.id}
              type="button"
              className="rail__item"
              aria-current={section === item.id}
              disabled={disabled}
              onClick={() => setSection(item.id)}
              title={
                disabled
                  ? item.id === 'tasks'
                    ? 'Select a project first'
                    : 'Select a task first'
                  : undefined
              }
            >
              <span aria-hidden>{item.glyph}</span>
              {item.label}
              {item.id === 'tasks' && tasks.length > 0 ? (
                <span className="rail__badge">{tasks.length}</span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div className="rail__spacer" />

      <div className="rail__tools">
        <div className="rail__sub" style={{ padding: '0 6px 4px' }}>
          Tools
        </div>
        {tools.length === 0 ? (
          <div className="faint" style={{ fontSize: 11, padding: '0 6px' }}>
            Checking…
          </div>
        ) : (
          tools.map((tool) => (
            <button
              key={tool.tool}
              type="button"
              className="toolchip"
              onClick={() => setSection('settings')}
              title={tool.detail}
            >
              <ToolDot status={tool.status} />
              {TOOL_LABELS[tool.tool]}
            </button>
          ))
        )}
      </div>
    </nav>
  );
}
