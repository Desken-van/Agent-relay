/**
 * The recovery, end to end through the composition root and the IPC boundary.
 *
 * A real container, a real Git repository and the real IPC handler table — only Electron's
 * `ipcMain` is replaced, so a request goes through the same schema validation, handler and
 * error serialisation the renderer's does. What is asserted is what a person or a bypassed
 * renderer could actually do: read the state, try to start implementation, and recover a
 * gate an earlier build left stuck — without anyone editing the database.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = vi.hoisted(() => ({ invoke: null as null | ((event: unknown, payload: unknown) => Promise<unknown>) }));
vi.mock('electron/main', () => ({
  dialog: {},
  ipcMain: {
    handle: (_channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.invoke = handler;
    },
    removeHandler: () => undefined
  }
}));
vi.mock('electron/common', () => ({ shell: {} }));

import { buildApplication, type Application } from '../../src/main/container';
import { registerIpc } from '../../src/main/ipc/register-ipc';
import type { ExternalMcpServerConfig } from '../../src/main/ports';
import { InMemoryEventPublisher } from '../../src/main/services/event-bus';
import { specificationIdentity } from '../../src/main/services/specification-identity';
import type { IpcChannel, IpcResult } from '../../src/shared/ipc';
import { IPC_INVOKE_CHANNEL } from '../../src/shared/ipc-channels';
import { RecordingConfirmationService, makeSpecification } from '../helpers/fakes';
import { snapshot } from '../helpers/fake-plan-reviewer';

void IPC_INVOKE_CHANNEL;

const CONFIG: ExternalMcpServerConfig = {
  id: 'coai',
  enabled: true,
  // Never launched: nothing below reaches the provider.
  executablePath: 'C:\\tools\\never-started.exe',
  args: [],
  allowedTools: ['open', 'status', 'review_plan', 'resolve'],
  timeoutMs: 30_000,
  maxMessageBytes: 1_000_000,
  maxContentBytes: 1_000_000,
  maxContentBlocks: 16
};

const roots: string[] = [];
const applications: Application[] = [];

afterEach(() => {
  for (const app of applications.splice(0)) app.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  handlers.invoke = null;
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

/** A repository with the task's branch, and an application whose project points at it. */
function world() {
  const root = mkdtempSync(join(tmpdir(), 'agent-relay-recovery-'));
  roots.push(root);
  const repository = join(root, 'repository');
  mkdirSync(repository, { recursive: true });
  git(repository, 'init', '--initial-branch', 'main');
  git(repository, 'config', 'user.email', 'test@example.invalid');
  git(repository, 'config', 'user.name', 'Agent Relay Test');
  git(repository, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repository, 'kept.txt'), 'base\n');
  git(repository, 'add', 'kept.txt');
  git(repository, 'commit', '-m', 'base');
  git(repository, 'branch', 'agent/task');

  const app = buildApplication({
    paths: { dataDir: root, documentsDir: root },
    databaseFile: ':memory:',
    events: new InMemoryEventPublisher(),
    confirmation: new RecordingConfirmationService(false)
  });
  applications.push(app);
  registerIpc({ app, getWindow: () => null });

  const project = app.projects.create({
    id: 'project-1',
    name: 'Demo',
    localPath: repository,
    projectType: 'existing',
    defaultBranch: 'main',
    githubOwner: 'Desken-van',
    githubRepo: 'demo',
    githubVisibility: 'private'
  });
  const corrected = JSON.stringify(makeSpecification({ summary: 'The corrected plan.' }));
  const first = JSON.stringify(makeSpecification({ summary: 'The first plan.' }));
  const task = app.tasks.create({
    id: 'task-1',
    projectId: project.id,
    title: 'Add health endpoint',
    originalRequest: 'Please add a health endpoint.',
    status: 'READY_FOR_IMPLEMENTATION',
    currentRound: 0,
    maxRounds: 3,
    codexThreadId: null,
    claudeSessionId: null,
    codexModel: null,
    claudeModel: null,
    worktreePath: null,
    branchName: 'agent/task',
    baseBranch: 'main',
    specificationJson: corrected,
    specificationApprovedAt: null,
    lastReviewJson: null,
    lastError: null
  });
  const rules = snapshot();
  app.taskRuleEvidence.create({
    taskId: task.id,
    snapshotSha256: rules.sha256,
    snapshotJson: JSON.stringify(rules),
    boundAt: '2026-09-19T00:00:00.000Z'
  });
  const base = {
    taskId: task.id,
    ruleEvidenceSha256: rules.sha256,
    serverName: 'coai-mcp',
    serverVersion: '1.2.3',
    contractFingerprint: null,
    contractMismatchAt: null,
    verdict: null,
    findingsJson: null,
    decisionsJson: null,
    reviewers: null,
    gatingCount: null,
    threshold: null,
    reconciledAt: null,
    triageJson: null,
    triageForFindings: null,
    autoDecisionsJson: null,
    reviewSubject: null,
    roundsAtOpen: null,
    failureKind: null,
    supersededBy: null
  } as const;
  // The state the defect left: the first gate resolved and proceeded; the corrected gate holds its session.
  app.planReviewGates.create({
    ...base,
    id: 'gate-1',
    specificationSha256: specificationIdentity(first).sha256,
    sessionId: 'session-1',
    status: 'proceeded',
    verdict: 'revise',
    findingsJson: '[]',
    decisionsJson: '[{"finding":0,"action":"accept","reason":"Yes."}]',
    reviewers: 'all 2 reviewers answered',
    gatingCount: 1,
    threshold: 1,
    lastError: null
  });
  app.planReviewGates.create({
    ...base,
    id: 'gate-2',
    specificationSha256: specificationIdentity(corrected).sha256,
    sessionId: 'session-1',
    status: 'reviewing',
    lastError:
      'Coai refused the request: the plan stage is over for this session (stage: CodeReview); open a new session for a new plan'
  });
  return { app, task, repository, correctedSha: specificationIdentity(corrected).sha256, corrected };
}

async function ipc<C extends IpcChannel>(channel: C, input: Record<string, unknown>): Promise<IpcResult<unknown>> {
  if (handlers.invoke === null) throw new Error('The IPC handler was not registered.');
  return (await handlers.invoke({}, { channel, input })) as IpcResult<unknown>;
}

beforeEach(() => {
  handlers.invoke = null;
});

describe('a gate an earlier build left stuck, through the IPC boundary', () => {
  it('is reported as unable to count — not as an outcome to reconcile — and the plan as unreviewed', async () => {
    const { task } = world();

    const result = await ipc('planReview:get', { taskId: task.id });

    expect(result.ok).toBe(true);
    const detail = (result as { ok: true; data: Record<string, any> }).data;
    expect(detail.gate).toMatchObject({ id: 'gate-2', status: 'reviewing', supersededBy: null });
    expect(detail.recovery).toMatchObject({ reason: 'foreign_session' });
    expect(detail.recovery.message).toMatch(/fresh review session/);
    // The loop's own derivation agrees: the next step is recovery, not a read-back of another review.
    expect(detail.correction.nextStep).toBe('recover_review');
    expect(detail.gateIdentity).toBe('current');
  });

  it('cannot start implementation whatever the renderer does — unapproved, or approved on evidence that is not the plan’s', async () => {
    const { app, task } = world();

    const unapproved = await ipc('workflow:implement', { taskId: task.id });
    expect(unapproved).toMatchObject({ ok: false, error: { code: 'APPROVAL_REQUIRED' } });

    // An approval on record does not help: it rests on a review that is not of this plan.
    app.tasks.update(task.id, { specificationApprovedAt: '2026-09-20T00:00:00.000Z' });
    const approved = await ipc('workflow:implement', { taskId: task.id });
    expect(approved).toMatchObject({ ok: false, error: { code: 'APPROVAL_REQUIRED' } });
    expect(app.runs.listByTask(task.id)).toEqual([]);
    expect(app.tasks.findById(task.id)?.status).toBe('READY_FOR_IMPLEMENTATION');
  });

  it('is recovered by the application itself — a real isolated subject, the failed attempt kept, nothing started', async () => {
    const { app, task, repository, correctedSha, corrected } = world();
    const refsBefore = git(repository, 'for-each-ref');
    app.tasks.update(task.id, { specificationApprovedAt: '2026-09-20T00:00:00.000Z' });

    const fresh = await app.createPlanReviewGate(CONFIG).retryInFreshSession(task.id);

    // A commit that exists in the repository and that no ref reaches.
    expect(fresh.reviewSubject).toMatch(/^[0-9a-f]{40}$/);
    expect(git(repository, 'cat-file', '-t', fresh.reviewSubject as string).trim()).toBe('commit');
    expect(git(repository, 'for-each-ref', '--contains', fresh.reviewSubject as string).trim()).toBe('');
    expect(git(repository, 'for-each-ref')).toBe(refsBefore);
    expect(git(repository, 'rev-parse', 'agent/task')).toBe(git(repository, 'rev-parse', `${fresh.reviewSubject}^`));
    // The corrected specification and its hash are exactly what they were.
    expect(app.tasks.findById(task.id)?.specificationJson).toBe(corrected);
    expect(fresh.specificationSha256).toBe(correctedSha);
    expect(fresh).toMatchObject({ status: 'prepared', sessionId: null, failureKind: null });
    // The stuck attempt stays on record, replaced but unaltered.
    expect(app.planReviewGates.findById('gate-2')).toMatchObject({
      status: 'reviewing',
      sessionId: 'session-1',
      supersededBy: fresh.id
    });
    // Nothing was approved or started: the approval that rested on the discarded evidence is withdrawn.
    expect(app.tasks.findById(task.id)?.specificationApprovedAt).toBeNull();
    expect(app.runs.listByTask(task.id)).toEqual([]);
    expect(app.tasks.findById(task.id)?.status).toBe('READY_FOR_IMPLEMENTATION');

    // The screen now says the plan is ready to be reviewed, not that it needs recovery.
    const detail = (await ipc('planReview:get', { taskId: task.id })) as { ok: true; data: Record<string, any> };
    expect(detail.data.recovery).toBeNull();
    expect(detail.data.correction.nextStep).toBe('run_review');
    expect(detail.data.gate.id).toBe(fresh.id);
    // And implementation is still refused until a review of THIS specification passes.
    expect(await ipc('workflow:implement', { taskId: task.id })).toMatchObject({ ok: false, error: { code: 'APPROVAL_REQUIRED' } });
  });

  it('recovers through the IPC channel by replacing the attempt ONLY: no review is dispatched, and the next action is the ordinary one', async () => {
    const { app, task } = world();
    // External plan review is enabled, and pointed at an executable that does not exist: any attempt to
    // reach the provider would fail loudly, so a chained review cannot go unnoticed.
    app.settings.update({ externalPlanReviewEnabled: true, coaiMcpExecutablePath: 'C:\\tools\\never-started.exe' });

    const result = await ipc('planReview:retryFreshSession', { taskId: task.id });

    expect(result).toMatchObject({ ok: true });
    const detail = (result as { ok: true; data: Record<string, any> }).data;
    // The replacement is an ordinary current `prepared` gate: nothing was opened, sent or recorded.
    expect(detail.gate).toMatchObject({ status: 'prepared', sessionId: null, failureKind: null, lastError: null });
    expect(detail.recovery).toBeNull();
    expect(detail.correction.nextStep).toBe('run_review');
    expect(app.planReviewGates.findById('gate-2')).toMatchObject({ supersededBy: detail.gate.id });
    expect(app.tasks.findById(task.id)?.status).toBe('READY_FOR_IMPLEMENTATION');
    expect(app.runs.listByTask(task.id)).toEqual([]);
  });

  it('refuses the retry channel when there is nothing to recover, without touching the repository', async () => {
    const { app, task, repository } = world();
    app.planReviewGates.update('gate-2', { status: 'awaiting_resolve', sessionId: 'session-2', verdict: 'revise', findingsJson: '[]', gatingCount: 0, threshold: 1 });
    const refsBefore = git(repository, 'count-objects', '-v');

    await expect(app.createPlanReviewGate(CONFIG).retryInFreshSession(task.id)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    expect(app.planReviewGates.listByTask(task.id)).toHaveLength(2);
    expect(git(repository, 'count-objects', '-v')).toBe(refsBefore);
  });
});
