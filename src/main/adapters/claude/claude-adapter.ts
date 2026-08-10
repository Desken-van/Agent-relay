/**
 * Claude Code adapter — non-interactive ("print") mode.
 *
 * Invocation shape:
 *
 *   claude --print
 *          --output-format stream-json --verbose
 *          --setting-sources project
 *          --permission-mode acceptEdits
 *          --max-turns <n>
 *          [--resume <session-id>]
 *          [--allowedTools <rule> …]
 *          --disallowedTools <rule> …
 *
 * with the prompt written to **stdin**, never onto the command line. Two reasons:
 * a specification plus a review follow-up routinely exceeds the ~32 KB Windows
 * command-line limit, and keeping model-authored text out of argv removes any
 * question of argument injection.
 *
 * Three deliberate choices about permissions. What each one actually does is
 * narrower than it sounds, so be precise about it:
 *
 *  * `--setting-sources project` excludes the operator's *user* and *local*
 *    settings — personal permission rules, plugins, hooks and MCP servers from
 *    unrelated work — which otherwise make the same task behave differently on
 *    two machines. The **target repository's own project settings still load**,
 *    and may add permissions or hooks of their own.
 *  * `--allowedTools` **pre-approves** matching tool calls, so they run without
 *    a prompt. It is not an exclusive allowlist: a call that matches nothing
 *    here is not thereby refused, it falls through to the permission mode and
 *    the project's settings. Under `acceptEdits` that means file edits proceed,
 *    some read-only commands may be approved automatically, and whatever is
 *    left needs an answer nobody is there to give — which is what produces the
 *    denials handled below.
 *  * `--disallowedTools` refuses tool calls that **directly match** its
 *    patterns, and cannot be loosened by project settings. It is a
 *    command-pattern filter, not a sandbox: the same operation reached
 *    indirectly — a project script, a task runner wrapping git — does not match
 *    and is not caught.
 *
 * `--dangerously-skip-permissions` is deliberately never used.
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
import { consumeLine, createStreamState, describeDenials, finalizeState } from './stream-parser';

export interface ClaudeAdapterOptions {
  readonly configuredPath?: string | null;
  readonly model?: string | null;
  /**
   * Permission rules granted for this run, from Settings. Empty means "grant
   * nothing beyond edits", not "grant everything".
   */
  readonly allowedTools?: readonly string[];
}

/**
 * Commands Agent Relay refuses when a tool call names them directly, whatever
 * the project settings say. These are the operations the application reserves
 * for its own confirmation dialog, plus the Git commands that could move work
 * out of the worktree the task is isolated in.
 *
 * Direct invocation is the limit of what pattern matching can see; a script that
 * wraps one of these is not matched.
 */
const DESTRUCTIVE_COMMANDS = [
  'git commit',
  'git push',
  'git reset',
  'git clean',
  'git checkout',
  'git switch',
  'git merge',
  'git rebase',
  'gh'
] as const;

/** Shell-ish tools the deny list has to cover; Windows agents reach for both. */
const GUARDED_TOOLS = ['Bash', 'PowerShell'] as const;

/**
 * Build the fixed deny list.
 *
 * Three spellings per command because Claude Code's rule matching is literal:
 * `Tool(cmd)` catches the bare command, and the two wildcard forms catch it with
 * arguments. Emitting all three costs nothing and avoids depending on which
 * spelling a given CLI version treats as a prefix.
 */
export function destructiveToolDenyRules(): string[] {
  const rules: string[] = [];
  for (const tool of GUARDED_TOOLS) {
    for (const command of DESTRUCTIVE_COMMANDS) {
      rules.push(`${tool}(${command})`, `${tool}(${command}:*)`, `${tool}(${command} *)`);
    }
  }
  return rules;
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
          'Install it with `winget install --id Anthropic.ClaudeCode -e`, run `claude` once to log in, then restart Agent Relay so it picks up the new PATH. Set an explicit path in Settings if it is still not discovered.'
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
          'Install it with `winget install --id Anthropic.ClaudeCode -e`, run `claude` once to log in, then restart Agent Relay so the updated PATH is picked up.',
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
      // Ignore the operator's personal Claude configuration; see the file header.
      '--setting-sources',
      'project',
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

    // Both permission lists are variadic, so they go last and in this order:
    // `--disallowedTools` terminates the pre-approval list, and being last it
    // can safely run to the end of argv. Each rule is its own entry — joining
    // them into one comma-separated string makes a rule containing a comma
    // ambiguous.
    const allowed = this.options.allowedTools ?? [];
    if (allowed.length > 0) {
      args.push('--allowedTools', ...allowed);
    }
    args.push('--disallowedTools', ...destructiveToolDenyRules());

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

    // Fail closed. The CLI exits 0 after a denial and its result envelope still
    // says "success", because from the model's side nothing crashed — it simply
    // could not run something and carried on. Reporting that as a good round is
    // how an implementation with no tests run gets sent to the reviewer.
    const denialSummary = describeDenials(finalized.denials);

    return {
      sessionId: finalized.sessionId,
      finalMessage: denialSummary
        ? `${denialSummary}\n\n${finalized.finalMessage}`.trim()
        : finalized.finalMessage,
      isError: finalized.isError,
      numTurns: finalized.numTurns,
      rawResultJson: finalized.rawResultJson,
      permissionDenials: finalized.denials
    };
  }
}
