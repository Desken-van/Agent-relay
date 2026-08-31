import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness';
import { makeReview } from '../helpers/fakes';

let harness: Harness;

afterEach(() => {
  harness.dispose();
});

/* -------------------------------------------------------------------------- */
/* Snapshot at creation — the three-state rule                                 */
/* -------------------------------------------------------------------------- */

describe('model snapshot when a task is created', () => {
  beforeEach(() => {
    harness = createHarness({ settings: { codexModel: 'gpt-5.6-sol', claudeModel: 'opus' } });
  });

  it('inherits the Settings defaults when the fields are omitted', () => {
    const project = harness.createProject();
    const task = harness.taskService.create({
      projectId: project.id,
      title: 'T',
      originalRequest: 'r'
    });

    expect(task.codexModel).toBe('gpt-5.6-sol');
    expect(task.claudeModel).toBe('opus');
  });

  it('takes an explicit choice over the defaults', () => {
    const project = harness.createProject();
    const task = harness.taskService.create({
      projectId: project.id,
      title: 'T',
      originalRequest: 'r',
      codexModel: 'gpt-5.4-mini',
      claudeModel: 'fable'
    });

    expect(task.codexModel).toBe('gpt-5.4-mini');
    expect(task.claudeModel).toBe('fable');
  });

  it('honours an explicit null even when a non-empty default exists', () => {
    // The regression this guards: `input.codexModel ?? settings.codexModel`
    // would turn this null back into 'gpt-5.6-sol' and make "Tool default"
    // impossible to choose whenever a default was configured.
    const project = harness.createProject();
    const task = harness.taskService.create({
      projectId: project.id,
      title: 'T',
      originalRequest: 'r',
      codexModel: null,
      claudeModel: null
    });

    expect(task.codexModel).toBeNull();
    expect(task.claudeModel).toBeNull();
  });

  it('treats the two fields independently', () => {
    const project = harness.createProject();
    const task = harness.taskService.create({
      projectId: project.id,
      title: 'T',
      originalRequest: 'r',
      codexModel: null
    });

    expect(task.codexModel).toBeNull();
    expect(task.claudeModel).toBe('opus');
  });

  it('is a snapshot: later Settings changes do not reach an existing task', () => {
    const project = harness.createProject();
    const task = harness.taskService.create({
      projectId: project.id,
      title: 'T',
      originalRequest: 'r'
    });

    harness.settings.update({ codexModel: 'gpt-5.4', claudeModel: 'haiku' });

    const reloaded = harness.tasks.findById(task.id);
    expect(reloaded?.codexModel).toBe('gpt-5.6-sol');
    expect(reloaded?.claudeModel).toBe('opus');
  });
});

describe('model snapshot with no Settings defaults', () => {
  beforeEach(() => {
    harness = createHarness();
  });

  it('stores null when nothing is configured and nothing is chosen', () => {
    const project = harness.createProject();
    const task = harness.taskService.create({
      projectId: project.id,
      title: 'T',
      originalRequest: 'r'
    });

    expect(task.codexModel).toBeNull();
    expect(task.claudeModel).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* The models reach the adapters, from the task and not from Settings          */
/* -------------------------------------------------------------------------- */

describe('runtime wiring', () => {
  beforeEach(() => {
    harness = createHarness();
  });

  it('sends the task Codex model to specification and to review', async () => {
    const project = harness.createProject();
    const task = harness.createTask(project.id, { codexModel: 'gpt-5.6-terra' });

    await harness.orchestrator.generateSpecification(task.id);
    expect(harness.codex.specificationCalls.at(-1)?.model).toBe('gpt-5.6-terra');

    await harness.orchestrator.approveSpecification(task.id);
    await harness.orchestrator.sendToClaude(task.id);
    await harness.orchestrator.reviewWithCodex(task.id);

    expect(harness.codex.reviewCalls.at(-1)?.model).toBe('gpt-5.6-terra');
  });

  it('sends the same Codex model when the specification is regenerated', async () => {
    const project = harness.createProject();
    const task = harness.createTask(project.id, { codexModel: 'gpt-5.5' });

    await harness.orchestrator.generateSpecification(task.id);
    await harness.orchestrator.generateSpecification(task.id);

    const calls = harness.codex.specificationCalls;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.model).toBe('gpt-5.5');
    expect(calls[1]?.model).toBe('gpt-5.5');
    // Same thread, same model: a regeneration must not switch either.
    expect(calls[1]?.threadId).toBe('codex-thread-1');
  });

  it('sends the task Claude model to the implementation and to corrections', async () => {
    const project = harness.createProject();
    const task = harness.createTask(project.id, { claudeModel: 'opus' });

    await harness.orchestrator.generateSpecification(task.id);
    await harness.orchestrator.approveSpecification(task.id);
    await harness.orchestrator.sendToClaude(task.id);

    expect(harness.claude.calls.at(-1)?.model).toBe('opus');
    expect(harness.claude.calls.at(-1)?.sessionId).toBeNull();

    harness.codex.reviewQueue.push(makeReview({ verdict: 'changes_requested' }));
    await harness.orchestrator.reviewWithCodex(task.id);
    await harness.orchestrator.sendCorrections(task.id);

    const correction = harness.claude.calls.at(-1);
    expect(correction?.model).toBe('opus');
    // Resumed session and unchanged model travel together.
    expect(correction?.sessionId).toBe('claude-session-1');
  });

  it('passes null through untouched when the task has no override', async () => {
    const project = harness.createProject();
    const task = harness.createTask(project.id);

    await harness.orchestrator.generateSpecification(task.id);
    await harness.orchestrator.approveSpecification(task.id);
    await harness.orchestrator.sendToClaude(task.id);

    expect(harness.codex.specificationCalls.at(-1)?.model).toBeNull();
    expect(harness.claude.calls.at(-1)?.model).toBeNull();
  });

  it('ignores a Settings change made after the task was created', async () => {
    const project = harness.createProject();
    const task = harness.createTask(project.id, { codexModel: 'gpt-5.5', claudeModel: 'sonnet' });

    harness.settings.update({ codexModel: 'gpt-5.4', claudeModel: 'haiku' });

    await harness.orchestrator.generateSpecification(task.id);
    await harness.orchestrator.approveSpecification(task.id);
    await harness.orchestrator.sendToClaude(task.id);

    expect(harness.codex.specificationCalls.at(-1)?.model).toBe('gpt-5.5');
    expect(harness.claude.calls.at(-1)?.model).toBe('sonnet');
  });
});
