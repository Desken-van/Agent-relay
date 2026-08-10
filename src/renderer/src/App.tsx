import { AppRail } from './components/AppRail';
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
  settings: 'Settings'
};

export function App(): React.JSX.Element {
  const { section, loading, selectedProject, detail } = useStore();

  return (
    <div className="shell">
      <AppRail />

      <main className="main">
        <header className="topbar">
          <span className="topbar__title">{TITLES[section] ?? 'Agent Relay'}</span>

          {section !== 'settings' && selectedProject ? (
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
          {loading ? (
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
