/**
 * IPC registration.
 *
 * A single `ipcMain.handle` for a single channel. The operation the renderer
 * wants travels *inside* the payload and is looked up in a fixed table, which
 * means:
 *
 *   * an unknown operation name is rejected before any handler code runs;
 *   * every payload is parsed with the channel's Zod schema, so handlers receive
 *     a value of the declared type or nothing at all;
 *   * handlers never reject — errors are normalised into a redacted
 *     {@link SerializedError}, so the renderer cannot be handed a stack trace.
 *
 * There is no channel anywhere in this table that accepts a command, an
 * executable path to run, or a script. The renderer cannot ask the main process
 * to run something; it can only ask for one of these named operations.
 */

import { dialog, ipcMain, type BrowserWindow } from 'electron/main';
import { shell } from 'electron/common';
import { AgentRelayError, toSerializedError } from '../../shared/domain/errors';
import {
  ipcInputSchemas,
  isIpcChannel,
  type IpcChannel,
  type IpcInput,
  type IpcResponseMap,
  type IpcResult
} from '../../shared/ipc';
import { IPC_INVOKE_CHANNEL } from '../../shared/ipc-channels';
import type { Application } from '../container';
import { assertKnownPath } from '../services/path-safety';

/** Hosts the app is allowed to open in the user's browser. */
const ALLOWED_EXTERNAL_HOSTS = new Set([
  'github.com',
  'www.github.com',
  'cli.github.com',
  'docs.github.com',
  'git-scm.com',
  'docs.anthropic.com',
  'developers.openai.com',
  'platform.openai.com'
]);

type Handlers = {
  [C in IpcChannel]: (input: IpcInput<C>) => Promise<IpcResponseMap[C]> | IpcResponseMap[C];
};

export interface IpcContext {
  readonly app: Application;
  readonly getWindow: () => BrowserWindow | null;
}

function buildHandlers({ app, getWindow }: IpcContext): Handlers {
  /** Roots the renderer is allowed to ask the shell to reveal. */
  const knownRoots = (): string[] => {
    const settings = app.settings.get();
    return [
      settings.worktreesRoot,
      settings.projectsRoot,
      ...app.projects.list().map((project) => project.localPath)
    ];
  };

  return {
    'settings:get': () => app.settings.get(),
    'settings:update': (input) => app.settings.update(input),

    'diagnostics:run': (input) => app.diagnostics.run(input.force ?? false),

    'dialog:pickDirectory': async (input) => {
      const window = getWindow();
      const options = {
        title: input.title ?? 'Choose a folder',
        defaultPath: input.defaultPath,
        properties: ['openDirectory' as const, 'createDirectory' as const]
      };
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);

      return result.canceled ? null : (result.filePaths[0] ?? null);
    },

    'projects:list': () => app.projectService.list(),
    'projects:validatePath': (input) => app.projectService.validatePath(input.localPath),
    'projects:addExisting': (input) => app.projectService.addExisting(input),
    'projects:createNew': (input) => app.projectService.createNew(input),
    'projects:initGit': (input) => app.projectService.initGit(input.projectId),
    'projects:update': (input) => app.projectService.update(input.projectId, input),
    'projects:forget': (input) => {
      app.projectService.forget(input.projectId);
      return { removed: true as const };
    },

    'tasks:list': (input) => app.taskService.listByProject(input.projectId),
    'tasks:get': (input) => app.taskService.detail(input.taskId),
    'tasks:create': (input) => app.taskService.create(input),

    'runs:listByTask': (input) => app.runs.listByTask(input.taskId),
    'runs:events': (input) =>
      app.runEvents.listByRun(input.runId, {
        ...(input.afterId === undefined ? {} : { afterId: input.afterId }),
        ...(input.limit === undefined ? {} : { limit: input.limit })
      }),

    'workflow:generateSpecification': (input) =>
      app.orchestrator.generateSpecification(input.taskId),
    'workflow:approveSpecification': (input) => app.orchestrator.approveSpecification(input.taskId),
    'workflow:sendToClaude': (input) =>
      app.orchestrator.sendToClaude(input.taskId, {
        acceptDirtyWorkingTree: input.acceptDirtyWorkingTree ?? false
      }),
    'workflow:reviewWithCodex': (input) => app.orchestrator.reviewWithCodex(input.taskId),
    'workflow:sendCorrections': (input) => app.orchestrator.sendCorrections(input.taskId),
    'workflow:stop': (input) => app.orchestrator.stop(input.taskId),
    'workflow:approveForPublishing': (input) => app.orchestrator.approveForPublishing(input.taskId),

    'git:changes': (input) => app.orchestrator.collectChanges(input.taskId),
    'git:repositoryInfo': async (input) => {
      const project = app.projects.findById(input.projectId);
      if (!project) throw new AgentRelayError('NOT_FOUND', 'No such project.');
      const validation = await app.projectService.validatePath(project.localPath);
      if (!validation.repository) {
        throw new AgentRelayError('GIT_FAILED', 'Could not read that repository.');
      }
      return validation.repository;
    },

    'publish:prepare': (input) => app.publishService.prepare(input),
    'publish:execute': (input) => app.publishService.execute(input),

    'shell:openExternal': async (input) => {
      let url: URL;
      try {
        url = new URL(input.url);
      } catch {
        throw new AgentRelayError('VALIDATION_FAILED', 'That is not a valid URL.');
      }
      if (url.protocol !== 'https:') {
        throw new AgentRelayError('VALIDATION_FAILED', 'Only https links can be opened.');
      }
      if (!ALLOWED_EXTERNAL_HOSTS.has(url.hostname.toLowerCase())) {
        throw new AgentRelayError(
          'VALIDATION_FAILED',
          `Agent Relay will not open links to ${url.hostname}.`
        );
      }
      await shell.openExternal(url.toString());
      return { opened: true };
    },

    'shell:revealPath': async (input) => {
      // Only paths Agent Relay itself manages may be revealed.
      assertKnownPath(input.path, knownRoots());
      const error = await shell.openPath(input.path);
      if (error) {
        throw new AgentRelayError('INTERNAL', `The shell could not open that path: ${error}`);
      }
      return { opened: true };
    }
  };
}

export function registerIpc(context: IpcContext): void {
  const handlers = buildHandlers(context);

  ipcMain.handle(
    IPC_INVOKE_CHANNEL,
    async (_event, payload: unknown): Promise<IpcResult<unknown>> => {
      try {
        if (typeof payload !== 'object' || payload === null) {
          throw new AgentRelayError('VALIDATION_FAILED', 'Malformed IPC payload.');
        }

        const { channel, input } = payload as { channel?: unknown; input?: unknown };

        if (!isIpcChannel(channel)) {
          throw new AgentRelayError('VALIDATION_FAILED', `Unknown operation: ${String(channel)}`);
        }

        const parsed = ipcInputSchemas[channel].safeParse(input ?? {});
        if (!parsed.success) {
          throw new AgentRelayError('VALIDATION_FAILED', `Invalid input for "${channel}".`, {
            details: parsed.error.issues
              .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
              .join('; ')
          });
        }

        // The table is keyed by the same union the schema map is, so this cast is
        // safe by construction; TypeScript cannot narrow both sides together.
        const handler = handlers[channel] as (value: unknown) => Promise<unknown> | unknown;
        const data = await handler(parsed.data);

        return { ok: true, data };
      } catch (error) {
        return { ok: false, error: toSerializedError(error) };
      }
    }
  );
}

export function unregisterIpc(): void {
  ipcMain.removeHandler(IPC_INVOKE_CHANNEL);
}
