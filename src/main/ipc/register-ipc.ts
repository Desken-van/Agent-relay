/**
 * IPC registration.
 *
 * A single `ipcMain.handle` for a single channel. The operation the renderer
 * wants travels *inside* the payload and is looked up in a fixed table, which
 * means:
 *
 *   * an unknown operation name is rejected before any handler code runs;
 *   * every payload is parsed with the channel's Zod schema, so handlers receive
 *     a value of the declared type or nothing at all;
 *   * handlers never reject — errors are normalised into a redacted
 *     {@link SerializedError}, so the renderer cannot be handed a stack trace.
 *
 * There is no channel anywhere in this table that accepts a command, an
 * executable path to run, or a script. The renderer cannot ask the main process
 * to run something; it can only ask for one of these named operations.
 */

import { dialog, ipcMain, type BrowserWindow } from 'electron/main';
import { shell } from 'electron/common';
import { AgentRelayError, toSerializedError } from '../../shared/domain/errors';
import {
  ipcInputSchemas,
  isIpcChannel,
  type IpcChannel,
  type IpcInput,
  type IpcResponseMap,
  type IpcResult
} from '../../shared/ipc';
import { IPC_INVOKE_CHANNEL } from '../../shared/ipc-channels';
import type { Application } from '../container';
import { assertKnownPath } from '../services/path-safety';
import { parsePlanReviewFindings } from '../../shared/domain/plan-review';
import type { CodeReviewDecision } from '../../shared/domain/code-review';
import { redactAndTruncate } from '../../shared/util/redact';
import {
  planReviewGateIdentity,
  readBoundRuleEvidence
} from '../services/plan-review-gate';
import {
  configuredRuleSources,
  externalPlanReviewConfig,
  TASK_RULE_EVIDENCE_LIMITS
} from '../services/plan-review-configuration';

/** Hosts the app is allowed to open in the user's browser. */
const ALLOWED_EXTERNAL_HOSTS = new Set([
  'github.com',
  'www.github.com',
  'cli.github.com',
  'docs.github.com',
  'git-scm.com',
  'docs.anthropic.com',
  'developers.openai.com',
  'platform.openai.com'
]);

type Handlers = {
  [C in IpcChannel]: (input: IpcInput<C>) => Promise<IpcResponseMap[C]> | IpcResponseMap[C];
};

export interface IpcContext {
  readonly app: Application;
  readonly getWindow: () => BrowserWindow | null;
}

function buildHandlers({ app, getWindow }: IpcContext): Handlers {
  /** Roots the renderer is allowed to ask the shell to reveal. */
  const knownRoots = (): string[] => {
    const settings = app.settings.get();
    return [
      settings.worktreesRoot,
      settings.projectsRoot,
      ...app.projects.list().map((project) => project.localPath)
    ];
  };

  const planReviewService = () => app.createPlanReviewGate(externalPlanReviewConfig(app.settings.get()));

  const codeReviewDetail = async (taskId: string): Promise<IpcResponseMap['codeReview:get']> => {
    const task = app.tasks.findById(taskId);
    if (task === null) throw new AgentRelayError('NOT_FOUND', 'No such task.');

    // Reading identity means capturing the working tree again, which can fail
    // for reasons that say nothing about staleness — a removed worktree, an
    // unreadable checkout. That distinction is preserved rather than collapsed
    // into "stale", because the action staleness suggests is to capture again,
    // and capture is exactly what failed.
    let identity: Awaited<ReturnType<typeof app.codeReview.subjectIdentity>>;
    let identityProblem: string | null = null;
    try {
      identity = await app.codeReview.subjectIdentity(taskId);
    } catch (error) {
      identity = {
        identity: 'unknown',
        stored: app.codeReviews.latestSubject(taskId),
        currentSha256: null,
        problem: null
      };
      identityProblem = redactAndTruncate(
        error instanceof Error ? error.message : String(error),
        2_000
      );
    }

    const all = app.codeReviews.listFindings(taskId);
    // Live findings exist only when the subject is provably current. `stale`,
    // `unknown` and `incomplete` each mean something different, and none of
    // them means "these findings describe the code you have" — so the live
    // field is empty and everything stays visible as history instead.
    const live =
      identity.identity === 'current' && identity.stored !== null
        ? all.filter((finding) => finding.subjectSha256 === identity.stored?.subjectSha256)
        : [];
    // One current decision per finding that has one. Assembled here so a client
    // can render what was decided without a second round trip per finding, and
    // bounded by the finding count rather than by the full decision history.
    const latestDecisions: Record<string, CodeReviewDecision> = {};
    for (const finding of all) {
      const decision = app.codeReviews.latestDecision(finding.id);
      if (decision !== null) latestDecisions[finding.id] = decision;
    }

    return {
      subject: identity.stored,
      subjectIdentity: identity.identity,
      rounds: app.codeReviews.listRounds(taskId),
      findings: live,
      historicalFindings: all,
      latestDecisions,
      totalFindingsEverRecorded: all.length,
      identityProblem: identityProblem ?? identity.problem
    };
  };
  const planReviewDetail = (taskId: string): IpcResponseMap['planReview:get'] => {
    const task = app.tasks.findById(taskId);
    if (task === null) throw new AgentRelayError('NOT_FOUND', 'No such task.');
    const binding = app.taskRuleEvidence.findByTask(taskId);
    // A binding that exists but cannot be read back is its own state. Letting
    // the throw escape made the whole detail fail, and the screen then showed
    // the "no rules bound yet" call to action for a task that is bound.
    let snapshot: ReturnType<typeof readBoundRuleEvidence> = null;
    let ruleEvidenceProblem: string | null = null;
    if (binding !== null) {
      try {
        snapshot = readBoundRuleEvidence(taskId, app.taskRuleEvidence);
      } catch (error) {
        ruleEvidenceProblem = redactAndTruncate(
          error instanceof Error ? error.message : String(error),
          2_000
        );
      }
    }
    const gate = app.planReviewGates.findByTask(taskId);
    return {
      ruleEvidenceProblem,
      gateIdentity: planReviewGateIdentity({ task, gate, ruleEvidence: app.taskRuleEvidence }),
      ruleEvidence: binding === null || snapshot === null ? null : {
        snapshotSha256: binding.snapshotSha256,
        boundAt: binding.boundAt,
        sources: snapshot.sources,
        files: snapshot.files.map(({ sourceId, path, bytes, sha256 }) => ({
          sourceId, path, bytes, sha256
        })),
        omitted: snapshot.omitted,
        totalBytes: snapshot.totalBytes
      },
      gate,
      findings: gate === null ? [] : parsePlanReviewFindings(gate.findingsJson)
    };
  };

  return {
    'settings:get': () => app.settings.get(),
    'settings:update': (input) => app.settings.update(input),

    'diagnostics:run': (input) => app.diagnostics.run(input.force ?? false),

    // Never rejects: an unreachable catalogue comes back as available:false,
    // so a missing or broken Codex cannot stop the task form from working.
    'codex:listModels': (input) => app.codexModels.list({ refresh: input.refresh ?? false }),

    'dialog:pickDirectory': async (input) => {
      const window = getWindow();
      const options = {
        title: input.title ?? 'Choose a folder',
        defaultPath: input.defaultPath,
        properties: ['openDirectory' as const, 'createDirectory' as const]
      };
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);

      return result.canceled ? null : (result.filePaths[0] ?? null);
    },

    'projects:list': () => app.projectService.list(),
    'projects:validatePath': (input) => app.projectService.validatePath(input.localPath),
    'projects:addExisting': (input) => app.projectService.addExisting(input),
    'projects:createNew': (input) => app.projectService.createNew(input),
    'projects:initGit': (input) => app.projectService.initGit(input.projectId),
    'projects:update': (input) => app.projectService.update(input.projectId, input),
    'projects:forget': (input) => {
      app.projectService.forget(input.projectId);
      return { removed: true as const };
    },

    'tasks:list': (input) => app.taskService.listByProject(input.projectId),
    'tasks:get': (input) => app.taskService.detail(input.taskId),
    'tasks:create': (input) => app.taskService.create(input),

    'runs:listByTask': (input) => app.runs.listByTask(input.taskId),
    'runs:events': (input) =>
      app.runEvents.listByRun(input.runId, {
        ...(input.afterId === undefined ? {} : { afterId: input.afterId }),
        ...(input.limit === undefined ? {} : { limit: input.limit })
      }),

    'workflow:generateSpecification': (input) =>
      app.orchestrator.generateSpecification(input.taskId),
    'workflow:approveSpecification': (input) => app.orchestrator.approveSpecification(input.taskId),
    'workflow:sendToClaude': (input) =>
      app.orchestrator.sendToClaude(input.taskId, {
        acceptDirtyWorkingTree: input.acceptDirtyWorkingTree ?? false
      }),
    'workflow:reviewWithCodex': (input) => app.orchestrator.reviewWithCodex(input.taskId),
    'workflow:sendCorrections': (input) => app.orchestrator.sendCorrections(input.taskId),
    'workflow:stop': (input) => app.orchestrator.stop(input.taskId),
    'workflow:approveForPublishing': (input) => app.orchestrator.approveForPublishing(input.taskId),

    'planReview:get': (input) => planReviewDetail(input.taskId),
    'planReview:bindRules': async (input) => {
      const settings = app.settings.get();
      const service = planReviewService();
      const task = app.tasks.findById(input.taskId);
      if (task === null) throw new AgentRelayError('NOT_FOUND', 'No such task.');
      const project = app.projects.findById(task.projectId);
      if (project === null) throw new AgentRelayError('NOT_FOUND', 'No such project.');
      const snapshot = await app.ruleEvidenceCollector.capture({
        sources: configuredRuleSources(settings, project.localPath),
        limits: TASK_RULE_EVIDENCE_LIMITS
      });
      service.bindRules(task.id, snapshot);
      return planReviewDetail(task.id);
    },
    'planReview:prepare': async (input) => {
      const service = planReviewService();
      // Read-only, and first: preparing creates a branch and a worktree, and a
      // gate that turns out to be impossible afterwards would leave the task
      // holding review infrastructure it can never use. Rule evidence binds
      // only in DRAFT, so by then the obvious repair is already closed.
      service.assertPreparable(input.taskId);
      await app.orchestrator.preparePlanReviewWorktree(input.taskId, {
        acceptDirtyWorkingTree: input.acceptDirtyWorkingTree ?? false
      });
      service.prepare(input.taskId);
      return planReviewDetail(input.taskId);
    },
    'planReview:review': async (input) => {
      await planReviewService().review(input.taskId);
      return planReviewDetail(input.taskId);
    },
    'planReview:reconcile': async (input) => {
      await planReviewService().reconcile(input.taskId);
      return planReviewDetail(input.taskId);
    },
    /**
     * Code review (INT-D-A).
     *
     * The detail is assembled here, in the main process, because the two
     * questions a screen needs answered — "does this review still describe the
     * code?" and "which findings are live?" — are both content-hash comparisons
     * against the working tree. Neither is a rendering decision, and neither
     * may be recomputed on the other side of this boundary.
     */
    'codeReview:get': (input) => codeReviewDetail(input.taskId),
    'codeReview:capture': async (input) => {
      await app.codeReview.captureSubject(input.taskId);
      return codeReviewDetail(input.taskId);
    },
    'codeReview:review': async (input) => {
      // Everything the provider is asked, and everything it is asked WITH, is
      // resolved here from durable state and trusted settings: the task, its
      // project, its worktree, the scope built from the stored subject, and the
      // MCP configuration. The renderer named a task.
      await app.codeReview.review(input.taskId);
      return codeReviewDetail(input.taskId);
    },
    'codeReview:reconcile': async (input) => {
      // Operator-reachable, and read-only towards the provider: it asks what
      // happened to a dispatched round, and never starts one.
      await app.codeReview.reconcile(input.taskId);
      return codeReviewDetail(input.taskId);
    },
    'codeReview:decide': async (input) => {
      await app.codeReview.decide(input.taskId, {
        findingId: input.findingId,
        action: input.action,
        reason: input.reason,
        expectedRevision: input.expectedRevision,
        actor: 'operator',
        // Where the answer entered the system. A channel name, never a path.
        source: 'codeReview:decide'
      });
      return codeReviewDetail(input.taskId);
    },

    'planReview:resolve': async (input) => {
      await planReviewService().resolve(input.taskId, {
        gateId: input.gateId,
        expectedRevision: input.expectedRevision,
        decisions: input.decisions
      });
      return planReviewDetail(input.taskId);
    },

    'git:changes': (input) => app.orchestrator.collectChanges(input.taskId),
    'git:repositoryInfo': async (input) => {
      const project = app.projects.findById(input.projectId);
      if (!project) throw new AgentRelayError('NOT_FOUND', 'No such project.');
      const validation = await app.projectService.validatePath(project.localPath);
      if (!validation.repository) {
        throw new AgentRelayError('GIT_FAILED', 'Could not read that repository.');
      }
      return validation.repository;
    },

    'publish:prepare': (input) => app.publishService.prepare(input),
    'publish:execute': (input) => app.publishService.execute(input),

    /* ---------------------------------------------------------------------- */
    /* Operations — read-only                                                  */
    /* ---------------------------------------------------------------------- */

    'operations:listTargets': () => app.operations.list(),
    'operations:getTarget': (input) => app.operations.get(input.targetId),
    'operations:createTarget': (input) => app.operations.create(input),
    'operations:updateTarget': (input) => app.operations.update(input.targetId, input.patch),
    'operations:deleteTarget': (input) => app.operations.delete(input.targetId),
    'operations:listDiagnostics': (input) =>
      app.operations.listDiagnostics(input.targetId, input.limit),
    // The probe id is already an enum by the time it arrives; the service checks
    // it again against the same enum before a target is even loaded.
    'operations:runDiagnostic': (input) =>
      app.operationDiagnostics.run({
        targetId: input.targetId,
        probeId: input.probeId,
        ...(input.options ? { options: input.options } : {})
      }),

    'shell:openExternal': async (input) => {
      let url: URL;
      try {
        url = new URL(input.url);
      } catch {
        throw new AgentRelayError('VALIDATION_FAILED', 'That is not a valid URL.');
      }
      if (url.protocol !== 'https:') {
        throw new AgentRelayError('VALIDATION_FAILED', 'Only https links can be opened.');
      }
      if (!ALLOWED_EXTERNAL_HOSTS.has(url.hostname.toLowerCase())) {
        throw new AgentRelayError(
          'VALIDATION_FAILED',
          `Agent Relay will not open links to ${url.hostname}.`
        );
      }
      await shell.openExternal(url.toString());
      return { opened: true };
    },

    'shell:revealPath': async (input) => {
      // Only paths Agent Relay itself manages may be revealed.
      assertKnownPath(input.path, knownRoots());
      const error = await shell.openPath(input.path);
      if (error) {
        throw new AgentRelayError('INTERNAL', `The shell could not open that path: ${error}`);
      }
      return { opened: true };
    }
  };
}

export function registerIpc(context: IpcContext): void {
  const handlers = buildHandlers(context);

  ipcMain.handle(
    IPC_INVOKE_CHANNEL,
    async (_event, payload: unknown): Promise<IpcResult<unknown>> => {
      try {
        if (typeof payload !== 'object' || payload === null) {
          throw new AgentRelayError('VALIDATION_FAILED', 'Malformed IPC payload.');
        }

        const { channel, input } = payload as { channel?: unknown; input?: unknown };

        if (!isIpcChannel(channel)) {
          throw new AgentRelayError('VALIDATION_FAILED', `Unknown operation: ${String(channel)}`);
        }

        const parsed = ipcInputSchemas[channel].safeParse(input ?? {});
        if (!parsed.success) {
          throw new AgentRelayError('VALIDATION_FAILED', `Invalid input for "${channel}".`, {
            details: parsed.error.issues
              .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
              .join('; ')
          });
        }

        // The table is keyed by the same union the schema map is, so this cast is
        // safe by construction; TypeScript cannot narrow both sides together.
        const handler = handlers[channel] as (value: unknown) => Promise<unknown> | unknown;
        const data = await handler(parsed.data);

        return { ok: true, data };
      } catch (error) {
        return { ok: false, error: toSerializedError(error) };
      }
    }
  );
}

export function unregisterIpc(): void {
  ipcMain.removeHandler(IPC_INVOKE_CHANNEL);
}
