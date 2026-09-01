/**
 * Publishing: the only code path that may write a commit or touch GitHub.
 *
 * The gate is deliberately structural rather than advisory:
 *
 *   1. the task must be in READY_TO_PUBLISH (i.e. Codex approved *and* the user
 *      then pressed "Approve for publishing");
 *   2. an {@link Approval} row is written as `pending` **before** the user is
 *      asked, so a crash mid-dialog leaves evidence;
 *   3. {@link ConfirmationService} must return true — in production that is a
 *      native modal owned by the main process, which a compromised renderer
 *      cannot answer on the user's behalf;
 *   4. the most recent Claude implementation round must have *shown* that it
 *      checked its work — see {@link PublishService.assertRoundPublishable};
 *   5. only then does the adapter get called.
 *
 * Step 5 is unreachable without step 3, which is what the
 * "publishing cannot occur without approval" tests assert.
 *
 * Step 4 is the newer one, and it is a gate rather than a warning because the
 * failure it prevents is silent: a round in which the tests were blocked exits
 * cleanly and reads as a success. Codex approving the diff does not cover it —
 * a reviewer reads the change, not the evidence that it runs.
 */

import {
  assessmentPublishRefusal,
  latestClaudeRoundResult,
  readClaudeAssessment,
  type PublishRefusalCode
} from '../../shared/domain/claude-assessment';
import { AgentRelayError } from '../../shared/domain/errors';
import type { Approval, ApprovalAction, GithubVisibility, Project, Task } from '../../shared/domain/models';
import { assertPublishable } from '../../shared/domain/workflow';
import type { PublishConfirmation, PublishOutcome } from '../../shared/ipc';
import { isValidGithubOwner, isValidRepoName } from '../../shared/util/slug';
import type {
  ApprovalRepository,
  Clock,
  ConfirmationService,
  EventPublisher,
  GitAdapter,
  GitHubAdapter,
  IdGenerator,
  ProjectRepository,
  RunEventRepository,
  RunRepository,
  SettingsRepository,
  TaskRepository
} from '../ports';
import { RunRecorder } from './run-recorder';

export interface PublishRequest {
  readonly taskId: string;
  readonly action: ApprovalAction;
  readonly commitMessage?: string;
  readonly repositoryName?: string;
  readonly owner?: string;
  readonly visibility?: GithubVisibility;
  readonly pullRequestTitle?: string;
  readonly pullRequestBody?: string;
}

export interface PublishServiceDeps {
  readonly tasks: TaskRepository;
  readonly projects: ProjectRepository;
  readonly approvals: ApprovalRepository;
  readonly runs: RunRepository;
  readonly runEvents: RunEventRepository;
  readonly settings: SettingsRepository;
  readonly git: GitAdapter;
  readonly github: GitHubAdapter;
  readonly confirmation: ConfirmationService;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly events: EventPublisher;
}

const ACTION_HEADLINES: Record<ApprovalAction, string> = {
  commit: 'Create a Git commit in the task worktree',
  push: 'Push the task branch to the remote',
  create_repository: 'Create a new repository on GitHub',
  create_pull_request: 'Open a pull request on GitHub'
};

const REMOTE_ACTIONS: ReadonlySet<ApprovalAction> = new Set([
  'push',
  'create_repository',
  'create_pull_request'
]);

export class PublishService {
  constructor(private readonly deps: PublishServiceDeps) {}

  private requireTask(taskId: string): Task {
    const task = this.deps.tasks.findById(taskId);
    if (!task) throw new AgentRelayError('NOT_FOUND', `No task with id ${taskId}.`);
    return task;
  }

  private requireProject(projectId: string): Project {
    const project = this.deps.projects.findById(projectId);
    if (!project) throw new AgentRelayError('NOT_FOUND', `No project with id ${projectId}.`);
    return project;
  }

  /**
   * Build exactly the summary the user will be shown. Pure — calling this
   * changes nothing, which is what lets the UI display it before asking.
   */
  prepare(request: PublishRequest): PublishConfirmation {
    const task = this.requireTask(request.taskId);
    const project = this.requireProject(task.projectId);
    const settings = this.deps.settings.get();

    const owner = (request.owner ?? project.githubOwner ?? settings.githubOwner ?? '').trim();
    const repository = (request.repositoryName ?? project.githubRepo ?? project.name).trim();
    const visibility = request.visibility ?? project.githubVisibility;
    const branch = task.branchName ?? '(no branch yet)';

    const details: string[] = [];

    switch (request.action) {
      case 'commit':
        details.push(`Worktree: ${task.worktreePath ?? '(none)'}`);
        details.push(`Commit message: ${request.commitMessage ?? defaultCommitMessage(task)}`);
        details.push('This stages every change in the worktree and creates one commit.');
        details.push('Nothing is sent anywhere. This is a local operation.');
        break;

      case 'push':
        details.push(`Worktree: ${task.worktreePath ?? '(none)'}`);
        details.push(`Remote: origin`);
        details.push(`This uploads the branch "${branch}" to GitHub.`);
        details.push('Force-push is never used.');
        break;

      case 'create_repository':
        details.push(`This creates ${owner}/${repository} on GitHub as a ${visibility} repository.`);
        details.push(`It sets "origin" on ${project.localPath}.`);
        details.push('No code is pushed by this step.');
        break;

      case 'create_pull_request':
        details.push(`Base branch: ${task.baseBranch ?? project.defaultBranch}`);
        details.push(`Head branch: ${branch}`);
        details.push(`Title: ${request.pullRequestTitle ?? task.title}`);
        details.push('The branch must already be pushed for this to succeed.');
        break;
    }

    return {
      action: request.action,
      headline: ACTION_HEADLINES[request.action],
      account: owner || '(not configured)',
      repository: repository || '(not configured)',
      visibility,
      branch,
      details,
      affectsRemote: REMOTE_ACTIONS.has(request.action)
    };
  }

  /**
   * Refuse to publish a task whose latest Claude round did not verify itself.
   *
   * "Latest" means the last Claude round in run order, chosen by the same
   * shared selector the orchestrator and the timeline use — so the evidence
   * being checked belongs to the code that is about to ship, and all three
   * agree about which round that is.
   *
   * A block is not permanent: a later clean round produces its own assessment,
   * and once that round has been reviewed and approved the gate opens. The
   * earlier denial stays in the run history either way; nothing here rewrites it.
   */
  private assertRoundPublishable(task: Task): void {
    const refusal = assessmentPublishRefusal(
      readClaudeAssessment(latestClaudeRoundResult(this.deps.runs.listByTask(task.id)))
    );
    if (!refusal.blocked) return;

    throw new AgentRelayError('VALIDATION_FAILED', PUBLISH_REFUSAL_MESSAGES[refusal.code], {
      remediation: PUBLISH_REFUSAL_REMEDIATIONS[refusal.code]
    });
  }

  async execute(request: PublishRequest): Promise<PublishOutcome> {
    const task = this.requireTask(request.taskId);
    const project = this.requireProject(task.projectId);
    const confirmation = this.prepare(request);

    // 1. Record the request before asking, so the audit trail exists even if the
    //    application dies while the dialog is open.
    const approval: Approval = {
      id: this.deps.ids.next(),
      taskId: task.id,
      action: request.action,
      status: 'pending',
      details: JSON.stringify(confirmation),
      requestedAt: this.deps.clock.nowIso(),
      resolvedAt: null
    };
    this.deps.approvals.create(approval);

    // 2. Ask. This is the hard gate.
    const granted = await this.deps.confirmation.confirm(confirmation);
    if (!granted) {
      this.deps.approvals.resolve(approval.id, 'denied', this.deps.clock.nowIso());
      return {
        action: request.action,
        approvalId: approval.id,
        performed: false,
        message: 'Cancelled — nothing was changed.',
        url: null
      };
    }
    this.deps.approvals.resolve(approval.id, 'granted', this.deps.clock.nowIso());

    // 3. Domain gate: even with an approval, the task must be in a publishable
    //    state. Belt and braces against a UI that got ahead of itself.
    assertPublishable(task.status, true, request.action);

    // 4. Evidence gate: the latest implementation round has to have proved it
    //    verified the work. Deliberately after the approval is resolved, so the
    //    audit trail records what the user was asked and what came of it.
    this.assertRoundPublishable(task);

    const settings = this.deps.settings.get();
    const recorder = new RunRecorder(
      this.deps.runs,
      this.deps.runEvents,
      this.deps.clock,
      this.deps.ids,
      this.deps.events,
      settings.maxStoredLogBytes
    );

    const running = this.deps.tasks.update(task.id, { status: 'PUBLISHING' });
    this.deps.events.publishTask(running);

    const handle = recorder.start({
      taskId: task.id,
      agent: 'system',
      runType: request.action === 'commit' ? 'git' : 'github',
      round: task.currentRound
    });

    try {
      handle.append({ type: 'started', text: confirmation.headline });

      const outcome = await this.perform(request, task, project, confirmation, (text) =>
        handle.append({ type: 'log', text })
      );

      handle.finish({
        status: 'succeeded',
        finalMessage: outcome.message,
        structuredResult: { action: request.action, url: outcome.url }
      });

      // Opening a pull request is the natural end of the workflow; the other
      // steps return to READY_TO_PUBLISH so the sequence can continue.
      const nextStatus =
        request.action === 'create_pull_request' ? ('COMPLETED' as const) : ('READY_TO_PUBLISH' as const);
      const updated = this.deps.tasks.update(task.id, { status: nextStatus, lastError: null });
      this.deps.events.publishTask(updated);

      return { ...outcome, action: request.action, approvalId: approval.id, performed: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      handle.finish({ status: 'failed', errorMessage: message });

      // Return to READY_TO_PUBLISH rather than FAILED: the user can fix the
      // cause (log in to gh, push first) and try the same step again.
      const reverted = this.deps.tasks.update(task.id, {
        status: 'READY_TO_PUBLISH',
        lastError: message
      });
      this.deps.events.publishTask(reverted);
      throw error;
    }
  }

  /** Finish a task without opening a pull request. */
  markCompleted(taskId: string): Task {
    const task = this.requireTask(taskId);
    if (task.status !== 'READY_TO_PUBLISH') {
      throw new AgentRelayError(
        'INVALID_TRANSITION',
        `A task can only be finished from READY_TO_PUBLISH (it is ${task.status}).`
      );
    }
    const updated = this.deps.tasks.update(taskId, { status: 'COMPLETED' });
    this.deps.events.publishTask(updated);
    return updated;
  }

  private async perform(
    request: PublishRequest,
    task: Task,
    project: Project,
    confirmation: PublishConfirmation,
    log: (text: string) => void
  ): Promise<{ message: string; url: string | null }> {
    switch (request.action) {
      case 'commit': {
        const worktreePath = requireWorktree(task);
        const message = request.commitMessage ?? defaultCommitMessage(task);

        const info = await this.deps.git.inspect(worktreePath);
        if (!info.userName || !info.userEmail) {
          throw new AgentRelayError(
            'GIT_FAILED',
            'Git has no commit identity configured, so a commit cannot be created.',
            {
              remediation:
                'Run `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"`, then try again.'
            }
          );
        }

        log('Staging all changes in the worktree…');
        await this.deps.git.stageAll(worktreePath);
        log(`Committing: ${message}`);
        const { commit } = await this.deps.git.commit(worktreePath, message);
        return { message: `Created commit ${commit.slice(0, 10)}.`, url: null };
      }

      case 'push': {
        const worktreePath = requireWorktree(task);
        const branch = requireBranch(task);

        const info = await this.deps.git.inspect(worktreePath);
        if (!info.hasRemoteOrigin) {
          throw new AgentRelayError('GIT_FAILED', 'This repository has no "origin" remote.', {
            remediation: 'Create the GitHub repository first, or add a remote manually.'
          });
        }

        log(`Pushing ${branch} to origin…`);
        const { output } = await this.deps.git.push(worktreePath, 'origin', branch);
        log(output);
        return { message: `Pushed ${branch} to origin.`, url: null };
      }

      case 'create_repository': {
        const owner = confirmation.account;
        const name = confirmation.repository;

        if (!isValidGithubOwner(owner)) {
          throw new AgentRelayError('VALIDATION_FAILED', `"${owner}" is not a valid GitHub owner.`);
        }
        if (!isValidRepoName(name)) {
          throw new AgentRelayError('VALIDATION_FAILED', `"${name}" is not a valid repository name.`);
        }

        if (await this.deps.github.repositoryExists(owner, name)) {
          throw new AgentRelayError('VALIDATION_FAILED', `${owner}/${name} already exists on GitHub.`, {
            remediation: 'Pick a different repository name, or push to the existing repository instead.'
          });
        }

        log(`Creating ${owner}/${name} (${confirmation.visibility})…`);
        const result = await this.deps.github.createRepository({
          owner,
          name,
          visibility: confirmation.visibility === 'public' ? 'public' : 'private',
          localPath: project.localPath
        });

        this.deps.projects.update(project.id, {
          githubOwner: owner,
          githubRepo: name,
          githubVisibility: confirmation.visibility === 'public' ? 'public' : 'private'
        });

        return { message: `Created ${owner}/${name}.`, url: result.url };
      }

      case 'create_pull_request': {
        const worktreePath = requireWorktree(task);
        const branch = requireBranch(task);
        const base = task.baseBranch ?? project.defaultBranch;

        log(`Opening a pull request: ${branch} -> ${base}`);
        const result = await this.deps.github.createPullRequest({
          worktreePath,
          baseBranch: base,
          headBranch: branch,
          title: request.pullRequestTitle ?? task.title,
          body: request.pullRequestBody ?? defaultPullRequestBody(task)
        });

        return { message: `Opened pull request.`, url: result.url };
      }

      default: {
        const exhaustive: never = request.action;
        throw new AgentRelayError('VALIDATION_FAILED', `Unsupported action: ${String(exhaustive)}`);
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function requireWorktree(task: Task): string {
  if (!task.worktreePath) {
    throw new AgentRelayError('WORKTREE_INVALID', 'This task has no worktree.');
  }
  return task.worktreePath;
}

function requireBranch(task: Task): string {
  if (!task.branchName) {
    throw new AgentRelayError('VALIDATION_FAILED', 'This task has no branch.');
  }
  return task.branchName;
}

export function defaultCommitMessage(task: Task): string {
  return `${task.title}\n\nImplemented by Claude Code and reviewed by Codex via Agent Relay.\nTask: ${task.id}`;
}

export function defaultPullRequestBody(task: Task): string {
  return [
    `## ${task.title}`,
    '',
    '### Original request',
    task.originalRequest,
    '',
    '---',
    `Specified and reviewed by Codex, implemented by Claude Code, relayed by Agent Relay.`,
    `Review rounds used: ${task.currentRound} of ${task.maxRounds}.`
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* Why publishing was refused                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One message per refusal code.
 *
 * A total record rather than a switch, so adding a block kind fails to compile
 * until it has been given something honest to say.
 */
const PUBLISH_REFUSAL_MESSAGES: Record<PublishRefusalCode, string> = {
  verification:
    'The latest Claude round did not pass verification, so this change has not been shown to work.',
  security:
    'The latest Claude round had a security-critical command blocked, so it is not eligible for publishing.',
  telemetry:
    'The latest Claude round left ambiguous evidence, so whether the change was verified cannot be established.',
  configuration:
    'The latest Claude round could not be judged because the verification settings were unusable.',
  none: 'Publishing is blocked.',
  absent:
    'The latest Claude round predates verification tracking, so there is no evidence it checked its work.',
  malformed:
    'The verification record for the latest Claude round could not be read, so it cannot be relied on.',
  unsupported_version:
    'The verification record for the latest Claude round was written by a newer version of Agent Relay.'
};

const RUN_ANOTHER_ROUND =
  'Run another implementation or correction round, then have Codex review and approve it again.';

const PUBLISH_REFUSAL_REMEDIATIONS: Record<PublishRefusalCode, string> = {
  verification: `Fix the failing checks, then ${RUN_ANOTHER_ROUND.charAt(0).toLowerCase()}${RUN_ANOTHER_ROUND.slice(1)}`,
  security:
    'Publishing is done through this dialog, not by the agent. ' + RUN_ANOTHER_ROUND,
  telemetry: RUN_ANOTHER_ROUND,
  configuration:
    'Fix the verification commands under Settings → Claude permissions, then ' +
    'run another implementation or correction round.',
  none: RUN_ANOTHER_ROUND,
  absent: RUN_ANOTHER_ROUND,
  malformed: RUN_ANOTHER_ROUND,
  unsupported_version:
    'Update Agent Relay, or run another implementation round with this version.'
};
