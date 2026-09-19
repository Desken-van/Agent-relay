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
import {
  SPECIFICATION_FIELD_NAMES,
  type CodexReviewResult,
  type FindingTriageRecommendation,
  type SpecificationRevisionAddressed,
  type TaskSpecification
} from '../../src/shared/schemas/codex';
import type {
  AgentRunContext,
  ClaudeAdapter,
  ClaudeImplementationRequest,
  ClaudeImplementationResult,
  ClaudePermissionDenial,
  ClaudeStreamEvidence,
  ClaudeToolExecution,
  CodexAdapter,
  CodexReviewOutcome,
  CodexReviewRequest,
  CodexRevisionOutcome,
  CodexRevisionRequest,
  CodexSpecificationRequest,
  CodexSpecificationResult,
  CodexTriageOutcome,
  CodexTriageRequest,
  ConfirmationService,
  CreateWorktreeRequest,
  GitAdapter,
  GitHubAdapter,
  GitHubPullRequestRequest,
  GitHubRepositoryRequest,
  ImplementationRequest,
  ImplementationResult
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
    scopedFilePaths: [],
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
  implementationCalls: ImplementationRequest[] = [];
  implementationError: Error | null = null;
  implementationResult: ImplementationResult | null = null;
  async implement(request: ImplementationRequest, context: AgentRunContext): Promise<ImplementationResult> {
    this.implementationCalls.push(request);
    context.onProgress({ type: 'started', text: 'Implementation started', data: { threadId: 'codex-implementation-1' } });
    if (this.implementationError) throw this.implementationError;
    return this.implementationResult ?? { sessionId: 'codex-implementation-1', finalMessage: 'Implemented and verified.', assessment: {
      version: 1, disposition: 'pass', verificationStatus: 'passed', publishBlock: 'none', reasonCodes: [], denials: [],
      verification: { tool: 'Codex', command: 'npm test', matchedRule: 'Bash(npm test:*)', toolUseSequence: 1 }
    } };
  }
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

  triageCalls: CodexTriageRequest[] = [];
  /** Queue of recommendation sets, consumed one per `triageFindings` call. */
  triageQueue: FindingTriageRecommendation[][] = [];
  triageError: Error | null = null;
  /** Held open until resolved, so a test can observe state while a triage call is in flight. */
  triageGate: Promise<unknown> | null = null;

  async triageFindings(
    request: CodexTriageRequest,
    context: AgentRunContext
  ): Promise<CodexTriageOutcome> {
    this.triageCalls.push(request);
    context.onProgress({ type: 'progress', text: 'fake codex: triaging' });
    if (this.triageGate) await this.triageGate;
    if (this.triageError) throw this.triageError;
    const recommendations = this.triageQueue.shift() ?? request.findings.map((finding) => ({
      findingRef: finding.ref,
      recommendation: 'needs_user' as const,
      reason: 'fake default recommendation',
      evidenceRef: 'fake evidence',
      confidence: 'uncertain' as const
    }));
    return { recommendations, rawResponse: JSON.stringify({ results: recommendations }) };
  }

  revisionCalls: CodexRevisionRequest[] = [];
  /** Specifications returned by `reviseSpecification`, one per call, in order. */
  revisionQueue: TaskSpecification[] = [];
  revisionError: Error | null = null;
  /** Held open until resolved, so a test can observe state while a revision is in flight. */
  revisionGate: Promise<unknown> | null = null;

  async reviseSpecification(
    request: CodexRevisionRequest,
    context: AgentRunContext
  ): Promise<CodexRevisionOutcome> {
    this.revisionCalls.push(request);
    context.onProgress({ type: 'progress', text: 'fake codex: revising specification' });
    if (this.revisionGate) await this.revisionGate;
    if (this.revisionError) throw this.revisionError;
    // By default a genuinely different specification that reflects every accepted
    // finding, so a loop test does not have to hand-write each revision.
    const specification =
      this.revisionQueue.shift() ??
      makeSpecification({
        ...request.currentSpecification,
        summary: `${request.currentSpecification.summary} (revised in correction round ${request.round})`,
        acceptanceCriteria: [
          ...request.currentSpecification.acceptanceCriteria,
          ...request.acceptedFindings.map((finding) => `Addresses: ${finding.title}`)
        ]
      });
    // Honest by default: each accepted finding is reported against the first field
    // that really differs. A test that needs a lie sets `revisionAddressed`.
    const changedField =
      SPECIFICATION_FIELD_NAMES.find(
        (field) => JSON.stringify(request.currentSpecification[field]) !== JSON.stringify(specification[field])
      ) ?? 'summary';
    const addressed =
      this.revisionAddressed ??
      request.acceptedFindings.map((finding) => ({
        finding: finding.finding,
        field: changedField,
        change: `Reflected "${finding.title}" in ${changedField}.`
      }));
    this.revisionAddressed = null;
    return { specification, addressed, rawResponse: JSON.stringify({ specification, addressed }) };
  }

  /** Overrides what the next revision claims to have addressed (consumed by one call). */
  revisionAddressed: SpecificationRevisionAddressed[] | null = null;

  async diagnose(): Promise<ToolDiagnostic> {
    return okDiagnostic('codex');
  }
}

/* -------------------------------------------------------------------------- */
/* Claude                                                                      */
/* -------------------------------------------------------------------------- */

/** One completed, successful `npm test` — what the default rules look for. */
export function passingToolExecution(
  overrides: Partial<ClaudeToolExecution> = {}
): ClaudeToolExecution {
  return {
    toolUseId: 'fake-tool-1',
    toolUseSequence: 1,
    tool: 'Bash',
    command: 'npm test',
    commandTruncated: false,
    summary: 'Bash: npm test',
    toolUseSeen: true,
    resultReceived: true,
    isError: false,
    resultConflict: false,
    ...overrides
  };
}

/** Stream evidence for a round that verified itself and reported cleanly. */
export function passingVerificationEvidence(
  overrides: Partial<ClaudeStreamEvidence> = {}
): ClaudeStreamEvidence {
  return {
    toolExecutions: [passingToolExecution()],
    resultEnvelopeSeen: true,
    resultEnvelopeIsError: false,
    resultEnvelopeConflict: false,
    malformedLineCount: 0,
    incompleteToolUseCount: 0,
    orphanToolResultCount: 0,
    ...overrides
  };
}

export class FakeClaudeAdapter implements ClaudeAdapter {
  reviewCalls: CodexReviewRequest[] = [];
  async reviewImplementation(request: CodexReviewRequest, _context: AgentRunContext): Promise<CodexReviewOutcome> {
    this.reviewCalls.push(request);
    const review = makeReview();
    return { threadId: 'claude-review-1', review, rawResponse: JSON.stringify(review) };
  }
  calls: ClaudeImplementationRequest[] = [];
  sessionId: string | null = 'claude-session-1';
  finalMessage = 'Implemented the change and ran the tests.\n\n```\n2 passed\n```';
  isError = false;
  permissionDenials: ClaudePermissionDenial[] = [];
  /**
   * Evidence of a normal, healthy round: the default verification command ran
   * once and passed.
   *
   * This is not incidental detail. Since the round policy decides the outcome
   * from evidence, a fake that produced none would model a round that never
   * checked its work — and every test using it would be asserting against a
   * failure. Tests that want a different story replace this.
   */
  evidence: ClaudeStreamEvidence = passingVerificationEvidence();
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
      // Only a CLI-level failure, mirroring the real adapter. What a denial
      // means for the round is the policy's decision, not the adapter's.
      isError: this.isError,
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
