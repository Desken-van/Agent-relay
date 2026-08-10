/**
 * Channel names only — deliberately dependency-free.
 *
 * The preload bundle runs inside a sandboxed renderer, so it must not pull in
 * anything that would have to be resolved from `node_modules` at runtime (and
 * we do not want Zod inlined into it either). Keeping the two channel constants
 * in their own leaf module lets the preload import them without dragging in the
 * validation layer, which belongs exclusively to the main process.
 */

/** Single request/response channel; the operation name travels in the payload. */
export const IPC_INVOKE_CHANNEL = 'agent-relay:invoke';

/** Single push channel from the main process to the renderer. */
export const APP_EVENT_CHANNEL = 'agent-relay:event';
