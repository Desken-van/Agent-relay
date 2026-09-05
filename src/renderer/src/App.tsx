import { AppRail } from './components/AppRail';
import { OperationsView } from './components/OperationsView';
import { ProjectsView } from './components/ProjectsView';
import { Rounds, StatusBadge } from './components/primitives';
import { RunView } from './components/RunView';
import { SettingsView } from './components/SettingsView';
import { TasksView } from './components/TasksView';
import { Toasts } from './components/Toasts';
import { useStore } from './state/store';

const TITLES: Record<string, string> = {
  projects: 'Projects',
  tasks: 'Tasks',
  run: 'Run',
  operations: 'Operations',
  settings: 'Settings'
};

/**
 * Sections that have nothing to do with the selected repository.
 *
 * Showing a project name beside "Operations" would suggest the target being
 * inspected belongs to it, which is exactly the association this workflow does
 * not have.
 */
const PROJECT_FREE_SECTIONS = new Set(['settings', 'operations']);

export function App(): React.JSX.Element {
  const { section, loading, selectedProject, detail } = useStore();

  return (
    <div className="shell">
      <AppRail />

      <main className="main">
        <header className="topbar">
          <span className="topbar__title">{TITLES[section] ?? 'Agent Relay'}</span>

          {!PROJECT_FREE_SECTIONS.has(section) && selectedProject ? (
            <span className="topbar__meta">
              {selectedProject.name}
              <span className="faint"> · {selectedProject.defaultBranch}</span>
            </span>
          ) : null}

          {section === 'run' && detail ? (
            <div className="topbar__actions">
              <Rounds used={detail.task.currentRound} max={detail.task.maxRounds} />
              <StatusBadge status={detail.task.status} />
            </div>
          ) : null}
        </header>

        <div className="content">
          {/*
            Operations is checked before the bootstrap gate, not after it.
            It keeps its own state and needs neither a project nor a task, so
            a development-store load that never settles — a wedged bridge,
            say — must not be able to hold the one screen an operator would
            open to look at a database. An ordinary error resolves the
            bootstrap and opens the gate anyway; a hang does not.
          */}
          {section === 'operations' ? (
            <OperationsView />
          ) : loading ? (
            <div className="empty">Loading…</div>
          ) : section === 'projects' ? (
            <ProjectsView />
          ) : section === 'tasks' ? (
            <TasksView />
          ) : section === 'run' ? (
            <RunView />
          ) : (
            <SettingsView />
          )}
        </div>
      </main>

      <Toasts />
    </div>
  );
}
