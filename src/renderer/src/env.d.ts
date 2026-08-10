/// <reference types="vite/client" />

import type { AgentRelayApi } from '../../preload';

declare global {
  interface Window {
    /** The only bridge the renderer has to the main process. */
    readonly agentRelay: AgentRelayApi;
  }
}

export {};
