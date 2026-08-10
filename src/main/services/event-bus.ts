/**
 * Push channel from the main process to the renderer.
 *
 * One-way and fire-and-forget: the renderer subscribes, and events are dropped
 * silently when no window is open (e.g. during shutdown, or while an agent run
 * finishes after the window closed). Losing a progress event is fine; every
 * piece of durable state is in SQLite and re-read on mount.
 */

import type { BrowserWindow } from 'electron/main';
import type { DiagnosticsReport } from '../../shared/domain/diagnostics';
import type { Project, Run, RunEvent, Task } from '../../shared/domain/models';
import { APP_EVENT_CHANNEL } from '../../shared/ipc-channels';
import type { AppEvent } from '../../shared/ipc';
import type { EventPublisher } from '../ports';

export class WindowEventPublisher implements EventPublisher {
  private window: BrowserWindow | null = null;

  attach(window: BrowserWindow): void {
    this.window = window;
    window.on('closed', () => {
      if (this.window === window) this.window = null;
    });
  }

  private send(event: AppEvent): void {
    const target = this.window;
    if (!target || target.isDestroyed() || target.webContents.isDestroyed()) return;
    target.webContents.send(APP_EVENT_CHANNEL, event);
  }

  publishTask(task: Task): void {
    this.send({ kind: 'task-updated', task });
  }

  publishProject(project: Project): void {
    this.send({ kind: 'project-updated', project });
  }

  publishRun(run: Run, kind: 'run-started' | 'run-updated'): void {
    this.send(kind === 'run-started' ? { kind: 'run-started', run } : { kind: 'run-updated', run });
  }

  publishRunEvent(taskId: string, event: RunEvent): void {
    this.send({ kind: 'run-event', taskId, event });
  }

  publishDiagnostics(report: DiagnosticsReport): void {
    this.send({ kind: 'diagnostics', report });
  }
}

/** Collects events in memory. Used by tests and by headless startup. */
export class InMemoryEventPublisher implements EventPublisher {
  readonly events: AppEvent[] = [];

  publishTask(task: Task): void {
    this.events.push({ kind: 'task-updated', task });
  }

  publishProject(project: Project): void {
    this.events.push({ kind: 'project-updated', project });
  }

  publishRun(run: Run, kind: 'run-started' | 'run-updated'): void {
    this.events.push(kind === 'run-started' ? { kind: 'run-started', run } : { kind: 'run-updated', run });
  }

  publishRunEvent(taskId: string, event: RunEvent): void {
    this.events.push({ kind: 'run-event', taskId, event });
  }

  publishDiagnostics(report: DiagnosticsReport): void {
    this.events.push({ kind: 'diagnostics', report });
  }
}
