/**
 * Scaffolding for driving `ClaudeCliAdapter` against a real child process.
 *
 * Everything here is about the boundary, not the logic: a throwaway working
 * directory that doubles as the fake CLI's scenario store, an adapter pointed
 * explicitly at the fixture (never at a Claude the developer happens to have
 * installed), and a way to ask the operating system whether the child is
 * actually gone.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCliAdapter, type ClaudeAdapterOptions } from '../../src/main/adapters/claude/claude-adapter';
import { ExecaProcessRunner, type ProcessRunner } from '../../src/main/adapters/process/process-runner';
import type {
  AgentProgressEvent,
  AgentRunContext,
  ClaudeImplementationRequest
} from '../../src/main/ports';

/**
 * The fake CLI, addressed by path.
 *
 * Passed as `configuredPath`, which short-circuits discovery entirely: PATH,
 * the WinGet locations and the developer's own Claude install are never
 * consulted, so the suite behaves the same on a machine that has Claude Code
 * and one that does not.
 */
export const FAKE_CLAUDE_CLI = join(import.meta.dirname, '..', 'fixtures', 'fake-claude-cli.mjs');

const SCENARIO_FILE = 'fake-claude-scenario.json';
const REPORT_FILE = 'fake-claude-invocation.json';

export type FakeClaudeAction =
  /** Written to stdout byte for byte — no newline is added. */
  | { readonly stdout: string }
  | { readonly stderr: string }
  /** Serialised to one NDJSON line, terminated with the scenario's line ending. */
  | { readonly event: unknown }
  | { readonly sleep: number };

export interface FakeClaudeScenario {
  readonly actions?: readonly FakeClaudeAction[];
  /** Exit code once the actions are done. Ignored when `hang` is set. */
  readonly exit?: number;
  /** Never exit on its own; only a kill ends the process. */
  readonly hang?: boolean;
  readonly eol?: 'lf' | 'crlf';
  /** Session id when the run is not resuming one. */
  readonly sessionId?: string;
  /** Variable names to report presence for. Values are never recorded. */
  readonly reportEnv?: readonly string[];
}

export interface FakeClaudeInvocation {
  readonly pid: number;
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly stdin: string;
  readonly stdinSha256: string;
  readonly stdinBytes: number;
  readonly envPresent: Readonly<Record<string, boolean>>;
  readonly envTokenShapedNames: readonly string[];
}

/**
 * A temporary directory standing in for the task's worktree.
 *
 * It is both the `cwd` the adapter is asked to use and the only place the fake
 * looks for its instructions, so a run that started somewhere else cannot find
 * a scenario at all — which is how the working-directory claim is tested.
 */
export class FakeClaudeWorktree {
  readonly path: string;

  constructor() {
    this.path = mkdtempSync(join(tmpdir(), 'agent-relay-fake-claude-'));
  }

  scenario(scenario: FakeClaudeScenario): this {
    writeFileSync(join(this.path, SCENARIO_FILE), JSON.stringify(scenario), 'utf8');
    return this;
  }

  /** How the child was actually invoked. Throws when it never ran. */
  invocation(): FakeClaudeInvocation {
    return JSON.parse(readFileSync(join(this.path, REPORT_FILE), 'utf8')) as FakeClaudeInvocation;
  }

  ran(): boolean {
    return existsSync(join(this.path, REPORT_FILE));
  }

  cleanup(): void {
    rmSync(this.path, { recursive: true, force: true });
  }
}

/**
 * The adapter under test, pointed at the fixture and driving a real runner.
 *
 * `runner` exists so a test can observe the process boundary — the argv that
 * was handed to the operating system, the command label, how many children were
 * started — without replacing the thing that starts them.
 */
export function fakeClaudeAdapter(
  options: ClaudeAdapterOptions = {},
  runner: ProcessRunner = new ExecaProcessRunner()
): ClaudeCliAdapter {
  return new ClaudeCliAdapter(runner, {
    configuredPath: FAKE_CLAUDE_CLI,
    ...options
  });
}

export function fakeClaudeRequest(
  worktree: FakeClaudeWorktree,
  overrides: Partial<ClaudeImplementationRequest> = {}
): ClaudeImplementationRequest {
  return {
    worktreePath: worktree.path,
    branchName: 'agent-relay/task-1',
    prompt: 'Implement the specification.',
    sessionId: null,
    maxTurns: 8,
    model: null,
    ...overrides
  };
}

export interface RecordedContext {
  readonly context: AgentRunContext;
  readonly events: AgentProgressEvent[];
}

export function recordingContext(
  options: { timeoutMs?: number; signal?: AbortSignal; onEvent?: (event: AgentProgressEvent) => void } = {}
): RecordedContext {
  const events: AgentProgressEvent[] = [];
  return {
    events,
    context: {
      signal: options.signal ?? new AbortController().signal,
      timeoutMs: options.timeoutMs ?? 20_000,
      onProgress(event) {
        events.push(event);
        options.onEvent?.(event);
      }
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Stream fragments                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `{{sessionId}}` is expanded by the fake to the id it was resumed with, or to
 * the scenario's own. Keeping the placeholder here means a resume scenario does
 * not have to restate the id it is asserting on.
 */
export const SESSION_PLACEHOLDER = '{{sessionId}}';

export const claudeStream = {
  init: (cwd: string) => ({
    type: 'system',
    subtype: 'init',
    session_id: SESSION_PLACEHOLDER,
    cwd
  }),

  assistantText: (text: string) => ({
    type: 'assistant',
    session_id: SESSION_PLACEHOLDER,
    message: { role: 'assistant', content: [{ type: 'text', text }] }
  }),

  toolUse: (id: string, name: string, input: Record<string, unknown>) => ({
    type: 'assistant',
    session_id: SESSION_PLACEHOLDER,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }
  }),

  toolResult: (id: string, options: { isError?: boolean } = {}) => ({
    type: 'user',
    session_id: SESSION_PLACEHOLDER,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          is_error: options.isError ?? false,
          content: 'ok'
        }
      ]
    }
  }),

  permissionDenied: (options: { toolUseId: string; tool: string; reason: string }) => ({
    type: 'system',
    subtype: 'permission_denied',
    session_id: SESSION_PLACEHOLDER,
    tool_use_id: options.toolUseId,
    tool_name: options.tool,
    decision_reason: options.reason
  }),

  result: (options: { text: string; numTurns: number; isError?: boolean } = { text: 'done', numTurns: 1 }) => ({
    type: 'result',
    subtype: 'success',
    session_id: SESSION_PLACEHOLDER,
    is_error: options.isError ?? false,
    num_turns: options.numTurns,
    result: options.text
  })
};

/* -------------------------------------------------------------------------- */
/* Process liveness                                                            */
/* -------------------------------------------------------------------------- */

function isAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence check without delivering
    // anything. It is the only portable way to ask "is this pid still there?".
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Resolves true once the pid is gone, or false if it outlived the deadline. */
export async function waitForExit(pid: number, withinMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  for (;;) {
    if (!isAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
