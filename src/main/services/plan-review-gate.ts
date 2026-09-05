/** Optional, durable external plan-review gate. */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AgentRelayError } from '../../shared/domain/errors';
import type { Task } from '../../shared/domain/models';
import {
  parsePlanReviewFindings,
  planReviewDecisionSchema,
  taskRuleEvidenceBindingSchema,
  type PlanReviewDecision,
  type PlanReviewGate
} from '../../shared/domain/plan-review';
import type { RuleEvidenceSnapshot } from '../../shared/domain/rule-evidence';
import { containsSecretShape, redactAndTruncate } from '../../shared/util/redact';
import { taskSpecificationSchema, type TaskSpecification } from '../../shared/schemas/codex';
import type {
  Clock,
  ExternalPlanReviewer,
  ExternalPlanReviewSubject,
  IdGenerator,
  PlanReviewGateRepository,
  ProjectRepository,
  TaskRepository,
  TaskRuleEvidenceRepository
} from '../ports';
import { renderRuleEvidence, validateRuleEvidenceSnapshot } from './rule-evidence';

const MAX_PLAN_BYTES = 1_500_000;

export interface PlanReviewGateDeps {
  readonly tasks: TaskRepository;
  readonly projects: ProjectRepository;
  readonly ruleEvidence: TaskRuleEvidenceRepository;
  readonly gates: PlanReviewGateRepository;
  readonly reviewer: ExternalPlanReviewer;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function specificationIdentity(raw: string | null): {
  specification: TaskSpecification;
  canonical: string;
  sha256: string;
} {
  if (raw === null) {
    throw new AgentRelayError('VALIDATION_FAILED', 'This task has no specification to review.');
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new AgentRelayError('PARSE_FAILED', 'The stored specification is not valid JSON.', {
      cause: error
    });
  }
  const specification = taskSpecificationSchema.parse(value);
  const canonical = JSON.stringify(specification);
  return { specification, canonical, sha256: hash(canonical) };
}

export function readBoundRuleEvidence(
  taskId: string,
  repository: TaskRuleEvidenceRepository
): RuleEvidenceSnapshot | null {
  const binding = repository.findByTask(taskId);
  if (binding === null) return null;
  const parsedBinding = taskRuleEvidenceBindingSchema.parse(binding);
  let value: unknown;
  try {
    value = JSON.parse(parsedBinding.snapshotJson);
  } catch (error) {
    throw new AgentRelayError('PARSE_FAILED', 'The stored rule evidence is not valid JSON.', {
      cause: error
    });
  }
  const snapshot = validateRuleEvidenceSnapshot(value);
  if (snapshot.sha256 !== parsedBinding.snapshotSha256) {
    throw new AgentRelayError('PARSE_FAILED', 'The stored rule-evidence binding does not match its snapshot.');
  }
  return snapshot;
}

export function assertPlanReviewAllowsApproval(input: {
  readonly task: Task;
  readonly ruleEvidence: TaskRuleEvidenceRepository;
  readonly gates: PlanReviewGateRepository;
}): void {
  const snapshot = readBoundRuleEvidence(input.task.id, input.ruleEvidence);
  if (snapshot === null) return;
  const gate = input.gates.findByTask(input.task.id);
  const specification = specificationIdentity(input.task.specificationJson);
  if (
    gate === null ||
    gate.status !== 'proceeded' ||
    gate.specificationSha256 !== specification.sha256 ||
    gate.ruleEvidenceSha256 !== snapshot.sha256
  ) {
    throw new AgentRelayError(
      'APPROVAL_REQUIRED',
      'The specification is bound to rule evidence and has not passed its external plan review.',
      { remediation: 'Complete the plan review and resolve every finding before approving the specification.' }
    );
  }
}

function planText(specification: TaskSpecification, snapshot: RuleEvidenceSnapshot): string {
  const text = [
    '## Specification under review',
    JSON.stringify(specification),
    '',
    '## Immutable project rule evidence',
    renderRuleEvidence(snapshot)
  ].join('\n');
  if (Buffer.byteLength(text, 'utf8') > MAX_PLAN_BYTES) {
    throw new AgentRelayError('VALIDATION_FAILED', 'The plan and rule evidence exceed the external review budget.');
  }
  if (containsSecretShape(text)) {
    throw new AgentRelayError(
      'VALIDATION_FAILED',
      'The plan or rule evidence contains credential-shaped text and cannot be sent to an external reviewer.'
    );
  }
  return text;
}

function subject(task: Task, repositoryPath: string): ExternalPlanReviewSubject {
  if (task.branchName === null) {
    throw new AgentRelayError(
      'WORKTREE_INVALID',
      'A unique task branch must exist before opening an external review session.'
    );
  }
  return { repositoryPath, branch: task.branchName };
}

export class PlanReviewGateService {
  constructor(private readonly deps: PlanReviewGateDeps) {}

  bindRules(taskId: string, snapshotValue: unknown): ReturnType<TaskRuleEvidenceRepository['create']> {
    const task = this.deps.tasks.findById(taskId);
    if (task === null) {
      throw new AgentRelayError('NOT_FOUND', `No task with id ${taskId}.`);
    }
    if (task.status !== 'DRAFT') {
      throw new AgentRelayError(
        'INVALID_TRANSITION',
        'Rule evidence must be bound before specification generation starts.'
      );
    }
    const snapshot = validateRuleEvidenceSnapshot(snapshotValue);
    const existing = this.deps.ruleEvidence.findByTask(taskId);
    if (existing !== null) {
      if (existing.snapshotSha256 === snapshot.sha256) return existing;
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        'Rule evidence is immutable once bound to a task.'
      );
    }
    return this.deps.ruleEvidence.create({
      taskId,
      snapshotSha256: snapshot.sha256,
      snapshotJson: JSON.stringify(snapshot),
      boundAt: this.deps.clock.nowIso()
    });
  }

  prepare(taskId: string): PlanReviewGate {
    const task = this.requireReadyTask(taskId);
    const snapshot = readBoundRuleEvidence(taskId, this.deps.ruleEvidence);
    if (snapshot === null) {
      throw new AgentRelayError('VALIDATION_FAILED', 'Bind rule evidence before preparing plan review.');
    }
    const specification = specificationIdentity(task.specificationJson);
    const latest = this.deps.gates.findByTask(taskId);
    if (
      latest !== null &&
      latest.specificationSha256 === specification.sha256 &&
      latest.ruleEvidenceSha256 === snapshot.sha256
    ) {
      return latest;
    }
    return this.deps.gates.create({
      id: this.deps.ids.next(),
      taskId,
      specificationSha256: specification.sha256,
      ruleEvidenceSha256: snapshot.sha256,
      sessionId: null,
      serverName: null,
      serverVersion: null,
      status: 'prepared',
      verdict: null,
      findingsJson: null,
      decisionsJson: null,
      reviewers: null,
      gatingCount: null,
      threshold: null,
      lastError: null
    });
  }

  async review(taskId: string, signal?: AbortSignal): Promise<PlanReviewGate> {
    const task = this.requireReadyTask(taskId);
    const project = this.deps.projects.findById(task.projectId);
    if (project === null) throw new AgentRelayError('NOT_FOUND', `No project with id ${task.projectId}.`);
    const snapshot = readBoundRuleEvidence(taskId, this.deps.ruleEvidence);
    if (snapshot === null) throw new AgentRelayError('VALIDATION_FAILED', 'No rule evidence is bound.');
    const specification = specificationIdentity(task.specificationJson);
    let gate = this.prepare(taskId);
    if (!['prepared', 'changes_requested'].includes(gate.status)) {
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        `Plan review cannot start while its durable status is "${gate.status}".`
      );
    }
    const reviewSubject = subject(task, project.localPath);

    try {
      gate = this.deps.gates.update(gate.id, { status: 'opening', lastError: null });
      const session = await this.deps.reviewer.open(reviewSubject, signal);
      gate = this.deps.gates.update(gate.id, {
        sessionId: session.sessionId,
        serverName: session.serverName,
        serverVersion: session.serverVersion,
        status: 'reviewing'
      });
      const round = await this.deps.reviewer.reviewPlan(
        reviewSubject,
        planText(specification.specification, snapshot),
        signal
      );
      if (containsSecretShape(JSON.stringify(round))) {
        throw new AgentRelayError(
          'PARSE_FAILED',
          'The external reviewer returned credential-shaped text; the round was not persisted.'
        );
      }
      return this.deps.gates.update(gate.id, {
        serverName: round.serverName,
        serverVersion: round.serverVersion,
        status: 'awaiting_resolve',
        verdict: round.verdict,
        findingsJson: JSON.stringify(round.findings),
        decisionsJson: null,
        reviewers: round.reviewers,
        gatingCount: round.gatingCount,
        threshold: round.threshold,
        lastError: null
      });
    } catch (error) {
      this.deps.gates.update(gate.id, {
        status: 'failed',
        lastError: redactAndTruncate(error instanceof Error ? error.message : String(error), 10_000)
      });
      throw error;
    }
  }

  async resolve(
    taskId: string,
    decisionsValue: readonly PlanReviewDecision[],
    signal?: AbortSignal
  ): Promise<PlanReviewGate> {
    const task = this.requireReadyTask(taskId);
    const project = this.deps.projects.findById(task.projectId);
    if (project === null) throw new AgentRelayError('NOT_FOUND', `No project with id ${task.projectId}.`);
    const gate = this.deps.gates.findByTask(taskId);
    if (gate === null || gate.status !== 'awaiting_resolve') {
      throw new AgentRelayError('VALIDATION_FAILED', 'No completed plan-review round awaits resolution.');
    }
    const findings = parsePlanReviewFindings(gate.findingsJson);
    const decisions = z.array(planReviewDecisionSchema).max(256).parse(decisionsValue);
    const decisionsJson = JSON.stringify(decisions);
    if (containsSecretShape(decisionsJson)) {
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        'A plan-review decision contains credential-shaped text and cannot be sent externally.'
      );
    }
    const indexes = decisions.map((decision) => decision.finding).sort((a, b) => a - b);
    if (
      indexes.length !== findings.length ||
      indexes.some((index, position) => index !== position)
    ) {
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        'Resolve requires exactly one decision for every finding index.'
      );
    }

    const resolving = this.deps.gates.update(gate.id, {
      status: 'resolving',
      decisionsJson,
      lastError: null
    });
    try {
      const result = await this.deps.reviewer.resolve(
        subject(task, project.localPath),
        decisions,
        signal
      );
      const status = result.stage === 'CodeReview' && !result.awaitingResolve
        ? 'proceeded'
        : result.stage === 'PlanReview' && !result.awaitingResolve
          ? 'changes_requested'
          : null;
      if (status === null) {
        throw new AgentRelayError(
          'PARSE_FAILED',
          'Coai resolve returned a state that does not close the pending plan round.'
        );
      }
      return this.deps.gates.update(resolving.id, {
        serverName: result.serverName,
        serverVersion: result.serverVersion,
        status,
        lastError: null
      });
    } catch (error) {
      this.deps.gates.update(resolving.id, {
        status: 'failed',
        lastError: redactAndTruncate(error instanceof Error ? error.message : String(error), 10_000)
      });
      throw error;
    }
  }

  private requireReadyTask(taskId: string): Task {
    const task = this.deps.tasks.findById(taskId);
    if (task === null) throw new AgentRelayError('NOT_FOUND', `No task with id ${taskId}.`);
    if (task.status !== 'READY_FOR_IMPLEMENTATION') {
      throw new AgentRelayError(
        'INVALID_TRANSITION',
        'External plan review is available only after specification generation and before implementation.'
      );
    }
    return task;
  }
}
