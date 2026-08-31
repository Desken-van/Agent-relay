/**
 * The Codex model catalogue, read from the CLI's app-server protocol.
 *
 * The SDK exposes no way to list models, so this speaks JSON-RPC over stdio to
 * `codex app-server`: `initialize` → `initialized` → `model/list`, paging on
 * `nextCursor`. It never starts a thread or a turn — listing models must not be
 * able to cost anything or touch a conversation.
 *
 * Why an interactive runner and not `run({ input })`: the server begins shutting
 * down when stdin reaches EOF, and the `model/list` reply never arrives. The
 * conversation has to stay open until the last page is in hand.
 *
 * The result is deliberately lossy on the way out. `initialize` answers with
 * `codexHome`, `userAgent` and platform details; none of that is any of the
 * renderer's business, so only four fields per model cross the boundary.
 */

import type {
  CodexModelCatalog,
  CodexModelCatalogResult,
  CodexModelOption
} from '../../ports';
import { locateExecutable } from '../process/executable-locator';
import type { InteractiveProcessRunner } from '../process/process-runner';
import { bundledCodexPaths } from './codex-adapter';

export interface CodexModelCatalogOptions {
  /**
   * Read the *current* configured Codex path, not a snapshot of it.
   *
   * A callback rather than a value because this object outlives a Settings
   * edit: the catalogue is built once so its cache is worth having, and taking
   * the path at construction time would mean pointing Settings at a different
   * Codex had no effect until the app restarted.
   */
  readonly getConfiguredPath?: () => string | null;
  readonly timeoutMs?: number;
}

/** Pages are 100 models; ten is far past any plausible catalogue. */
const MAX_PAGES = 10;
const PAGE_SIZE = 100;
const DEFAULT_TIMEOUT_MS = 60_000;

const INITIALIZE_ID = 1;
/** Request ids for pages start here, so no id is ever reused. */
const FIRST_PAGE_ID = 2;

type Phase = 'initializing' | 'listing' | 'done';

interface RawModel {
  readonly id?: unknown;
  readonly model?: unknown;
  readonly displayName?: unknown;
  readonly description?: unknown;
  readonly hidden?: unknown;
  readonly isDefault?: unknown;
}

/** A failure that should surface as `available: false`, never as an exception. */
class CatalogFailure extends Error {}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Keep only what the picker needs.
 *
 * `model` is the slug Codex expects in `ThreadOptions.model`; `id` is the
 * catalogue key and is used for nothing but matching, so it is not carried
 * outward. They happen to be equal today, which is exactly why the distinction
 * has to be encoded here rather than assumed.
 */
function toOption(raw: RawModel): CodexModelOption | null {
  const model = typeof raw.model === 'string' && raw.model.length > 0 ? raw.model : null;
  if (!model) return null;

  return {
    model,
    displayName:
      typeof raw.displayName === 'string' && raw.displayName.length > 0
        ? raw.displayName
        : model,
    description: typeof raw.description === 'string' ? raw.description : '',
    isDefault: raw.isDefault === true
  };
}

export class CodexAppServerModelCatalog implements CodexModelCatalog {
  private cache: { key: string; result: CodexModelCatalogResult } | null = null;

  constructor(
    private readonly runner: InteractiveProcessRunner,
    private readonly options: CodexModelCatalogOptions = {}
  ) {}

  /** Re-resolved on every call, so a Settings change takes effect immediately. */
  private resolveExecutable(): string | null {
    return (
      locateExecutable('codex', {
        configuredPath: this.options.getConfiguredPath?.() ?? null,
        bundledPaths: bundledCodexPaths()
      })?.path ?? null
    );
  }

  async list(options: { refresh?: boolean } = {}): Promise<CodexModelCatalogResult> {
    const executable = this.resolveExecutable();
    if (!executable) {
      return {
        available: false,
        models: [],
        detail: 'The Codex executable could not be found, so its model list is unavailable.'
      };
    }

    // Keyed on the resolved path: pointing Settings at a different Codex is a
    // different catalogue, and serving the old one would be a lie. A path
    // change therefore re-probes on its own, with no `refresh` needed.
    const key = executable;

    // Failures are cached as well as successes, deliberately. Without it every
    // render of the task form would spawn another app-server against a Codex
    // that is already known to be unreachable. `refresh: true` skips this
    // check, so a cached failure is never permanent.
    if (!options.refresh && this.cache?.key === key) {
      return this.cache.result;
    }

    const result = await this.probe(executable);
    this.cache = { key, result };
    return result;
  }

  private async probe(executable: string): Promise<CodexModelCatalogResult> {
    const models: CodexModelOption[] = [];
    // Ids we have sent and not yet had answered. The handshake counts: without
    // it, the server's own initialize reply looks unsolicited.
    const seenIds = new Set<number>([INITIALIZE_ID]);
    const seenCursors = new Set<string>();

    const state: { phase: Phase } = { phase: 'initializing' };
    let pages = 0;
    let nextId = FIRST_PAGE_ID;
    let failure: string | null = null;

    // Records the reason *and* aborts the session. The runner turns the throw
    // into a failed result; `failure` is what carries the human explanation,
    // since the raw error text must not be shown to the renderer.
    const fail: (detail: string) => never = (detail) => {
      failure ??= detail;
      throw new CatalogFailure(detail);
    };

    const requestPage = (
      controller: { writeLine(line: string): void },
      cursor: string | null
    ): void => {
      pages += 1;
      if (pages > MAX_PAGES) fail(`The model list did not finish within ${MAX_PAGES} pages.`);

      const id = nextId++;
      seenIds.add(id);
      controller.writeLine(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'model/list',
          params: { limit: PAGE_SIZE, includeHidden: false, ...(cursor ? { cursor } : {}) }
        })
      );
    };

    const result = await this.runner.runInteractive(executable, ['app-server'], {
      timeoutMs: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      // Two per page at most, plus the handshake — nowhere near the default cap.
      maxInputMessages: MAX_PAGES + 4,

      onStart(controller) {
        controller.writeLine(
          JSON.stringify({
            jsonrpc: '2.0',
            id: INITIALIZE_ID,
            method: 'initialize',
            params: {
              clientInfo: { name: 'agent-relay', version: '0.1.0' },
              capabilities: { experimentalApi: false }
            }
          })
        );
      },

      onStdoutLine(line, controller) {
        if (state.phase === 'done') return;

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          // Anything non-JSON on stdout means we are not talking the protocol
          // we think we are; guessing past it risks trusting a partial list.
          fail('The Codex app-server produced output that is not valid JSON-RPC.');
        }
        const message = asRecord(parsed);
        if (!message) fail('The Codex app-server produced an unexpected JSON-RPC payload.');

        // Server-initiated notifications carry no id and are simply not ours.
        if (message['id'] === undefined) return;

        if (message['error'] !== undefined) {
          fail('The Codex app-server rejected the model list request.');
        }

        const id: unknown = message['id'];
        if (typeof id !== 'number' || !seenIds.has(id)) {
          fail('The Codex app-server answered a request that was never sent.');
        }
        const responseId: number = id;
        // Each id is answered exactly once; a repeat means the stream is not
        // the well-formed exchange this parser assumes.
        seenIds.delete(responseId);

        const maybePayload = asRecord(message['result']);
        if (!maybePayload) fail('The Codex app-server returned a response with no result.');
        const payload: Record<string, unknown> = maybePayload;

        if (responseId === INITIALIZE_ID) {
          if (state.phase !== 'initializing') fail('The Codex app-server initialised twice.');
          state.phase = 'listing';

          // Nothing from the initialize payload is retained: it carries
          // codexHome, userAgent and platform details.
          controller.writeLine(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }));
          requestPage(controller, null);
          return;
        }

        if (state.phase !== 'listing') {
          fail('The Codex app-server returned a model page before initialising.');
        }

        const data: unknown = payload['data'];
        if (!Array.isArray(data)) fail('The Codex model list was not in the expected shape.');
        const entries: unknown[] = data;

        for (const entry of entries) {
          const raw = asRecord(entry) as RawModel | null;
          if (!raw) continue;
          // Hidden models are excluded by the request; filtered again here so a
          // server that ignores `includeHidden: false` cannot surface them.
          if (raw.hidden === true) continue;

          const option = toOption(raw);
          if (option) models.push(option);
        }

        const cursor: unknown = payload['nextCursor'];
        if (typeof cursor === 'string' && cursor.length > 0) {
          if (seenCursors.has(cursor)) fail('The Codex model list repeated a page cursor.');
          seenCursors.add(cursor);
          requestPage(controller, cursor);
          return;
        }

        state.phase = 'done';
        controller.closeInput();
      }
    });

    // A callback failure arrives as a failed result rather than a throw.
    if (failure === null && result.failed && state.phase !== 'done') {
      failure = result.timedOut
        ? 'The Codex app-server did not answer in time.'
        : result.cancelled
          ? 'Listing Codex models was cancelled.'
          : 'The Codex app-server exited before returning a model list.';
    }

    if (state.phase !== 'done') {
      return {
        available: false,
        models: [],
        // `result.stderr` is deliberately not included: it is unbounded,
        // tool-authored text that has no place in the renderer.
        detail: failure ?? 'The Codex app-server did not return a complete model list.'
      };
    }

    if (result.exitCode !== 0) {
      return {
        available: false,
        models: [],
        detail: `The Codex app-server exited with code ${result.exitCode ?? 'unknown'}.`
      };
    }

    return { available: true, models, detail: null };
  }
}
