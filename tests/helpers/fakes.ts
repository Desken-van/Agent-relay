/**
 * Test doubles for every external integration.
 *
 * These implement the same interfaces as the real adapters, which is the entire
 * reason `ports.ts` exists. No module is mocked and no network, Codex, Claude or
 * GitHub call is made anywhere in the test suite.
 */

import type { ToolDiagnostic } from '../../src/shared/domain/diagnostics';
import type { GitChangeSet, RepositoryInfo, WorktreeInfo } from '../../src/shared/domain/git';
import type { PublishConfirmation } from '../../src/shared/ipc';
import type { CodexReviewResult, TaskSpecification } from '../../src/shared/schemas/codex';
import type {
  AgentRunContext,
  ClaudeAdapter,
  ClaudeImplementationRequest,
  ClaudeImplementationResult,
  ClaudePermissionDenial,
  ClaudeStreamEvidence,
  CodexAdapter,
  CodexReviewOutcome,
  CodexReviewRequest,
  CodexSpecificationRequest,
  CodexSpecificationResult,
  ConfirmationService,
  CreateWorktreeRequest,
  GitAdapter,
  GitHubAdapter,
  GitHubPullRequestRequest,
  GitHubRepositoryRequest
} from '../../src/main/ports';

export function makeSpecification(overrides: Partial<TaskSpecification> = {}): TaskSpecification {
  return {
    title: 'Add a health endpoint',
    summary: 'Expose GET /health returning a JSON status payload.',
    assumptions: ['The service already has an HTTP router.'],
    acceptanceCriteria: ['GET /health responds 200 with {"status":"ok"}.'],
    constraints: ['Do not change the existing routes.'],
    suggestedTests: ['A test asserting GET /health returns 200.'],
    implementationPrompt: 'Add a /health route and a test for it.',
    ...overrides
  };
}

export function makeReview(overrides: Partial<CodexReviewResult> = {}): CodexReviewResult {
  return {
    verdict: 'approved',
    summary: 'Meets every acceptance criterion.',
    findings: [],
    followUpPrompt: '',
    suggestedTests: [],
    ...overrides
  };
}

const okDiagnostic = (tool: ToolDiagnostic['tool']): ToolDiagnostic => ({
  tool,
  status: 'ok',
  executablePath: `/fake/${tool}`,
  version: '1.0.0-fake',
  detail: 'fake adapter',
  remediation: null,
  checkedAt: new Date().toISOString()
});

/* -------------------------------------------------------------------------- */
/* Codex                                                                       */
/* -------------------------------------------------------------------------- */

export class FakeCodexAdapter implements CodexAdapter {
  specificationCalls: CodexSpecificationRequest[] = [];
  reviewCalls: CodexReviewRequest[] = [];

  /** Queue of review verdicts, consumed one per `reviewImplementation` call. */
  reviewQueue: CodexReviewResult[] = [];
  specification: TaskSpecification = makeSpecification();
  threadId: string | null = 'codex-thread-1';

  specificationError: Error | null = null;
  reviewError: Error | null = null;

  async createSpecification(
    request: CodexSpecificationRequest,
    context: AgentRunContext
  ): Promise<CodexSpecificationResult> {
    this.specificationCalls.push(request);
    context.onProgress({ type: 'progress', text: 'fake codex: specifying' });
    if (this.specificationError) throw this.specificationError;
    return {
      threadId: this.threadId,
      specification: this.specification,
      rawResponse: JSON.stringify(this.specification)
    };
  }

  async reviewImplementation(
    request: CodexReviewRequest,
    context: AgentRunContext
  ): Promise<CodexReviewOutcome> {
    this.reviewCalls.push(request);
    context.onProgress({ type: 'progress', text: 'fake codex: reviewing' });
    if (this.reviewError) throw this.reviewError;

    const review = this.reviewQueue.shift() ?? makeReview();
    return { threadId: this.threadId, review, rawResponse: JSON.stringify(review) };
  }

  async diagnose(): Promise<ToolDiagnostic> {
    return okDiagnostic('codex');
  }
}

/* -------------------------------------------------------------------------- */
/* Claude                                                                      */
/* -------------------------------------------------------------------------- */

export class FakeClaudeAdapter implements ClaudeAdapter {
  calls: ClaudeImplementationRequest[] = [];
  sessionId: string | null = 'claude-session-1';
  finalMessage = 'Implemented the change and ran the tests.\n\n```\n2 passed\n```';
  isError = false;
  permissionDenials: ClaudePermissionDenial[] = [];
  /** Telemetry only; overridden by the few tests that assert on it. */
  evidence: ClaudeStreamEvidence = {
    toolExecutions: [],
    resultEnvelopeSeen: true,
    resultEnvelopeIsError: false,
    resultEnvelopeConflict: false,
    malformedLineCount: 0,
    incompleteToolUseCount: 0,
    orphanToolResultCount: 0
  };
  error: Error | null = null;
  /** Set to observe cancellation without a real process. */
  onRun: ((request: ClaudeImplementationRequest, context: AgentRunContext) => void) | null = null;

  async run(
    request: ClaudeImplementationRequest,
    context: AgentRunContext
  ): Promise<ClaudeImplementationResult> {
    this.calls.push(request);
    this.onRun?.(request, context);
    context.onProgress({ type: 'assistant_message', text: 'fake claude: working' });
    if (this.error) throw this.error;

    return {
      sessionId: this.sessionId,
      finalMessage: this.finalMessage,
      // A denial always fails the round, mirroring the real adapter.
      isError: this.isError || this.permissionDenials.length > 0,
      numTurns: 3,
      rawResultJson: null,
      permissionDenials: this.permissionDenials,
      evidence: this.evidence
    };
  }

  async diagnose(): Promise<ToolDiagnostic> {
    return okDiagnostic('claude');
  }
}

/* -------------------------------------------------------------------------- */
/* Git                                                                         */
/* -------------------------------------------------------------------------- */

export function makeRepositoryInfo(overrides: Partial<RepositoryInfo> = {}): RepositoryInfo {
  return {
    isRepository: true,
    root: 'C:\\repo',
    currentBranch: 'main',
    defaultBranchGuess: 'main',
    branches: ['main'],
    hasRemoteOrigin: true,
    remoteUrl: 'https://github.com/acme/thing.git',
    isClean: true,
    dirtyFiles: [],
    userName: 'Test User',
    userEmail: 'test@example.com',
    headCommit: 'a'.repeat(40),
    ...overrides
  };
}

export function makeChangeSet(overrides: Partial<GitChangeSet> = {}): GitChangeSet {
  return {
    statusShort: ' M src/app.ts',
    changedFiles: [
      { path: 'src/app.ts', status: 'M', insertions: 12, deletions: 2, binary: false }
    ],
    diffStat: ' src/app.ts | 14 ++++++++++----',
    diff: 'diff --git a/src/app.ts b/src/app.ts\n+++ added',
    diffTruncated: false,
    diffBytes: 42,
    recentCommits: [],
    isEmpty: false,
    collectedAt: new Date().toISOString(),
    ...overrides
  };
}

export class FakeGitAdapter implements GitAdapter {
  repository: RepositoryInfo = makeRepositoryInfo();
  changes: GitChangeSet = makeChangeSet();
  existingBranches = new Set<string>(['main']);
  createdWorktrees: CreateWorktreeRequest[] = [];
  commits: { path: string; message: string }[] = [];
  pushes: { path: string; remote: string; branch: string }[] = [];
  stagedPaths: string[] = [];
  createWorktreeError: Error | null = null;

  async inspect(): Promise<RepositoryInfo> {
    return this.repository;
  }

  async branchExists(_repositoryPath: string, branch: string): Promise<boolean> {
    return this.existingBranches.has(branch);
  }

  async createWorktree(request: CreateWorktreeRequest): Promise<WorktreeInfo> {
    if (this.createWorktreeError) throw this.createWorktreeError;
    this.createdWorktrees.push(request);
    this.existingBranches.add(request.branchName);
    return { path: request.worktreePath, branch: request.branchName, head: 'b'.repeat(40), isLocked: false };
  }

  async listWorktrees(): Promise<WorktreeInfo[]> {
    return this.createdWorktrees.map((request) => ({
      path: request.worktreePath,
      branch: request.branchName,
      head: null,
      isLocked: false
    }));
  }

  async removeWorktree(): Promise<void> {
    // no-op
  }

  async collectChanges(): Promise<GitChangeSet> {
    return this.changes;
  }

  async initRepository(): Promise<RepositoryInfo> {
    return this.repository;
  }

  async stageAll(worktreePath: string): Promise<void> {
    this.stagedPaths.push(worktreePath);
  }

  async commit(worktreePath: string, message: string): Promise<{ commit: string }> {
    this.commits.push({ path: worktreePath, message });
    return { commit: 'c'.repeat(40) };
  }

  async push(path: string, remote: string, branch: string): Promise<{ output: string }> {
    this.pushes.push({ path, remote, branch });
    return { output: 'pushed' };
  }

  async diagnose(): Promise<ToolDiagnostic> {
    return okDiagnostic('git');
  }
}

/* -------------------------------------------------------------------------- */
/* GitHub                                                                      */
/* -------------------------------------------------------------------------- */

export class FakeGitHubAdapter implements GitHubAdapter {
  createdRepositories: GitHubRepositoryRequest[] = [];
  createdPullRequests: GitHubPullRequestRequest[] = [];
  existingRepositories = new Set<string>();
  accessibleOwners = new Set<string>(['Desken-van']);

  async diagnose(): Promise<ToolDiagnostic> {
    return okDiagnostic('github');
  }

  async hasAccessToOwner(owner: string): Promise<boolean> {
    return this.accessibleOwners.has(owner);
  }

  async repositoryExists(owner: string, name: string): Promise<boolean> {
    return this.existingRepositories.has(`${owner}/${name}`);
  }

  async createRepository(request: GitHubRepositoryRequest): Promise<{ url: string; output: string }> {
    this.createdRepositories.push(request);
    return {
      url: `https://github.com/${request.owner}/${request.name}`,
      output: 'created'
    };
  }

  async createPullRequest(
    request: GitHubPullRequestRequest
  ): Promise<{ url: string; output: string }> {
    this.createdPullRequests.push(request);
    return { url: 'https://github.com/acme/thing/pull/1', output: 'created' };
  }
}

/* -------------------------------------------------------------------------- */
/* Confirmation                                                                */
/* -------------------------------------------------------------------------- */

export class RecordingConfirmationService implements ConfirmationService {
  requests: PublishConfirmation[] = [];
  simpleRequests: { headline: string }[] = [];

  constructor(private answer: boolean) {}

  setAnswer(answer: boolean): void {
    this.answer = answer;
  }

  async confirm(request: PublishConfirmation): Promise<boolean> {
    this.requests.push(request);
    return this.answer;
  }

  async confirmSimple(request: { headline: string }): Promise<boolean> {
    this.simpleRequests.push({ headline: request.headline });
    return this.answer;
  }
}
