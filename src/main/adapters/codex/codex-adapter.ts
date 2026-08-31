/**
 * Codex adapter, built on `@openai/codex-sdk`.
 *
 * Implemented against the installed package's own type declarations
 * (v0.147.0), not from memory:
 *
 *   new Codex({ codexPathOverride?, apiKey?, baseUrl?, config?, env? })
 *   codex.startThread(threadOptions?)  -> Thread
 *   codex.resumeThread(id, options?)   -> Thread     (threads persist in ~/.codex/sessions)
 *   thread.id                          -> string | null   (set once the turn starts)
 *   thread.runStreamed(input, { outputSchema?, signal? }) -> { events: AsyncGenerator<ThreadEvent> }
 *
 * Two things matter for correctness here:
 *
 *  * **Read-only reviews.** `reviewImplementation` hard-codes
 *    `sandboxMode: 'read-only'` and does not accept an override. A review that
 *    could edit the code it is judging is not a review.
 *  * **Structured output.** The same Zod schema that validates the response is
 *    projected to JSON Schema and passed as `outputSchema`, so the model is
 *    constrained on the way out and checked on the way in.
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Codex, type ThreadEvent, type ThreadItem, type ThreadOptions } from '@openai/codex-sdk';
import type { ToolDiagnostic } from '../../../shared/domain/diagnostics';
import { AgentRelayError } from '../../../shared/domain/errors';
import {
  codexReviewResultJsonSchema,
  parseCodexReviewResult,
  parseTaskSpecification,
  taskSpecificationJsonSchema
} from '../../../shared/schemas/codex';
import { redactSecrets } from '../../../shared/util/redact';
import type {
  AgentRunContext,
  CodexAdapter,
  CodexReviewOutcome,
  CodexReviewRequest,
  CodexSpecificationRequest,
  CodexSpecificationResult
} from '../../ports';
import { locateExecutable } from '../process/executable-locator';
import type { ProcessRunner } from '../process/process-runner';
import { buildReviewPrompt, buildSpecificationPrompt } from './prompts';

export interface CodexAdapterOptions {
  /** Explicit path to the codex executable; otherwise the bundled one is used. */
  readonly configuredPath?: string | null;
}

/**
 * Platform packages that ship the Codex binary, mirroring the mapping inside
 * `@openai/codex`. The SDK resolves this itself when it spawns, but Agent Relay
 * resolves it too so that **diagnostics and execution agree**: without this,
 * Codex reports "missing" (it is not on PATH) while runs work perfectly, which
 * is the worst possible combination for a diagnostics screen.
 */
const CODEX_PLATFORM_PACKAGES: Readonly<Record<string, { pkg: string; triple: string }>> = {
  'linux-x64': { pkg: '@openai/codex-linux-x64', triple: 'x86_64-unknown-linux-musl' },
  'linux-arm64': { pkg: '@openai/codex-linux-arm64', triple: 'aarch64-unknown-linux-musl' },
  'darwin-x64': { pkg: '@openai/codex-darwin-x64', triple: 'x86_64-apple-darwin' },
  'darwin-arm64': { pkg: '@openai/codex-darwin-arm64', triple: 'aarch64-apple-darwin' },
  'win32-x64': { pkg: '@openai/codex-win32-x64', triple: 'x86_64-pc-windows-msvc' },
  'win32-arm64': { pkg: '@openai/codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' }
};

/** Absolute paths to the Codex binary that ships with the installed SDK. */
export function bundledCodexPaths(): string[] {
  const entry = CODEX_PLATFORM_PACKAGES[`${process.platform}-${process.arch}`];
  if (!entry) return [];

  const executable = process.platform === 'win32' ? 'codex.exe' : 'codex';

  try {
    const requireFrom = createRequire(import.meta.url);
    const manifest = requireFrom.resolve(`${entry.pkg}/package.json`);
    return [join(dirname(manifest), 'vendor', entry.triple, 'bin', executable)];
  } catch {
    // The platform package is optional; absence just means "not bundled".
    return [];
  }
}

interface TurnOutcome {
  readonly threadId: string | null;
  readonly finalResponse: string;
}

/**
 * Options for one Codex turn.
 *
 * `model` is the task's snapshot, passed in by the caller — never adapter
 * configuration. Adapters are rebuilt from Settings on every call, so a
 * constructor option would silently make an existing thread follow whatever
 * Settings currently say.
 *
 * A null model omits the key entirely rather than sending an empty string, so
 * Codex applies its own default. Exported for tests: `startThread` and
 * `resumeThread` are handed the same object, so proving this function correct
 * proves both paths carry the model.
 */
export function buildThreadOptions(
  model: string | null,
  overrides: Partial<ThreadOptions>
): ThreadOptions {
  const base: ThreadOptions = {
    // Codex refuses to run outside a Git repository unless told otherwise;
    // a fresh worktree is a valid repository, but a brand-new project may not be.
    skipGitRepoCheck: true,
    ...overrides
  };
  return model ? { ...base, model } : base;
}

/**
 * The part of the Codex client this adapter actually uses.
 *
 * Narrow on purpose: it makes "does resuming carry the model too?" answerable
 * by a test with a fake client, instead of by reading the source.
 */
export interface CodexThreadOpener<TThread> {
  startThread(options: ThreadOptions): TThread;
  resumeThread(id: string, options: ThreadOptions): TThread;
}

/**
 * Continue an existing thread, or begin one — with identical options either way.
 *
 * The single call site is what guarantees a resumed conversation runs on the
 * same model as the turn that created it.
 */
export function openThread<TThread>(
  client: CodexThreadOpener<TThread>,
  threadId: string | null,
  options: ThreadOptions
): TThread {
  return threadId === null ? client.startThread(options) : client.resumeThread(threadId, options);
}

export class CodexSdkAdapter implements CodexAdapter {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly options: CodexAdapterOptions = {}
  ) {}

  /** The executable this adapter will actually use, or null if none is found. */
  private resolveExecutable(): string | null {
    return (
      locateExecutable('codex', {
        configuredPath: this.options.configuredPath ?? null,
        bundledPaths: bundledCodexPaths()
      })?.path ?? null
    );
  }

  private createClient(): Codex {
    // Pin the SDK to the same binary diagnostics reports, so the two can never
    // disagree. Falling back to the SDK's own resolution when nothing is found
    // keeps this from being a regression on an unusual install.
    const executable = this.resolveExecutable();

    // The SDK inherits process.env deliberately: Codex owns its own credentials
    // (~/.codex/auth.json, or OPENAI_API_KEY) and passing a scrubbed environment
    // would break API-key authentication.
    return new Codex(executable ? { codexPathOverride: executable } : {});
  }

  private threadOptions(model: string | null, overrides: Partial<ThreadOptions>): ThreadOptions {
    return buildThreadOptions(model, overrides);
  }

  /**
   * Drive one Codex turn, forwarding every event to the UI and returning the
   * assistant's final text.
   */
  private async runTurn(
    threadId: string | null,
    prompt: string,
    threadOptions: ThreadOptions,
    outputSchema: Record<string, unknown>,
    context: AgentRunContext
  ): Promise<TurnOutcome> {
    const codex = this.createClient();
    const thread = openThread(codex, threadId, threadOptions);

    const messages: string[] = [];
    let failure: string | null = null;

    let streamed: { events: AsyncGenerator<ThreadEvent> };
    try {
      streamed = await thread.runStreamed(prompt, {
        outputSchema,
        signal: context.signal
      });
    } catch (error) {
      throw this.toDomainError(error, threadId);
    }

    try {
      for await (const event of streamed.events) {
        switch (event.type) {
          case 'thread.started':
            context.onProgress({
              type: 'started',
              text: `Codex thread ${event.thread_id} started.`,
              data: { threadId: event.thread_id }
            });
            break;

          case 'turn.started':
            context.onProgress({ type: 'progress', text: 'Codex turn started.' });
            break;

          case 'item.started':
          case 'item.updated':
          case 'item.completed': {
            const progress = describeItem(event.item, event.type === 'item.completed');
            if (progress) context.onProgress(progress);
            if (event.type === 'item.completed' && event.item.type === 'agent_message') {
              messages.push(event.item.text);
            }
            break;
          }

          case 'turn.completed':
            context.onProgress({
              type: 'progress',
              text: `Codex turn completed (${event.usage.input_tokens} in / ${event.usage.output_tokens} out tokens).`,
              data: { usage: event.usage }
            });
            break;

          case 'turn.failed':
            failure = event.error.message;
            context.onProgress({ type: 'error', text: redactSecrets(event.error.message) });
            break;

          case 'error':
            failure = event.message;
            context.onProgress({ type: 'error', text: redactSecrets(event.message) });
            break;

          default:
            break;
        }
      }
    } catch (error) {
      throw this.toDomainError(error, thread.id ?? threadId);
    }

    if (failure) {
      throw this.toDomainError(new Error(failure), thread.id ?? threadId);
    }

    const finalResponse = messages.at(-1) ?? '';

    return { threadId: thread.id ?? threadId, finalResponse };
  }

  private toDomainError(error: unknown, threadId: string | null): AgentRelayError {
    const message = error instanceof Error ? error.message : String(error);
    const redacted = redactSecrets(message);
    const lower = redacted.toLowerCase();

    if (lower.includes('abort') || lower.includes('cancel')) {
      return new AgentRelayError('CANCELLED', 'The Codex run was stopped.');
    }

    if (
      lower.includes('not logged in') ||
      lower.includes('unauthorized') ||
      lower.includes('401') ||
      lower.includes('authentication')
    ) {
      return new AgentRelayError('TOOL_UNAUTHENTICATED', 'Codex is not authenticated.', {
        remediation: 'Run `codex login` in a terminal, then retry.',
        details: redacted.slice(0, 1000)
      });
    }

    if (lower.includes('enoent') || lower.includes('not found')) {
      return new AgentRelayError('TOOL_MISSING', 'The Codex executable could not be launched.', {
        remediation:
          'Install the Codex CLI (`npm install -g @openai/codex`) or set an explicit path in Settings.',
        details: redacted.slice(0, 1000)
      });
    }

    return new AgentRelayError('TOOL_FAILED', `Codex failed: ${redacted.slice(0, 500)}`, {
      details: threadId ? `thread ${threadId}` : undefined
    });
  }

  async createSpecification(
    request: CodexSpecificationRequest,
    context: AgentRunContext
  ): Promise<CodexSpecificationResult> {
    const prompt = buildSpecificationPrompt({
      projectPath: request.projectPath,
      taskTitle: request.taskTitle,
      originalRequest: request.originalRequest
    });

    const outcome = await this.runTurn(
      request.threadId,
      prompt,
      this.threadOptions(request.model, {
        // Specifying requires reading the repository, never writing to it.
        sandboxMode: 'read-only',
        workingDirectory: request.projectPath,
        approvalPolicy: 'never'
      }),
      taskSpecificationJsonSchema(),
      context
    );

    const parsed = parseTaskSpecification(outcome.finalResponse);
    if (!parsed.ok || !parsed.value) {
      throw new AgentRelayError(
        'PARSE_FAILED',
        parsed.error ?? 'Codex did not return a usable specification.',
        {
          remediation: 'Use "Generate specification" again to retry — the thread is preserved.',
          details: parsed.raw ? redactSecrets(parsed.raw).slice(0, 2000) : undefined
        }
      );
    }

    return {
      threadId: outcome.threadId,
      specification: parsed.value,
      rawResponse: outcome.finalResponse
    };
  }

  async reviewImplementation(
    request: CodexReviewRequest,
    context: AgentRunContext
  ): Promise<CodexReviewOutcome> {
    const prompt = buildReviewPrompt({
      specification: request.specification,
      changes: request.changes,
      claudeReport: request.claudeReport,
      testOutput: request.testOutput,
      round: request.round,
      maxRounds: request.maxRounds
    });

    const outcome = await this.runTurn(
      request.threadId,
      prompt,
      this.threadOptions(request.model, {
        // Not configurable. A review must not be able to edit what it reviews.
        sandboxMode: 'read-only',
        workingDirectory: request.worktreePath,
        approvalPolicy: 'never',
        networkAccessEnabled: false
      }),
      codexReviewResultJsonSchema(),
      context
    );

    const parsed = parseCodexReviewResult(outcome.finalResponse);
    if (!parsed.ok || !parsed.value) {
      throw new AgentRelayError(
        'PARSE_FAILED',
        parsed.error ?? 'Codex did not return a usable review.',
        {
          remediation: 'Use "Review with Codex" again to retry — the thread is preserved.',
          details: parsed.raw ? redactSecrets(parsed.raw).slice(0, 2000) : undefined
        }
      );
    }

    return {
      threadId: outcome.threadId,
      review: parsed.value,
      rawResponse: outcome.finalResponse
    };
  }

  async diagnose(): Promise<ToolDiagnostic> {
    const checkedAt = new Date().toISOString();

    // Checks the configured path, then the binary bundled with the SDK, then
    // PATH — the same resolution the adapter uses to run Codex.
    const executable = this.resolveExecutable();

    if (!executable) {
      return {
        tool: 'codex',
        status: 'missing',
        executablePath: null,
        version: null,
        detail: 'The Codex executable could not be found, including the copy bundled with the SDK.',
        remediation:
          'Reinstall dependencies (`npm install`), install the Codex CLI with `npm install -g @openai/codex`, or set an explicit path in Settings.',
        checkedAt
      };
    }

    const version = await this.runner.run(executable, ['--version'], { timeoutMs: 30_000 });
    if (version.exitCode !== 0) {
      return {
        tool: 'codex',
        status: 'error',
        executablePath: executable,
        version: null,
        detail: redactSecrets(version.stderr || version.stdout).slice(0, 400),
        remediation: 'Run `codex --version` in a terminal to see the underlying failure.',
        checkedAt
      };
    }

    // `codex login status` reports authentication without printing a token.
    const login = await this.runner.run(executable, ['login', 'status'], { timeoutMs: 30_000 });
    const loginOutput = redactSecrets(`${login.stdout}\n${login.stderr}`).trim();
    const authenticated = login.exitCode === 0 && /logged in/i.test(loginOutput);

    return {
      tool: 'codex',
      status: authenticated ? 'ok' : 'unauthenticated',
      executablePath: executable,
      version: version.stdout.trim() || null,
      detail: authenticated
        ? `${version.stdout.trim()} — ${loginOutput.split(/\r?\n/)[0] ?? 'authenticated'}.`
        : `${version.stdout.trim()} — not logged in.`,
      remediation: authenticated ? null : 'Run `codex login` in a terminal, then re-run diagnostics.',
      checkedAt
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Event mapping                                                               */
/* -------------------------------------------------------------------------- */

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Turn a Codex thread item into a timeline entry, or null when not worth showing. */
export function describeItem(
  item: ThreadItem,
  completed: boolean
): { type: 'log' | 'thinking' | 'command' | 'file_change' | 'assistant_message' | 'error' | 'progress'; text: string; data?: Record<string, unknown> } | null {
  switch (item.type) {
    case 'agent_message':
      return completed
        ? { type: 'assistant_message', text: truncate(redactSecrets(item.text), 20_000) }
        : null;

    case 'reasoning':
      return { type: 'thinking', text: truncate(redactSecrets(item.text), 4_000) };

    case 'command_execution':
      return {
        type: 'command',
        text: `${item.status === 'completed' ? '✓' : item.status === 'failed' ? '✗' : '…'} ${truncate(redactSecrets(item.command), 500)}`,
        data: { status: item.status, exitCode: item.exit_code ?? null }
      };

    case 'file_change':
      return {
        type: 'file_change',
        text: item.changes.map((change) => `${change.kind} ${change.path}`).join(', '),
        data: { status: item.status }
      };

    case 'mcp_tool_call':
      return { type: 'progress', text: `MCP ${item.server}/${item.tool}` };

    case 'web_search':
      return { type: 'progress', text: `Web search: ${truncate(item.query, 200)}` };

    case 'todo_list':
      return {
        type: 'progress',
        text: item.items.map((todo) => `${todo.completed ? '[x]' : '[ ]'} ${todo.text}`).join('\n')
      };

    case 'error':
      return { type: 'error', text: truncate(redactSecrets(item.message), 4_000) };

    default:
      return null;
  }
}
