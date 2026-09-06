/**
 * Application state for the renderer.
 *
 * Deliberately a single context with a hand-rolled reducer rather than a state
 * library: the shape is small, every mutation originates either from an IPC
 * response or a push event, and being able to read the whole state machine in
 * one file is worth more here than ergonomics.
 *
 * Live agent output arrives on the push channel and is appended to
 * `liveEvents`; durable history is re-read from SQLite whenever a task is
 * opened, so a dropped push event costs nothing.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode
} from 'react';
import type { CodexModelCatalogResult } from '@shared/domain/codex-catalog';
import type { DiagnosticsReport } from '@shared/domain/diagnostics';
import type { SerializedError } from '@shared/domain/errors';
import type { Project, Run, RunEvent, Settings, Task } from '@shared/domain/models';
import type { AppEvent, TaskDetail } from '@shared/ipc';
import { call, describeError, expect } from '../lib/api';

/**
 * `operations` is deliberately not gated on a project or a task.
 *
 * An operational target has nothing to do with the development workflow: it is
 * something outside Agent Relay that somebody wants to look at, and requiring a
 * repository to be selected first would imply a relationship that does not
 * exist. Its state lives in its own provider, not in this store.
 */
export type Section = 'projects' | 'tasks' | 'run' | 'operations' | 'settings';

export interface Toast {
  readonly id: number;
  readonly tone: 'info' | 'success' | 'error';
  readonly title: string;
  readonly body?: string;
  readonly remediation?: string;
}

interface State {
  section: Section;
  projects: Project[];
  selectedProjectId: string | null;
  tasks: Task[];
  selectedTaskId: string | null;
  detail: TaskDetail | null;
  /** Events streamed since this task was opened, keyed by run id. */
  liveEvents: Record<string, RunEvent[]>;
  settings: Settings | null;
  diagnostics: DiagnosticsReport | null;
  /** Picker-visible Codex models; null until the first load finishes. */
  codexModels: CodexModelCatalogResult | null;
  codexModelsLoading: boolean;
  busy: Record<string, boolean>;
  toasts: Toast[];
  loading: boolean;
}

type Action =
  | { type: 'section'; section: Section }
  | { type: 'projects'; projects: Project[] }
  | { type: 'project-upserted'; project: Project }
  | { type: 'select-project'; projectId: string | null }
  | { type: 'tasks'; tasks: Task[] }
  | { type: 'task-upserted'; task: Task }
  | { type: 'select-task'; taskId: string | null }
  | { type: 'detail'; detail: TaskDetail | null }
  | { type: 'run-upserted'; run: Run }
  | { type: 'run-event'; event: RunEvent }
  | { type: 'clear-live' }
  | { type: 'settings'; settings: Settings }
  | { type: 'diagnostics'; diagnostics: DiagnosticsReport }
  | { type: 'codex-models'; catalog: CodexModelCatalogResult }
  | { type: 'codex-models-loading'; value: boolean }
  | { type: 'busy'; key: string; value: boolean }
  | { type: 'toast'; toast: Toast }
  | { type: 'dismiss-toast'; id: number }
  | { type: 'loading'; value: boolean };

const initialState: State = {
  section: 'projects',
  projects: [],
  selectedProjectId: null,
  tasks: [],
  selectedTaskId: null,
  detail: null,
  liveEvents: {},
  settings: null,
  diagnostics: null,
  codexModels: null,
  codexModelsLoading: false,
  busy: {},
  toasts: [],
  loading: true
};

const MAX_LIVE_EVENTS_PER_RUN = 800;

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'section':
      return { ...state, section: action.section };

    case 'projects':
      return { ...state, projects: action.projects };

    case 'project-upserted': {
      const exists = state.projects.some((p) => p.id === action.project.id);
      return {
        ...state,
        projects: exists
          ? state.projects.map((p) => (p.id === action.project.id ? action.project : p))
          : [...state.projects, action.project].sort((a, b) => a.name.localeCompare(b.name))
      };
    }

    case 'select-project':
      return {
        ...state,
        selectedProjectId: action.projectId,
        tasks: [],
        selectedTaskId: null,
        detail: null,
        liveEvents: {}
      };

    case 'tasks':
      return { ...state, tasks: action.tasks };

    case 'task-upserted': {
      const tasks = state.tasks.some((t) => t.id === action.task.id)
        ? state.tasks.map((t) => (t.id === action.task.id ? action.task : t))
        : [action.task, ...state.tasks];

      return {
        ...state,
        tasks,
        detail:
          state.detail && state.detail.task.id === action.task.id
            ? { ...state.detail, task: action.task }
            : state.detail
      };
    }

    case 'select-task':
      return { ...state, selectedTaskId: action.taskId, detail: null, liveEvents: {} };

    case 'detail':
      return { ...state, detail: action.detail };

    case 'run-upserted': {
      if (!state.detail || state.detail.task.id !== action.run.taskId) return state;
      const runs = state.detail.runs.some((r) => r.id === action.run.id)
        ? state.detail.runs.map((r) => (r.id === action.run.id ? action.run : r))
        : [...state.detail.runs, action.run];
      return { ...state, detail: { ...state.detail, runs } };
    }

    case 'run-event': {
      const existing = state.liveEvents[action.event.runId] ?? [];
      // Cap the in-memory buffer; the full history stays in SQLite.
      const next = [...existing, action.event].slice(-MAX_LIVE_EVENTS_PER_RUN);
      return { ...state, liveEvents: { ...state.liveEvents, [action.event.runId]: next } };
    }

    case 'clear-live':
      return { ...state, liveEvents: {} };

    case 'settings':
      return { ...state, settings: action.settings };

    case 'diagnostics':
      return { ...state, diagnostics: action.diagnostics };

    case 'codex-models':
      return { ...state, codexModels: action.catalog, codexModelsLoading: false };

    case 'codex-models-loading':
      return { ...state, codexModelsLoading: action.value };

    case 'busy':
      return { ...state, busy: { ...state.busy, [action.key]: action.value } };

    case 'toast':
      return { ...state, toasts: [...state.toasts.slice(-4), action.toast] };

    case 'dismiss-toast':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };

    case 'loading':
      return { ...state, loading: action.value };

    default:
      return state;
  }
}

export interface StoreValue extends State {
  readonly selectedProject: Project | null;
  setSection(section: Section): void;
  selectProject(projectId: string | null): void;
  selectTask(taskId: string | null): void;
  refreshProjects(): Promise<void>;
  refreshTasks(projectId: string): Promise<void>;
  refreshDetail(taskId: string): Promise<void>;
  refreshSettings(): Promise<void>;
  refreshDiagnostics(force?: boolean): Promise<void>;
  refreshCodexModels(refresh?: boolean): Promise<void>;
  notify(toast: Omit<Toast, 'id'>): void;
  notifyError(title: string, error: unknown): void;
  dismissToast(id: number): void;
  /** Run an async action with a busy flag and standard error reporting. */
  perform<T>(key: string, title: string, action: () => Promise<T>): Promise<T | null>;
}

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [state, dispatch] = useReducer(reducer, initialState);
  const toastId = useRef(0);

  // The push-event listener is registered once and must not be torn down on
  // every selection change, so it reads the current task through a ref rather
  // than closing over the value. The ref is written in an effect, never during
  // render, so a concurrent render cannot observe a torn value.
  const selectedTaskRef = useRef<string | null>(null);
  useEffect(() => {
    selectedTaskRef.current = state.selectedTaskId;
  }, [state.selectedTaskId]);

  const notify = useCallback((toast: Omit<Toast, 'id'>) => {
    toastId.current += 1;
    const id = toastId.current;
    dispatch({ type: 'toast', toast: { ...toast, id } });
    if (toast.tone !== 'error') {
      window.setTimeout(() => dispatch({ type: 'dismiss-toast', id }), 6000);
    }
  }, []);

  const notifyError = useCallback(
    (title: string, error: unknown) => {
      const described: SerializedError = describeError(error);
      notify({
        tone: 'error',
        title,
        body: described.message,
        ...(described.remediation === undefined ? {} : { remediation: described.remediation })
      });
    },
    [notify]
  );

  const refreshProjects = useCallback(async () => {
    const result = await call('projects:list', {});
    if (result.ok) dispatch({ type: 'projects', projects: result.data });
    else notifyError('Could not load projects', new Error(result.error.message));
  }, [notifyError]);

  const refreshTasks = useCallback(
    async (projectId: string) => {
      const result = await call('tasks:list', { projectId });
      if (result.ok) dispatch({ type: 'tasks', tasks: result.data });
      else notifyError('Could not load tasks', new Error(result.error.message));
    },
    [notifyError]
  );

  const refreshDetail = useCallback(
    async (taskId: string) => {
      const result = await call('tasks:get', { taskId });
      if (result.ok) dispatch({ type: 'detail', detail: result.data });
      else notifyError('Could not load the task', new Error(result.error.message));
    },
    [notifyError]
  );

  const refreshSettings = useCallback(async () => {
    const result = await call('settings:get', {});
    if (result.ok) dispatch({ type: 'settings', settings: result.data });
  }, []);

  const refreshDiagnostics = useCallback(async (force = false) => {
    const result = await call('diagnostics:run', { force });
    if (result.ok) dispatch({ type: 'diagnostics', diagnostics: result.data });
  }, []);

  /**
   * Load the Codex catalogue. Never throws and never blocks the task form: an
   * unreachable catalogue simply arrives as `available: false`, and the picker
   * falls back to Tool default plus a typed model id.
   */
  const refreshCodexModels = useCallback(async (refresh = false) => {
    dispatch({ type: 'codex-models-loading', value: true });
    const result = await call('codex:listModels', { refresh });
    dispatch({
      type: 'codex-models',
      catalog: result.ok
        ? result.data
        : { available: false, models: [], detail: 'The Codex model list could not be read.' }
    });
  }, []);

  const perform = useCallback(
    async <T,>(key: string, title: string, action: () => Promise<T>): Promise<T | null> => {
      dispatch({ type: 'busy', key, value: true });
      try {
        return await action();
      } catch (error) {
        notifyError(title, error);
        return null;
      } finally {
        dispatch({ type: 'busy', key, value: false });
      }
    },
    [notifyError]
  );

  // Initial load.
  useEffect(() => {
    void (async () => {
      await Promise.all([refreshProjects(), refreshSettings()]);
      dispatch({ type: 'loading', value: false });
      await refreshDiagnostics(false);
      await refreshCodexModels(false);
    })();
  }, [refreshProjects, refreshSettings, refreshDiagnostics, refreshCodexModels]);

  // Push events from the main process.
  useEffect(() => {
    if (typeof window.agentRelay?.onEvent !== 'function') return undefined;

    return window.agentRelay.onEvent((event: AppEvent) => {
      switch (event.kind) {
        case 'task-updated':
          dispatch({ type: 'task-upserted', task: event.task });
          break;
        case 'project-updated':
          dispatch({ type: 'project-upserted', project: event.project });
          break;
        case 'run-started':
        case 'run-updated':
          dispatch({ type: 'run-upserted', run: event.run });
          break;
        case 'run-event':
          if (event.taskId === selectedTaskRef.current) {
            dispatch({ type: 'run-event', event: event.event });
          }
          break;
        case 'diagnostics':
          dispatch({ type: 'diagnostics', diagnostics: event.report });
          break;
        default:
          break;
      }
    });
  }, []);

  const value = useMemo<StoreValue>(
    () => ({
      ...state,
      selectedProject: state.projects.find((p) => p.id === state.selectedProjectId) ?? null,
      setSection: (section) => dispatch({ type: 'section', section }),
      selectProject: (projectId) => dispatch({ type: 'select-project', projectId }),
      selectTask: (taskId) => dispatch({ type: 'select-task', taskId }),
      refreshProjects,
      refreshTasks,
      refreshDetail,
      refreshSettings,
      refreshDiagnostics,
      refreshCodexModels,
      notify,
      notifyError,
      dismissToast: (id) => dispatch({ type: 'dismiss-toast', id }),
      perform
    }),
    [
      state,
      refreshProjects,
      refreshTasks,
      refreshDetail,
      refreshSettings,
      refreshDiagnostics,
      refreshCodexModels,
      notify,
      notifyError,
      perform
    ]
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const value = useContext(StoreContext);
  if (!value) throw new Error('useStore must be used inside <StoreProvider>.');
  return value;
}

export { expect as apiExpect };
