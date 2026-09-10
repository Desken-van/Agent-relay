import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThreadEvent, ThreadOptions } from '@openai/codex-sdk';
import type { AgentRunContext, CodexReviewRequest, ImplementationRequest } from '../../src/main/ports';
import type { ProcessRunOptions, ProcessRunner } from '../../src/main/adapters/process/process-runner';
import { CodexSdkAdapter } from '../../src/main/adapters/codex/codex-adapter';
import { ClaudeCliAdapter } from '../../src/main/adapters/claude/claude-adapter';
import { makeChangeSet, makeReview, makeSpecification } from '../helpers/fakes';

const sdk = vi.hoisted(() => ({ events: [] as unknown[], opened: [] as { id: string | null; options: unknown }[], hang: false }));
vi.mock('@openai/codex-sdk', () => ({ Codex: class {
  startThread(options: unknown) { sdk.opened.push({ id: null, options }); return this.thread(); }
  resumeThread(id: string, options: unknown) { sdk.opened.push({ id, options }); return this.thread(); }
  thread() { return { id: 'thread-executor', runStreamed: async (_prompt: string, { signal }: { signal: AbortSignal }) => ({ events: (async function* () {
    if (sdk.hang) await new Promise((_resolve, reject) => { if (signal.aborted) reject(new Error('aborted')); else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
    for (const e of sdk.events) yield e;
  })() }) }; }
} }));
const runner: ProcessRunner = { run: async () => { throw new Error('unexpected process'); } };
const context = (): AgentRunContext => ({ signal: new AbortController().signal, timeoutMs: 5000, onProgress: () => {} });
const input: ImplementationRequest = { worktreePath: process.cwd(), sessionId: null, model: null, prompt: 'Implement the change.', verificationCommands: ['Bash(npm test *)'] };
const review: CodexReviewRequest = { worktreePath: process.cwd(), threadId: null, model: null, specification: makeSpecification(), changes: makeChangeSet(), claudeReport: '', testOutput: '', round: 1, maxRounds: 2 };
const ended: ThreadEvent = { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, reasoning_output_tokens: 0 } };
beforeEach(() => { sdk.opened = []; sdk.events = []; sdk.hang = false; });
describe('provider process boundaries', () => {
  it('runs Codex with workspace-write, no approvals or network; resumes only the executor thread', async () => {
    sdk.events = [{ type: 'item.completed', item: { id: 'check', type: 'command_execution', command: 'npm test', status: 'completed', exit_code: 0, aggregated_output: '' } }, { type: 'item.completed', item: { id: 'report', type: 'agent_message', text: '{"report":"done"}' } }, ended];
    const result = await new CodexSdkAdapter(runner).implement({ ...input, sessionId: 'executor-only' }, context());
    expect(result.assessment.publishBlock).toBe('none');
    expect(sdk.opened).toEqual([{ id: 'executor-only', options: expect.objectContaining({ sandboxMode: 'workspace-write', approvalPolicy: 'never', networkAccessEnabled: false, workingDirectory: process.cwd() }) }]);
  });
  it('does not turn a claimed pass into measured verification', async () => {
    sdk.events = [{ type: 'item.completed', item: { id: 'report', type: 'agent_message', text: '{"report":"All tests passed"}' } }, ended];
    expect((await new CodexSdkAdapter(runner).implement(input, context())).assessment.publishBlock).toBe('verification');
  });
  it('bounds an unresponsive SDK stream and reports timeout', async () => {
    sdk.hang = true;
    await expect(new CodexSdkAdapter(runner).implement(input, { ...context(), timeoutMs: 20 })).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
  it('keeps a Codex review read-only', async () => {
    sdk.events = [{ type: 'item.completed', item: { id: 'report', type: 'agent_message', text: JSON.stringify(makeReview()) } }, ended];
    await new CodexSdkAdapter(runner).reviewImplementation(review, context());
    expect((sdk.opened[0]?.options as ThreadOptions).sandboxMode).toBe('read-only');
    expect(sdk.opened[0]?.id).toBeNull();
  });
  it('requires a completed SDK turn, not merely a final JSON message', async () => {
    sdk.events = [{ type: 'item.completed', item: { id: 'report', type: 'agent_message', text: '{"report":"done"}' } }];
    await expect(new CodexSdkAdapter(runner).implement(input, context())).rejects.toThrow();
  });
  it('starts Claude review with only read tools, no MCP, and no resumed session', async () => {
    let args: readonly string[] = []; let options: ProcessRunOptions | undefined;
    const fake: ProcessRunner = { run: async (_file, argv, opts) => {
      args = argv; options = opts;
      opts?.onLine?.(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'review-session', result: JSON.stringify(makeReview()) }));
      return { command: 'fake', exitCode: 0, stdout: '', stderr: '', timedOut: false, cancelled: false, durationMs: 1, failed: false };
    } };
    const result = await new ClaudeCliAdapter(fake, { configuredPath: process.execPath }).reviewImplementation(review, context());
    expect(result.review.verdict).toBe('approved');
    expect(args).toContain('--strict-mcp-config'); expect(args).toContain('{"mcpServers":{}}');
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
    expect(args).not.toContain('--resume'); expect(args).not.toContain('--dangerously-skip-permissions');
    expect(options?.cwd).toBe(review.worktreePath);
  });
});
