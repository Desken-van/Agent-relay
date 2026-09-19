import Ajv from 'ajv';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunContext, CodexTriageRequest, TriageableDecision, TriageableFinding } from '../../src/main/ports';
import type { ProcessRunner } from '../../src/main/adapters/process/process-runner';
import { CodexSdkAdapter } from '../../src/main/adapters/codex/codex-adapter';
import { MAX_TRIAGE_FINDINGS } from '../../src/shared/schemas/codex';
import { makeSpecification } from '../helpers/fakes';

/**
 * Everything the adapter hands the Codex SDK, recorded, so a test can say what
 * reached the provider — and prove that on a rejected request nothing did.
 */
const sdk = vi.hoisted(() => ({
  started: [] as Record<string, unknown>[],
  resumed: [] as { id: string; options: Record<string, unknown> }[],
  runs: [] as { prompt: string; outputSchema: Record<string, unknown> }[],
  answer: '' as string,
  failure: null as Error | null
}));

vi.mock('@openai/codex-sdk', () => ({
  Codex: class {
    startThread(options: Record<string, unknown>) {
      sdk.started.push(options);
      return this.thread();
    }
    resumeThread(id: string, options: Record<string, unknown>) {
      sdk.resumed.push({ id, options });
      return this.thread();
    }
    thread() {
      return {
        id: 'thread-triage',
        runStreamed: async (prompt: string, options: { outputSchema: Record<string, unknown> }) => {
          sdk.runs.push({ prompt, outputSchema: options.outputSchema });
          return {
            events: (async function* () {
              yield { type: 'thread.started', thread_id: 'thread-triage' };
              yield { type: 'turn.started' };
              if (sdk.failure) throw sdk.failure;
              yield { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: sdk.answer } };
              yield {
                type: 'turn.completed',
                usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 }
              };
            })()
          };
        }
      };
    }
  }
}));

const runner: ProcessRunner = {
  run: async () => {
    throw new Error('unexpected process');
  }
};

const context = (): AgentRunContext => ({
  signal: new AbortController().signal,
  timeoutMs: 5_000,
  onProgress: () => undefined
});

function finding<Ref extends number | string>(ref: Ref): TriageableFinding<Ref> {
  return { ref, severity: 'major', category: 'reliability', file: 'src/a.ts', line: 3, title: `Finding ${String(ref)}`, body: 'Body.', fix: 'Fix.' };
}

function decision<Ref extends number | string>(findingRef: Ref): TriageableDecision<Ref> {
  return { findingRef, action: 'accept', reason: 'Already handled.' };
}

const base = { worktreePath: process.cwd(), specification: makeSpecification(), model: null };

const planRequest = (overrides: Partial<Extract<CodexTriageRequest, { refKind: 'index' }>> = {}): CodexTriageRequest => ({
  ...base,
  refKind: 'index',
  findings: [finding(0), finding(1)],
  priorDecisions: [],
  ...overrides
});

const codeRequest = (overrides: Partial<Extract<CodexTriageRequest, { refKind: 'id' }>> = {}): CodexTriageRequest => ({
  ...base,
  refKind: 'id',
  findings: [finding('finding-a'), finding('finding-b')],
  priorDecisions: [],
  ...overrides
});

/** A request whose references disagree with each other or with its declared kind. */
const unsound = (request: Record<string, unknown>): CodexTriageRequest => request as unknown as CodexTriageRequest;

const recommendation = (findingRef: unknown): Record<string, unknown> => ({
  findingRef,
  recommendation: 'accept',
  reason: 'Matches criterion 1.',
  evidenceRef: 'criterion 1',
  confidence: 'high'
});
const answer = (...refs: unknown[]): string => JSON.stringify({ results: refs.map(recommendation) });

const validates = (schema: Record<string, unknown>, value: unknown): boolean => new Ajv().compile(schema)(value) === true;

/** The one thing every rejected request must leave behind: no provider was reached. */
function expectNothingDispatched(): void {
  expect(sdk.started).toHaveLength(0);
  expect(sdk.resumed).toHaveLength(0);
  expect(sdk.runs).toHaveLength(0);
}

interface RelayFailure extends Error {
  code?: string;
}
const rejection = (request: CodexTriageRequest): Promise<RelayFailure> =>
  new CodexSdkAdapter(runner).triageFindings(request, context()).then(
    () => {
      throw new Error('expected triageFindings to reject');
    },
    (error: RelayFailure) => error
  );

beforeEach(() => {
  sdk.started = [];
  sdk.resumed = [];
  sdk.runs = [];
  sdk.answer = '';
  sdk.failure = null;
});

describe('CodexSdkAdapter.triageFindings — the reference kind of one call', () => {
  it('sends a plan request an output schema whose findingRef accepts numbers and rejects strings', async () => {
    sdk.answer = answer(0, 1);
    await new CodexSdkAdapter(runner).triageFindings(planRequest(), context());

    const schema = sdk.runs[0]!.outputSchema;
    expect(validates(schema, JSON.parse(answer(0, 1)))).toBe(true);
    expect(validates(schema, JSON.parse(answer('0', '1')))).toBe(false);
    expect(JSON.stringify(schema)).not.toContain('anyOf');
  });

  it('sends a code-review request an output schema whose findingRef accepts strings and rejects numbers', async () => {
    sdk.answer = answer('finding-a', 'finding-b');
    await new CodexSdkAdapter(runner).triageFindings(codeRequest(), context());

    const schema = sdk.runs[0]!.outputSchema;
    expect(validates(schema, JSON.parse(answer('finding-a', 'finding-b')))).toBe(true);
    expect(validates(schema, JSON.parse(answer(0, 1)))).toBe(false);
    expect(JSON.stringify(schema)).not.toContain('anyOf');
  });

  it('states the required JSON type of findingRef in the prompt, for each kind', async () => {
    sdk.answer = answer(0, 1);
    await new CodexSdkAdapter(runner).triageFindings(planRequest(), context());
    expect(sdk.runs[0]!.prompt).toContain('Finding ref=0 ---');
    expect(sdk.runs[0]!.prompt).toMatch(/"findingRef" is a JSON NUMBER/);

    sdk.answer = answer('finding-a', 'finding-b');
    await new CodexSdkAdapter(runner).triageFindings(codeRequest(), context());
    expect(sdk.runs[1]!.prompt).toContain('Finding ref="finding-a" ---');
    expect(sdk.runs[1]!.prompt).toMatch(/"findingRef" is a JSON STRING/);
  });

  it('returns the numeric recommendations of a plan request, and the string ones of a code-review request', async () => {
    sdk.answer = answer(0, 1);
    const plan = await new CodexSdkAdapter(runner).triageFindings(planRequest(), context());
    expect(plan.recommendations.map((entry) => entry.findingRef)).toEqual([0, 1]);

    sdk.answer = answer('finding-a', 'finding-b');
    const code = await new CodexSdkAdapter(runner).triageFindings(codeRequest(), context());
    expect(code.recommendations.map((entry) => entry.findingRef)).toEqual(['finding-a', 'finding-b']);
  });

  it('rejects the original string references for a plan request, keeping the raw answer for the operator', async () => {
    sdk.answer = answer('0', '1');
    const error = await rejection(planRequest());

    expect(error.code).toBe('PARSE_FAILED');
    expect(error.message).toContain('findingRef');
  });

  it('rejects numeric references for a code-review request', async () => {
    sdk.answer = answer(0, 1);
    expect((await rejection(codeRequest())).code).toBe('PARSE_FAILED');
  });

  it('does not coerce a string into an index, nor a number into an id', async () => {
    sdk.answer = answer(0, '1');
    expect((await rejection(planRequest())).code).toBe('PARSE_FAILED');

    sdk.answer = answer('finding-a', 1);
    expect((await rejection(codeRequest())).code).toBe('PARSE_FAILED');
  });

  it('keeps the safety properties: a fresh read-only thread with no network and no approvals', async () => {
    sdk.answer = answer(0, 1);
    await new CodexSdkAdapter(runner).triageFindings(planRequest(), context());
    sdk.answer = answer('finding-a', 'finding-b');
    await new CodexSdkAdapter(runner).triageFindings(codeRequest(), context());

    expect(sdk.resumed).toHaveLength(0);
    expect(sdk.started).toHaveLength(2);
    for (const options of sdk.started) {
      expect(options).toMatchObject({ sandboxMode: 'read-only', networkAccessEnabled: false, approvalPolicy: 'never' });
    }
  });
});

describe('CodexSdkAdapter.triageFindings — fails closed before any provider call', () => {
  it('rejects findings that mix numbers and strings', async () => {
    const mixed = unsound({ ...planRequest(), findings: [finding(0), finding('finding-b')] });
    const error = await rejection(mixed);

    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.message).toMatch(/nothing was sent to Codex/);
    expectNothingDispatched();
  });

  it('rejects string references in a request that declares numeric ones, and the reverse', async () => {
    expect((await rejection(unsound({ ...planRequest(), findings: [finding('0'), finding('1')] }))).code).toBe('VALIDATION_FAILED');
    expect((await rejection(unsound({ ...codeRequest(), findings: [finding(0), finding(1)] }))).code).toBe('VALIDATION_FAILED');
    expectNothingDispatched();
  });

  it('rejects a prior decision of the other kind, because it is a reference too', async () => {
    const error = await rejection(unsound({ ...planRequest(), priorDecisions: [decision('finding-x')] }));

    expect(error.code).toBe('VALIDATION_FAILED');
    expectNothingDispatched();
  });

  it('rejects an index that is not a non-negative integer, and an id that is empty or too long', async () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect((await rejection(unsound({ ...planRequest(), findings: [finding(bad)] }))).code).toBe('VALIDATION_FAILED');
    }
    for (const bad of ['', 'x'.repeat(101)]) {
      expect((await rejection(unsound({ ...codeRequest(), findings: [finding(bad)] }))).code).toBe('VALIDATION_FAILED');
    }
    expectNothingDispatched();
  });

  it('rejects a request with no findings', async () => {
    expect((await rejection(planRequest({ findings: [] }))).code).toBe('VALIDATION_FAILED');
    expect((await rejection(codeRequest({ findings: [] }))).code).toBe('VALIDATION_FAILED');
    expectNothingDispatched();
  });

  it('rejects more findings than one answer can hold, but dispatches exactly that many', async () => {
    const refs = (count: number): number[] => Array.from({ length: count }, (_, index) => index);

    const error = await rejection(planRequest({ findings: refs(MAX_TRIAGE_FINDINGS + 1).map((ref) => finding(ref)) }));
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.message).toContain(String(MAX_TRIAGE_FINDINGS + 1));
    expectNothingDispatched();

    sdk.answer = answer(...refs(MAX_TRIAGE_FINDINGS));
    const outcome = await new CodexSdkAdapter(runner).triageFindings(
      planRequest({ findings: refs(MAX_TRIAGE_FINDINGS).map((ref) => finding(ref)) }),
      context()
    );
    expect(outcome.recommendations).toHaveLength(MAX_TRIAGE_FINDINGS);
    expect(sdk.runs).toHaveLength(1);
  });

  it('rejects a request that names no known reference kind, with the same error rather than a later TypeError', async () => {
    for (const refKind of ['id ', 'number', '', undefined]) {
      const error = await rejection(unsound({ ...codeRequest(), refKind }));
      expect(error.code).toBe('VALIDATION_FAILED');
      expect(error.message).toMatch(/Unknown finding reference kind/);
    }
    expectNothingDispatched();
  });

  it('accepts prior decisions of the request kind', async () => {
    sdk.answer = answer(2);
    await new CodexSdkAdapter(runner).triageFindings(
      planRequest({ findings: [finding(2)], priorDecisions: [decision(0), decision(1)] }),
      context()
    );
    expect(sdk.runs).toHaveLength(1);
  });
});

describe('CodexSdkAdapter.triageFindings — a provider failure yields no recommendations', () => {
  it('propagates the provider error and returns nothing to persist', async () => {
    sdk.failure = new Error('Codex Exec exited with code 1: upstream failure');
    const error = await rejection(planRequest());

    expect(error.code).toBe('TOOL_FAILED');
    expect(sdk.runs).toHaveLength(1);
  });
});
