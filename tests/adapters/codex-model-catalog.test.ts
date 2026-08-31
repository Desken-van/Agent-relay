import { describe, expect, it } from 'vitest';
import { CodexAppServerModelCatalog } from '../../src/main/adapters/codex/codex-model-catalog';
import type {
  InteractiveProcessRunner,
  InteractiveRunOptions,
  InteractiveSessionController,
  ProcessResult
} from '../../src/main/adapters/process/process-runner';

/**
 * A scripted app-server.
 *
 * Given a function that turns each written line into the lines to emit back,
 * it plays the conversation without ever spawning anything. No test here may
 * reach a real Codex.
 */
function fakeRunner(
  respond: (line: string, emit: (out: string) => void) => void,
  outcome: Partial<ProcessResult> = {}
): InteractiveProcessRunner & { calls: { file: string; args: string[] }[] } {
  const calls: { file: string; args: string[] }[] = [];

  return {
    calls,
    async runInteractive(
      file: string,
      args: readonly string[],
      options: InteractiveRunOptions
    ): Promise<ProcessResult> {
      calls.push({ file, args: [...args] });

      const pending: string[] = [];
      let closed = false;
      let failed = false;

      const controller: InteractiveSessionController = {
        writeLine(line) {
          if (closed) throw new Error('stdin is already closed.');
          respond(line, (out) => pending.push(out));
        },
        closeInput() {
          closed = true;
        }
      };

      try {
        await options.onStart?.(controller);
        while (pending.length > 0 && !closed) {
          const next = pending.shift();
          if (next === undefined) break;
          await options.onStdoutLine(next, controller);
        }
      } catch {
        // The real runner reports a callback throw as a failed result.
        failed = true;
      }

      return {
        command: `${file} ${args.join(' ')}`,
        exitCode: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        cancelled: false,
        durationMs: 1,
        failed,
        ...outcome
      };
    }
  };
}

const initializeResult = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  result: {
    userAgent: 'codex/0.147.0 (Windows)',
    codexHome: 'C:\\Users\\someone\\.codex',
    platformFamily: 'windows',
    platformOs: 'Windows 11'
  }
});

const model = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'gpt-5.6-sol',
  model: 'gpt-5.6-sol',
  displayName: 'GPT-5.6-Sol',
  description: 'Balanced default',
  hidden: false,
  isDefault: true,
  ...over
});

const page = (
  id: number,
  models: Record<string, unknown>[],
  nextCursor: string | null = null
): string => JSON.stringify({ jsonrpc: '2.0', id, result: { data: models, nextCursor } });

/** Standard happy-path script: initialize, then one page. */
function happyPath(models: Record<string, unknown>[] = [model()]) {
  return (line: string, emit: (out: string) => void): void => {
    const message = JSON.parse(line);
    if (message.method === 'initialize') emit(initializeResult);
    if (message.method === 'model/list') emit(page(message.id, models));
  };
}

// A resolved Codex executable is required, so point the locator at a real file.
const options = { getConfiguredPath: () => process.execPath as string | null };

describe('Codex model catalogue', () => {
  it('completes the handshake and returns picker-visible models', async () => {
    const runner = fakeRunner(happyPath());
    const result = await new CodexAppServerModelCatalog(runner, options).list();

    expect(result.available).toBe(true);
    expect(result.detail).toBeNull();
    expect(result.models).toEqual([
      {
        model: 'gpt-5.6-sol',
        displayName: 'GPT-5.6-Sol',
        description: 'Balanced default',
        isDefault: true
      }
    ]);
    expect(runner.calls[0]?.args).toEqual(['app-server']);
  });

  it('never asks for hidden models, and filters them again anyway', async () => {
    let requestedParams: Record<string, unknown> | null = null;

    const runner = fakeRunner((line, emit) => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') emit(initializeResult);
      if (message.method === 'model/list') {
        requestedParams = message.params;
        emit(
          page(message.id, [
            model(),
            model({ id: 'secret', model: 'secret', displayName: 'Secret', hidden: true })
          ])
        );
      }
    });

    const result = await new CodexAppServerModelCatalog(runner, options).list();

    expect(requestedParams).toMatchObject({ includeHidden: false, limit: 100 });
    expect(result.models.map((m) => m.model)).toEqual(['gpt-5.6-sol']);
  });

  it('stores the model slug, not the catalogue id, when they differ', async () => {
    const runner = fakeRunner(
      happyPath([model({ id: 'catalogue-entry-7', model: 'gpt-5.6-terra', displayName: 'Terra' })])
    );

    const result = await new CodexAppServerModelCatalog(runner, options).list();

    expect(result.models[0]?.model).toBe('gpt-5.6-terra');
    // The id must not leak out under any key.
    expect(JSON.stringify(result)).not.toContain('catalogue-entry-7');
  });

  it('follows nextCursor across pages', async () => {
    const runner = fakeRunner((line, emit) => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') return emit(initializeResult);
      if (message.method !== 'model/list') return;

      if (!message.params.cursor) {
        emit(page(message.id, [model({ id: 'a', model: 'a', displayName: 'A' })], 'cursor-2'));
      } else {
        emit(page(message.id, [model({ id: 'b', model: 'b', displayName: 'B' })], null));
      }
    });

    const result = await new CodexAppServerModelCatalog(runner, options).list();

    expect(result.available).toBe(true);
    expect(result.models.map((m) => m.model)).toEqual(['a', 'b']);
  });

  it('refuses a cursor that repeats', async () => {
    const runner = fakeRunner((line, emit) => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') return emit(initializeResult);
      if (message.method === 'model/list') emit(page(message.id, [model()], 'same-cursor'));
    });

    const result = await new CodexAppServerModelCatalog(runner, options).list();

    expect(result.available).toBe(false);
    expect(result.models).toEqual([]);
    expect(result.detail).toMatch(/cursor/i);
  });

  it('stops at the page limit instead of paging forever', async () => {
    let n = 0;
    const runner = fakeRunner((line, emit) => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') return emit(initializeResult);
      if (message.method === 'model/list') {
        n += 1;
        emit(page(message.id, [model({ id: `m${n}`, model: `m${n}` })], `cursor-${n}`));
      }
    });

    const result = await new CodexAppServerModelCatalog(runner, options).list();

    expect(result.available).toBe(false);
    expect(result.detail).toMatch(/10 pages/);
  });

  it.each([
    ['non-JSON output', () => 'this is not json', /not valid JSON-RPC/i],
    [
      'a JSON-RPC error',
      (id: number) => JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'nope' } }),
      /rejected/i
    ],
    [
      'a response with no result',
      (id: number) => JSON.stringify({ jsonrpc: '2.0', id }),
      /no result/i
    ],
    [
      'an unknown response id',
      () => JSON.stringify({ jsonrpc: '2.0', id: 99, result: {} }),
      /never sent/i
    ],
    [
      'a malformed model list',
      (id: number) => JSON.stringify({ jsonrpc: '2.0', id, result: { data: 'not-an-array' } }),
      /expected shape/i
    ]
  ])('fails safely on %s', async (_label, makeReply, expected) => {
    const runner = fakeRunner((line, emit) => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') return emit(initializeResult);
      if (message.method === 'model/list') emit((makeReply as (id: number) => string)(message.id));
    });

    const result = await new CodexAppServerModelCatalog(runner, options).list();

    expect(result.available).toBe(false);
    expect(result.models).toEqual([]);
    expect(result.detail).toMatch(expected as RegExp);
  });

  it('fails safely when the same id is answered twice', async () => {
    const runner = fakeRunner((line, emit) => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') {
        emit(initializeResult);
        // A second answer to the initialize id.
        emit(initializeResult);
      }
      if (message.method === 'model/list') emit(page(message.id, [model()], null));
    });

    const result = await new CodexAppServerModelCatalog(runner, options).list();
    expect(result.available).toBe(false);
    expect(result.detail).toMatch(/never sent/i);
  });

  it('ignores server notifications that carry no id', async () => {
    const runner = fakeRunner((line, emit) => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') {
        emit(JSON.stringify({ jsonrpc: '2.0', method: 'model/rerouted', params: {} }));
        emit(initializeResult);
      }
      if (message.method === 'model/list') emit(page(message.id, [model()], null));
    });

    const result = await new CodexAppServerModelCatalog(runner, options).list();
    expect(result.available).toBe(true);
    expect(result.models).toHaveLength(1);
  });

  it.each([
    ['a timeout', { failed: true, timedOut: true }, /in time/i],
    ['a cancellation', { failed: true, cancelled: true }, /cancelled/i],
    ['a non-zero exit', { failed: true, exitCode: 3 }, /exited/i]
  ])('reports %s without a partial catalogue', async (_label, outcome, expected) => {
    const runner = fakeRunner((line, emit) => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') emit(initializeResult);
      // No model/list reply at all.
    }, outcome as Partial<ProcessResult>);

    const result = await new CodexAppServerModelCatalog(runner, options).list();

    expect(result.available).toBe(false);
    expect(result.models).toEqual([]);
    expect(result.detail).toMatch(expected as RegExp);
  });

  it('never exposes initialize metadata or raw output', async () => {
    const runner = fakeRunner(happyPath());
    const result = await new CodexAppServerModelCatalog(runner, options).list();

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('codexHome');
    expect(serialised).not.toContain('.codex');
    expect(serialised).not.toContain('userAgent');
    expect(serialised).not.toContain('platformOs');
    expect(Object.keys(result.models[0] ?? {})).toEqual([
      'model',
      'displayName',
      'description',
      'isDefault'
    ]);
  });

  it('caches a successful result and re-probes when refresh is requested', async () => {
    let probes = 0;
    const runner = fakeRunner((line, emit) => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') {
        probes += 1;
        emit(initializeResult);
      }
      if (message.method === 'model/list') emit(page(message.id, [model()], null));
    });

    const catalog = new CodexAppServerModelCatalog(runner, options);

    await catalog.list();
    await catalog.list();
    expect(probes).toBe(1);

    await catalog.list({ refresh: true });
    expect(probes).toBe(2);
  });

  it('re-probes after a failure rather than caching it forever', async () => {
    let attempt = 0;
    const runner = fakeRunner((line, emit) => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') {
        attempt += 1;
        emit(initializeResult);
      }
      if (message.method === 'model/list') {
        // Broken the first time, healthy afterwards.
        emit(attempt === 1 ? 'garbage' : page(message.id, [model()], null));
      }
    });

    const catalog = new CodexAppServerModelCatalog(runner, options);

    expect((await catalog.list()).available).toBe(false);
    expect((await catalog.list({ refresh: true })).available).toBe(true);
  });

  it('re-resolves the path on every list, so one instance follows a Settings change', async () => {
    // The regression: the path used to be captured at construction, so editing
    // it in Settings had no effect until the application restarted. Two
    // separate instances could never have caught that — this is one instance
    // whose provider changes underneath it.
    const probedWith: string[] = [];
    const runner = fakeRunner((line, emit) => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') emit(initializeResult);
      if (message.method === 'model/list') emit(page(message.id, [model()], null));
    });

    // Two real files so the locator resolves both.
    const pathA = process.execPath;
    const pathB = process.argv[1] ?? process.execPath;
    let current: string | null = pathA;

    const catalog = new CodexAppServerModelCatalog(runner, {
      getConfiguredPath: () => current
    });

    await catalog.list();
    await catalog.list();
    probedWith.push(...runner.calls.map((call) => call.file));
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.file).toBe(pathA);

    // Settings now point somewhere else. No refresh flag is passed.
    current = pathB;
    await catalog.list();

    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1]?.file).toBe(pathB);
  });

  it('serves a cached failure without spawning again', async () => {
    let probes = 0;
    const runner = fakeRunner((line, emit) => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') {
        probes += 1;
        emit(initializeResult);
      }
      if (message.method === 'model/list') emit('not json at all');
    });

    const catalog = new CodexAppServerModelCatalog(runner, options);

    expect((await catalog.list()).available).toBe(false);
    expect((await catalog.list()).available).toBe(false);
    // The point of caching a failure: no second app-server for a Codex already
    // known to be unreachable.
    expect(probes).toBe(1);
  });

  it('recovers from a cached failure when refresh is requested', async () => {
    let probes = 0;
    const runner = fakeRunner((line, emit) => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') {
        probes += 1;
        emit(initializeResult);
      }
      if (message.method === 'model/list') {
        emit(probes === 1 ? 'not json at all' : page(message.id, [model()], null));
      }
    });

    const catalog = new CodexAppServerModelCatalog(runner, options);

    expect((await catalog.list()).available).toBe(false);
    expect((await catalog.list()).available).toBe(false);
    expect(probes).toBe(1);

    const recovered = await catalog.list({ refresh: true });
    expect(recovered.available).toBe(true);
    expect(probes).toBe(2);
  });

  it('re-probes after a failure when the path changes, without refresh', async () => {
    let probes = 0;
    const runner = fakeRunner((line, emit) => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') {
        probes += 1;
        emit(initializeResult);
      }
      if (message.method === 'model/list') {
        // Broken on the first path, healthy on the second.
        emit(probes === 1 ? 'not json at all' : page(message.id, [model()], null));
      }
    });

    let current: string | null = process.execPath;
    const catalog = new CodexAppServerModelCatalog(runner, {
      getConfiguredPath: () => current
    });

    expect((await catalog.list()).available).toBe(false);
    expect(probes).toBe(1);

    current = process.argv[1] ?? process.execPath;
    const afterChange = await catalog.list();

    expect(probes).toBe(2);
    expect(afterChange.available).toBe(true);
  });

  it('invalidates the cache when the resolved executable changes', async () => {
    let probes = 0;
    const runner = fakeRunner((line, emit) => {
      const message = JSON.parse(line);
      if (message.method === 'initialize') {
        probes += 1;
        emit(initializeResult);
      }
      if (message.method === 'model/list') emit(page(message.id, [model()], null));
    });

    // Two catalogues pointed at different executables must not share a result;
    // the cache key is the resolved path for exactly this reason.
    const first = new CodexAppServerModelCatalog(runner, { getConfiguredPath: () => process.execPath });
    await first.list();
    await first.list();
    expect(probes).toBe(1);

    const second = new CodexAppServerModelCatalog(runner, {
      getConfiguredPath: () => process.argv[1] ?? process.execPath
    });
    await second.list();
    expect(probes).toBe(2);
  });

  it('reports unavailable, without spawning, when Codex cannot be found', async () => {
    const runner = fakeRunner(happyPath());
    const catalog = new CodexAppServerModelCatalog(runner, {
      getConfiguredPath: () => 'C:\\definitely\\not\\here\\codex.exe'
    });

    const result = await catalog.list();

    expect(result.available).toBe(false);
    expect(result.detail).toMatch(/could not be found/i);
    expect(runner.calls).toHaveLength(0);
  });

  it('never starts a thread or a turn', async () => {
    const written: string[] = [];
    const runner = fakeRunner((line, emit) => {
      written.push(line);
      const message = JSON.parse(line);
      if (message.method === 'initialize') emit(initializeResult);
      if (message.method === 'model/list') emit(page(message.id, [model()], null));
    });

    await new CodexAppServerModelCatalog(runner, options).list();

    const methods = written.map((line) => JSON.parse(line).method);
    expect(methods).toEqual(['initialize', 'initialized', 'model/list']);
    expect(methods).not.toContain('thread/start');
    expect(methods).not.toContain('thread/resume');
    expect(methods).not.toContain('turn/start');
  });
});
