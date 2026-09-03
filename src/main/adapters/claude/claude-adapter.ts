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
import { destructiveToolDenyRules } from '../../../shared/domain/claude-tool-rules';
import type { ToolDiagnostic } from '../../../shared/domain/diagnostics';
import { AgentRelayError } from '../../../shared/domain/errors';
import type {
  AgentRunContext,
  ClaudeAdapter,
  ClaudeImplementationRequest,
  ClaudeImplementationResult
} from '../../ports';
import { launchFor, locateExecutable, configuredPathIsBroken } from '../process/executable-locator';
import type { ProcessRunner } from '../process/process-runner';
import { consumeLine, createStreamState, finalizeState } from './stream-parser';

export interface ClaudeAdapterOptions {
  readonly configuredPath?: string | null;
  /**
   * Permission rules granted for this run, from Settings. Empty means "grant
   * nothing beyond edits", not "grant everything".
   */
  readonly allowedTools?: readonly string[];
}

/**
 * The fixed deny list, re-exported from the one place that defines it.
 *
 * The rules themselves live in `shared/domain/claude-tool-rules` because the
 * round policy classifies denials against exactly the same list. A copy here
 * would be a second source of truth for a security decision. Kept as an export
 * so callers that already import it from the adapter do not have to care.
 */
export { destructiveToolDenyRules };

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

    const launch = launchFor(path);
    const version = await this.runner.run(launch.file, [...launch.prefixArgs, '--version'], {
      timeoutMs: 30_000,
      env: launch.env
    });
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
    // A located path is not always a program: an npm install of Claude Code
    // leaves a `cli.js`, which has to go through the Node runtime because this
    // application never spawns a shell. Whatever comes back, the tool's own
    // arguments follow unchanged.
    const launch = launchFor(this.claudePath());
    const state = createStreamState();

    const args: string[] = [
      ...launch.prefixArgs,
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

    // The task's snapshotted model. Null means no `--model` at all, so the CLI
    // uses its own default; it never means "substitute something else".
    if (request.model) {
      args.push('--model', request.model);
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
    // The request wins: it carries the snapshot the caller judged the round
    // against. Falling back to the constructor keeps direct callers working.
    const allowed = request.allowedTools ?? this.options.allowedTools ?? [];
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

    const result = await this.runner.run(launch.file, args, {
      cwd: request.worktreePath,
      timeoutMs: context.timeoutMs,
      signal: context.signal,
      passthroughEnvNames: CLAUDE_ENV_PASSTHROUGH,
      env: launch.env,
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

      // Deliberately no retry and no fallback to another model: if the task
      // asked for a model it cannot use, the user needs to see that, not a
      // silently different result from a model they did not choose.
      const model = request.model ? ` (model: ${request.model})` : '';
      throw new AgentRelayError(
        'TOOL_FAILED',
        `Claude Code exited with code ${result.exitCode ?? 'unknown'}${model}.`,
        {
          details: output.slice(0, 2000),
          ...(request.model
            ? {
                remediation: `Check that "${request.model}" is a model your Claude account can use, or choose a different one when creating the task.`
              }
            : {})
        }
      );
    }

    // Denials travel with the result rather than being folded into the message
    // or the error flag. The CLI exits 0 after a refusal and its envelope still
    // says "success", so something has to fail closed — but that something is
    // the round policy, which can also see whether the work was verified anyway.
    // Deciding it here, with only half the picture, is what produced a blanket
    // "the tests may have been skipped" on rounds where they demonstrably ran.
    return {
      sessionId: finalized.sessionId,
      finalMessage: finalized.finalMessage,
      isError: finalized.isError,
      numTurns: finalized.numTurns,
      rawResultJson: finalized.rawResultJson,
      permissionDenials: finalized.denials,
      evidence: finalized.evidence
    };
  }
}
