/**
 * The preload bridge.
 *
 * This is the *entire* surface the renderer gets. It exposes:
 *
 *   * `invoke(channel, input)` — a fixed set of named operations. The channel
 *     name is a member of a compile-time union and is re-validated in the main
 *     process against a Zod schema; there is no channel that accepts a command
 *     line, a file path to execute, or arbitrary code.
 *   * `onEvent(listener)` — a read-only subscription to push updates.
 *
 * Note what is *not* here: no `require`, no `fs`, no `child_process`, no
 * `ipcRenderer` itself. `contextBridge` copies primitives across the isolated
 * world boundary, so the renderer can never reach an Electron internal by
 * walking the prototype chain of something we handed it.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { APP_EVENT_CHANNEL, IPC_INVOKE_CHANNEL } from '../shared/ipc-channels';
import type { AppEvent, IpcChannel, IpcInput, IpcResponseMap, IpcResult } from '../shared/ipc';

export interface AgentRelayApi {
  invoke<C extends IpcChannel>(channel: C, input: IpcInput<C>): Promise<IpcResult<IpcResponseMap[C]>>;
  onEvent(listener: (event: AppEvent) => void): () => void;
}

const api: AgentRelayApi = {
  invoke: (channel, input) => ipcRenderer.invoke(IPC_INVOKE_CHANNEL, { channel, input }),

  onEvent: (listener) => {
    const handler = (_event: IpcRendererEvent, payload: AppEvent): void => {
      listener(payload);
    };
    ipcRenderer.on(APP_EVENT_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(APP_EVENT_CHANNEL, handler);
    };
  }
};

contextBridge.exposeInMainWorld('agentRelay', api);
