import { AgentRelayError } from '../../shared/domain/errors';
import type { Task } from '../../shared/domain/models';
import type { TaskDetail } from '../../shared/ipc';
import { codexReviewResultSchema, taskSpecificationSchema } from '../../shared/schemas/codex';
import type {
  ApprovalRepository,
  Clock,
  EventPublisher,
  IdGenerator,
  ProjectRepository,
  RunRepository,
  SettingsRepository,
  TaskRepository
} from '../ports';

export interface CreateTaskInput {
  readonly projectId: string;
  readonly title: string;
  readonly originalRequest: string;
  readonly maxRounds?: number;
  /**
   * Model selection is deliberately three-state, and the three states are not
   * interchangeable:
   *
   *   `undefined` — field omitted: inherit the current Settings default.
   *   `null`      — explicitly "Tool default": store no override, even when a
   *                 Settings default exists.
   *   `string`    — this exact model.
   *
   * This is why the code below tests `=== undefined` rather than using `??`,
   * which would silently turn an explicit `null` into the Settings default and
   * make "Tool default" unselectable whenever a default was configured.
   */
  readonly codexModel?: string | null;
  readonly claudeModel?: string | null;
}

export interface TaskServiceDeps {
  readonly tasks: TaskRepository;
  readonly projects: ProjectRepository;
  readonly runs: RunRepository;
  readonly approvals: ApprovalRepository;
  readonly settings: SettingsRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly events: EventPublisher;
}

export class TaskService {
  constructor(private readonly deps: TaskServiceDeps) {}

  listByProject(projectId: string): Task[] {
    return this.deps.tasks.listByProject(projectId);
  }

  create(input: CreateTaskInput): Task {
    const project = this.deps.projects.findById(input.projectId);
    if (!project) {
      throw new AgentRelayError('NOT_FOUND', `No project with id ${input.projectId}.`);
    }

    const settings = this.deps.settings.get();

    // Snapshot, not a reference: from here on this task's models are fixed, and
    // later Settings edits cannot reach it.
    const codexModel = input.codexModel === undefined ? settings.codexModel : input.codexModel;
    const claudeModel = input.claudeModel === undefined ? settings.claudeModel : input.claudeModel;

    const requested = input.maxRounds ?? settings.maxReviewRounds;
    // Settings define the ceiling; a task may ask for fewer rounds but not more.
    const maxRounds = Math.min(Math.max(1, requested), settings.maxReviewRounds);

    const task = this.deps.tasks.create({
      id: this.deps.ids.next(),
      projectId: project.id,
      title: input.title.trim(),
      originalRequest: input.originalRequest.trim(),
      status: 'DRAFT',
      currentRound: 0,
      maxRounds,
      codexThreadId: null,
      claudeSessionId: null,
      worktreePath: null,
      branchName: null,
      baseBranch: null,
      specificationJson: null,
      specificationApprovedAt: null,
      lastReviewJson: null,
      lastError: null,
      codexModel,
      claudeModel
    });

    this.deps.events.publishTask(task);
    return task;
  }

  /**
   * Everything the Run screen needs in one call: the task, its project, all runs,
   * the approval trail, and the parsed specification/review.
   *
   * Stored JSON is parsed leniently — a task whose specification predates a
   * schema change should still open, just without that panel.
   */
  detail(taskId: string): TaskDetail {
    const task = this.deps.tasks.findById(taskId);
    if (!task) throw new AgentRelayError('NOT_FOUND', `No task with id ${taskId}.`);

    const project = this.deps.projects.findById(task.projectId);
    if (!project) throw new AgentRelayError('NOT_FOUND', `No project with id ${task.projectId}.`);

    return {
      task,
      project,
      runs: this.deps.runs.listByTask(taskId),
      approvals: this.deps.approvals.listByTask(taskId),
      specification: parseJson(task.specificationJson, taskSpecificationSchema),
      lastReview: parseJson(task.lastReviewJson, codexReviewResultSchema),
      worktree: task.worktreePath
        ? {
            path: task.worktreePath,
            branch: task.branchName,
            head: null,
            isLocked: false
          }
        : null
    };
  }
}

function parseJson<T>(raw: string | null, schema: { safeParse(value: unknown): { success: boolean; data?: T } }): T | null {
  if (!raw) return null;
  try {
    const result = schema.safeParse(JSON.parse(raw));
    return result.success && result.data !== undefined ? result.data : null;
  } catch {
    return null;
  }
}
