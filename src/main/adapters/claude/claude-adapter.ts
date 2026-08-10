/**
 * Claude Code adapter — non-interactive ("print") mode.
 *
 * Invocation shape:
 *
 *   claude --print
 *          --output-format stream-json --verbose
 *          --permission-mode acceptEdits
 *          --max-turns <n>
 *          [--resume <session-id>]
 *
 * with the prompt written to **stdin**, never onto the command line. Two reasons:
 * a specification plus a review follow-up routinely exceeds the ~32 KB Windows
 * command-line limit, and keeping model-authored text out of argv removes any
 * question of argument injection.
 *
 * `--dangerously-skip-permissions` is deliberately never used. `acceptEdits` is
 * the supported way to let Claude write files unattended while still refusing
 * the operations that flag would unlock.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ToolDiagnostic } from '../../../shared/domain/diagnostics';
import { AgentRelayError } from '../../../shared/domain/errors';
import type {
  AgentRunContext,
  ClaudeAdapter,
  ClaudeImplementationRequest,
  ClaudeImplementationResult
} from '../../ports';
import { locateExecutable, configuredPathIsBroken } from '../process/executable-locator';
import type { ProcessRunner } from '../process/process-runner';
import { consumeLine, createStreamState, finalizeState } from './stream-parser';

export interface ClaudeAdapterOptions {
  readonly configuredPath?: string | null;
  readonly model?: string | null;
}

/** stderr fragments that mean "you are not logged in", not "your code is bad". */
const AUTH_HINTS = [
  'not logged in',
  'please run /login',
  'authentication',
  'unauthorized',
  'invalid api key',
  'no api key',
  'oauth token',
  'credit balance',
  'run `claude login`',
  'claude setup-token'
];

function looksLikeAuthFailure(text: string): boolean {
  const lower = text.toLowerCase();
  return AUTH_HINTS.some((hint) => lower.includes(hint));
}

/**
 * Credential variables Claude Code owns. These are the only token-shaped
 * variables allowed through to the Claude process; see `scrubEnvironment`.
 */
const CLAUDE_ENV_PASSTHROUGH = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN'
] as const;

export class ClaudeCliAdapter implements ClaudeAdapter {
  constructor(
    private readonly runner: ProcessRunner,
    private readonly options: ClaudeAdapterOptions = {}
  ) {}

  private locate(): string | null {
    return locateExecutable('claude', { configuredPath: this.options.configuredPath ?? null })?.path ?? null;
  }

  private claudePath(): string {
    const path = this.locate();
    if (!path) {
      if (configuredPathIsBroken(this.options.configuredPath)) {
        throw new AgentRelayError(
          'TOOL_MISSING',
          'The Claude Code path configured in Settings does not point at an existing file.',
          {
            details: this.options.configuredPath ?? '',
            remediation: 'Clear the path in Settings to auto-discover, or correct it.'
          }
        );
      }
      throw new AgentRelayError('TOOL_MISSING', 'Claude Code was not found on this machine.', {
        remediation:
          'Install it with `npm install -g @anthropic-ai/claude-code`, run `claude` once to log in, then set the path in Settings if it is still not discovered.'
      });
    }
    return path;
  }

  async diagnose(): Promise<ToolDiagnostic> {
    const checkedAt = new Date().toISOString();

    if (configuredPathIsBroken(this.options.configuredPath)) {
      return {
        tool: 'claude',
        status: 'missing',
        executablePath: null,
        version: null,
        detail: `The configured path does not exist: ${this.options.configuredPath}`,
        remediation: 'Clear the Claude Code path in Settings to fall back to auto-discovery.',
        checkedAt
      };
    }

    const path = this.locate();
    if (!path) {
      return {
        tool: 'claude',
        status: 'missing',
        executablePath: null,
        version: null,
        detail: 'Claude Code was not found on PATH or in the standard Windows install locations.',
        remediation:
          'Install it with `npm install -g @anthropic-ai/claude-code`, then run `claude` once to log in.',
        checkedAt
      };
    }

    const version = await this.runner.run(path, ['--version'], { timeoutMs: 30_000 });
    if (version.exitCode !== 0) {
      const output = version.stderr || version.stdout;
      return {
        tool: 'claude',
        status: looksLikeAuthFailure(output) ? 'unauthenticated' : 'error',
        executablePath: path,
        version: null,
        detail: output.slice(0, 400),
        remediation: 'Run `claude --version` in a terminal to see the underlying failure.',
        checkedAt
      };
    }

    // We do not probe authentication by sending a real prompt — that would cost
    // a request on every diagnostics refresh. Presence of the CLI's own config
    // directory is used only as a hint; its contents are never read.
    const hasConfigDir = existsSync(join(homedir(), '.claude'));

    return {
      tool: 'claude',
      status: 'ok',
      executablePath: path,
      version: version.stdout.trim() || null,
      detail: hasConfigDir
        ? `${version.stdout.trim()} — a Claude Code profile exists on this machine. Authentication is confirmed on the first run.`
        : `${version.stdout.trim()} — no Claude Code profile found yet. Run \`claude\` once to log in.`,
      remediation: hasConfigDir ? null : 'Run `claude` in a terminal and complete the login flow.',
      checkedAt
    };
  }

  async run(
    request: ClaudeImplementationRequest,
    context: AgentRunContext
  ): Promise<ClaudeImplementationResult> {
    const executable = this.claudePath();
    const state = createStreamState();

    const args: string[] = [
      '--print',
      '--output-format',
      'stream-json',
      // stream-json in print mode requires --verbose; without it the CLI errors out.
      '--verbose',
      // Let Claude edit files unattended, without unlocking everything
      // `--dangerously-skip-permissions` would.
      '--permission-mode',
      'acceptEdits',
      '--max-turns',
      String(request.maxTurns)
    ];

    if (this.options.model) {
      args.push('--model', this.options.model);
    }

    // Resuming keeps the correction round in the *same* conversation, so Claude
    // still has the context of what it built in the previous round.
    if (request.sessionId) {
      args.push('--resume', request.sessionId);
    }

    context.onProgress({
      type: 'started',
      text: request.sessionId
        ? `Resuming Claude session ${request.sessionId} in ${request.worktreePath}`
        : `Starting a new Claude session in ${request.worktreePath}`,
      data: { branch: request.branchName, worktree: request.worktreePath }
    });

    const result = await this.runner.run(executable, args, {
      cwd: request.worktreePath,
      timeoutMs: context.timeoutMs,
      signal: context.signal,
      passthroughEnvNames: CLAUDE_ENV_PASSTHROUGH,
      // The prompt goes down stdin — never onto the command line.
      input: request.prompt,
      onLine: (line) => {
        for (const event of consumeLine(line, state)) {
          context.onProgress(event);
        }
      }
    });

    const finalized = finalizeState(state);

    if (result.cancelled) {
      throw new AgentRelayError('CANCELLED', 'The Claude run was stopped.', {
        details: finalized.sessionId ? `session ${finalized.sessionId}` : undefined
      });
    }

    if (result.timedOut) {
      throw new AgentRelayError(
        'TIMEOUT',
        `Claude did not finish within ${Math.round(context.timeoutMs / 1000)}s.`,
        {
          remediation: 'Raise the process timeout in Settings, or split the task into smaller pieces.',
          details: finalized.sessionId ? `session ${finalized.sessionId}` : undefined
        }
      );
    }

    if (result.exitCode !== 0) {
      const output = `${result.stdout}\n${result.stderr}`.trim();

      if (looksLikeAuthFailure(output)) {
        throw new AgentRelayError('TOOL_UNAUTHENTICATED', 'Claude Code is not authenticated.', {
          remediation: 'Run `claude` in a terminal and complete the login flow, then retry.',
          details: output.slice(0, 1000)
        });
      }

      throw new AgentRelayError(
        'TOOL_FAILED',
        `Claude Code exited with code ${result.exitCode ?? 'unknown'}.`,
        { details: output.slice(0, 2000) }
      );
    }

    return {
      sessionId: finalized.sessionId,
      finalMessage: finalized.finalMessage,
      isError: finalized.isError,
      numTurns: finalized.numTurns,
      rawResultJson: finalized.rawResultJson
    };
  }
}
