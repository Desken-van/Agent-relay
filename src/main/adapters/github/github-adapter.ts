/**
 * GitHub adapter, built on the official `gh` CLI.
 *
 * Agent Relay never handles a GitHub credential. It does not ask for a PAT, does
 * not read `gh`'s config, and never passes `--show-token`. Authentication is
 * entirely `gh`'s problem, which means the worst case for a leak is a tool that
 * already had the token.
 *
 * Every method on this class that changes remote state is only reachable from
 * the publish service, which requires a granted approval first.
 */

import type { ToolDiagnostic } from '../../../shared/domain/diagnostics';
import { AgentRelayError } from '../../../shared/domain/errors';
import { redactSecrets } from '../../../shared/util/redact';
import { isValidGithubOwner, isValidRepoName } from '../../../shared/util/slug';
import type { GitHubAdapter, GitHubPullRequestRequest, GitHubRepositoryRequest } from '../../ports';
import { locateExecutable } from '../process/executable-locator';
import type { ProcessResult, ProcessRunner } from '../process/process-runner';

export interface GitHubAdapterOptions {
  readonly configuredPath?: string | null;
  readonly timeoutMs?: number;
}

/**
 * Credential variables `gh` owns. Users who authenticate with `GH_TOKEN`
 * instead of `gh auth login` still work; no other tool sees these.
 */
const GH_ENV_PASSTHROUGH = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN'] as const;

export interface GhAuthSummary {
  readonly accounts: string[];
  readonly activeAccount: string | null;
  readonly loggedIn: boolean;
}

/**
 * Parse `gh auth status`.
 *
 * Handles both the modern multi-account layout and the older
 * "Logged in to github.com as USER" line. The token line is ignored entirely —
 * we never want it in a string we might later persist.
 */
export function parseGhAuthStatus(output: string): GhAuthSummary {
  const accounts: string[] = [];
  let activeAccount: string | null = null;
  let lastAccount: string | null = null;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();

    const modern = /Logged in to \S+ account ([A-Za-z0-9-]+)/.exec(line);
    if (modern?.[1]) {
      lastAccount = modern[1];
      if (!accounts.includes(lastAccount)) accounts.push(lastAccount);
      continue;
    }

    const legacy = /Logged in to \S+ as ([A-Za-z0-9-]+)/.exec(line);
    if (legacy?.[1]) {
      lastAccount = legacy[1];
      if (!accounts.includes(lastAccount)) accounts.push(lastAccount);
      // The legacy format has no explicit "active" marker; the first is active.
      activeAccount ??= lastAccount;
      continue;
    }

    if (/Active account:\s*true/i.test(line) && lastAccount) {
      activeAccount = lastAccount;
    }
  }

  return {
    accounts,
    activeAccount: activeAccount ?? accounts[0] ?? null,
    loggedIn: accounts.length > 0
  };
}

export class GhGitHubAdapter implements GitHubAdapter {
  private resolvedPath: string | null | undefined;

  constructor(
    private readonly runner: ProcessRunner,
    private readonly options: GitHubAdapterOptions = {}
  ) {}

  private locate(): string | null {
    if (this.resolvedPath !== undefined) return this.resolvedPath;
    const located = locateExecutable('gh', { configuredPath: this.options.configuredPath ?? null });
    this.resolvedPath = located?.path ?? null;
    return this.resolvedPath;
  }

  private ghPath(): string {
    const path = this.locate();
    if (!path) {
      throw new AgentRelayError('TOOL_MISSING', 'The GitHub CLI (`gh`) was not found.', {
        remediation:
          'Install it with `winget install --id GitHub.cli`, then run `gh auth login` and restart Agent Relay.'
      });
    }
    return path;
  }

  private async gh(
    args: readonly string[],
    options: { cwd?: string; allowFailure?: boolean; timeoutMs?: number } = {}
  ): Promise<ProcessResult> {
    const result = await this.runner.run(this.ghPath(), args, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? this.options.timeoutMs ?? 120_000,
      passthroughEnvNames: GH_ENV_PASSTHROUGH,
      env: {
        // Keep gh non-interactive and machine-readable.
        GH_PROMPT_DISABLED: '1',
        GH_NO_UPDATE_NOTIFIER: '1',
        NO_COLOR: '1',
        CLICOLOR: '0'
      }
    });

    if (!options.allowFailure && result.exitCode !== 0) {
      throw new AgentRelayError('TOOL_FAILED', `gh ${args[0] ?? ''} failed.`, {
        details: redactSecrets((result.stderr || result.stdout).slice(0, 2000))
      });
    }

    return result;
  }

  async diagnose(): Promise<ToolDiagnostic> {
    const checkedAt = new Date().toISOString();
    const path = this.locate();

    if (!path) {
      return {
        tool: 'github',
        status: 'missing',
        executablePath: null,
        version: null,
        detail: 'The GitHub CLI (`gh`) was not found on PATH or in the standard install locations.',
        remediation:
          'Install it with `winget install --id GitHub.cli` (or from https://cli.github.com), then run `gh auth login`.',
        accounts: [],
        activeAccount: null,
        checkedAt
      };
    }

    const version = await this.runner.run(path, ['--version'], { timeoutMs: 20_000 });
    const versionLine = version.stdout.split(/\r?\n/)[0]?.trim() ?? null;

    if (version.exitCode !== 0) {
      return {
        tool: 'github',
        status: 'error',
        executablePath: path,
        version: null,
        detail: redactSecrets(version.stderr || version.stdout).slice(0, 400),
        remediation: 'Run `gh --version` in a terminal to see the underlying failure.',
        accounts: [],
        activeAccount: null,
        checkedAt
      };
    }

    // `gh auth status` writes to stderr on some versions and exits non-zero when
    // logged out, so failures are expected here rather than exceptional.
    const status = await this.gh(['auth', 'status'], { allowFailure: true, timeoutMs: 30_000 });
    const combined = `${status.stdout}\n${status.stderr}`;
    const auth = parseGhAuthStatus(combined);

    if (!auth.loggedIn) {
      return {
        tool: 'github',
        status: 'unauthenticated',
        executablePath: path,
        version: versionLine,
        detail: 'The GitHub CLI is installed but no account is logged in.',
        remediation: 'Run `gh auth login` in a terminal, then re-run diagnostics.',
        accounts: [],
        activeAccount: null,
        checkedAt
      };
    }

    return {
      tool: 'github',
      status: 'ok',
      executablePath: path,
      version: versionLine,
      detail: `Authenticated as ${auth.activeAccount ?? auth.accounts.join(', ')}.`,
      remediation: null,
      accounts: auth.accounts,
      activeAccount: auth.activeAccount,
      checkedAt
    };
  }

  async hasAccessToOwner(owner: string): Promise<boolean> {
    if (!isValidGithubOwner(owner)) return false;

    const me = await this.gh(['api', 'user', '--jq', '.login'], { allowFailure: true });
    if (me.exitCode === 0 && me.stdout.trim().toLowerCase() === owner.toLowerCase()) {
      return true;
    }

    const orgs = await this.gh(['api', 'user/orgs', '--jq', '.[].login'], { allowFailure: true });
    if (orgs.exitCode !== 0) return false;

    return orgs.stdout
      .split(/\r?\n/)
      .map((line) => line.trim().toLowerCase())
      .includes(owner.toLowerCase());
  }

  async repositoryExists(owner: string, name: string): Promise<boolean> {
    if (!isValidGithubOwner(owner) || !isValidRepoName(name)) return false;
    const result = await this.gh(['repo', 'view', `${owner}/${name}`, '--json', 'name'], {
      allowFailure: true
    });
    return result.exitCode === 0;
  }

  async createRepository(request: GitHubRepositoryRequest): Promise<{ url: string; output: string }> {
    const { owner, name, visibility, localPath } = request;

    if (!isValidGithubOwner(owner)) {
      throw new AgentRelayError('VALIDATION_FAILED', `"${owner}" is not a valid GitHub owner name.`);
    }
    if (!isValidRepoName(name)) {
      throw new AgentRelayError('VALIDATION_FAILED', `"${name}" is not a valid repository name.`);
    }

    // `--source` + `--remote` wires up `origin` locally. Note the deliberate
    // absence of `--push`: creating a repository must never also publish code.
    const result = await this.gh(
      [
        'repo',
        'create',
        `${owner}/${name}`,
        visibility === 'private' ? '--private' : '--public',
        '--source',
        localPath,
        '--remote',
        'origin',
        '--disable-wiki'
      ],
      { cwd: localPath, timeoutMs: 180_000 }
    );

    const output = redactSecrets(`${result.stdout}\n${result.stderr}`.trim());
    return { url: extractGithubUrl(output) ?? `https://github.com/${owner}/${name}`, output };
  }

  async createPullRequest(
    request: GitHubPullRequestRequest
  ): Promise<{ url: string; output: string }> {
    const result = await this.gh(
      [
        'pr',
        'create',
        '--base',
        request.baseBranch,
        '--head',
        request.headBranch,
        '--title',
        request.title,
        '--body',
        request.body
      ],
      { cwd: request.worktreePath, timeoutMs: 180_000 }
    );

    const output = redactSecrets(`${result.stdout}\n${result.stderr}`.trim());
    const url = extractGithubUrl(output);
    if (!url) {
      throw new AgentRelayError('TOOL_FAILED', 'gh created the pull request but returned no URL.', {
        details: output.slice(0, 1000)
      });
    }
    return { url, output };
  }
}

/** Pull the first github.com URL out of gh's human-readable output. */
export function extractGithubUrl(output: string): string | null {
  const match = /https:\/\/github\.com\/[A-Za-z0-9._/-]+/.exec(output);
  return match ? match[0].replace(/[.,)]+$/, '') : null;
}
