import { afterEach, describe, expect, it } from 'vitest';
import { SqlitePlanCorrectionRepository } from '../../src/main/db/repositories/plan-correction-repository';
import type { NewPlanReviewGate } from '../../src/main/ports';
import { createHarness, type Harness } from '../helpers/harness';

const harnesses: Harness[] = [];
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.dispose();
});

const SHA = (character: string): string => character.repeat(64);

function setup() {
  const harness = createHarness();
  harnesses.push(harness);
  const corrections = new SqlitePlanCorrectionRepository(harness.db, harness.clock);
  const project = harness.createProject();
  const task = harness.createTask(project.id, { specificationJson: '{"v":"one"}' });
  let counter = 0;
  const gate = (taskId = task.id) => {
    counter += 1;
    const input: NewPlanReviewGate = {
      id: `gate-${counter}`,
      taskId,
      specificationSha256: SHA('a'),
      ruleEvidenceSha256: SHA('b'),
      sessionId: null,
      serverName: null,
      serverVersion: null,
      contractFingerprint: null,
      contractMismatchAt: null,
      status: 'prepared',
      verdict: null,
      findingsJson: null,
      decisionsJson: null,
      reviewers: null,
      gatingCount: null,
      threshold: null,
      lastError: null,
      reconciledAt: null,
      triageJson: null,
      triageForFindings: null,
      autoDecisionsJson: null
    };
    return harness.planReviewGates.create(input);
  };
  const begin = (sourceGateId: string, fromSha: string, currentJson: string, id = `c-${sourceGateId}`) =>
    corrections.begin({
      id,
      versionId: `v-${id}`,
      taskId: task.id,
      sourceGateId,
      fromSpecificationSha256: fromSha,
      currentSpecificationJson: currentJson,
      acceptedJson: '[]'
    });
  return { harness, corrections, task, gate, begin };
}

describe('plan correction repository', () => {
  it('opens a correction and records the reviewed specification as version 1 first', () => {
    const { corrections, task, gate, begin } = setup();
    const source = gate();

    const opened = begin(source.id, SHA('1'), '{"v":"one"}');

    expect(opened).toMatchObject({ round: 1, status: 'running', attempts: 1, sourceGateId: source.id });
    expect(corrections.listVersions(task.id)).toEqual([
      expect.objectContaining({ version: 1, origin: 'generated', specificationSha256: SHA('1'), specificationJson: '{"v":"one"}' })
    ]);
  });

  it('reopens the SAME row on retry, incrementing attempts, and never creates a second one for a gate', () => {
    const { corrections, task, gate, begin } = setup();
    const source = gate();
    const first = begin(source.id, SHA('1'), '{"v":"one"}');
    corrections.fail(first.id, 'Codex timed out.');
    expect(corrections.findBySourceGate(source.id)).toMatchObject({ status: 'failed', lastError: 'Codex timed out.' });

    const again = begin(source.id, SHA('1'), '{"v":"one"}', 'another-id');

    expect(again).toMatchObject({ id: first.id, status: 'running', attempts: 2, lastError: null });
    expect(corrections.listByTask(task.id)).toHaveLength(1);
    // The reviewed text was recorded once, not once per attempt.
    expect(corrections.listVersions(task.id)).toHaveLength(1);
  });

  it('numbers corrections per task and does not duplicate the version when the specification is unchanged', () => {
    const { corrections, task, gate, begin } = setup();
    const a = gate();
    const b = gate();
    begin(a.id, SHA('1'), '{"v":"one"}');
    const second = begin(b.id, SHA('1'), '{"v":"one"}');

    expect(second.round).toBe(2);
    expect(corrections.listVersions(task.id)).toHaveLength(1);
  });

  it('completes atomically: swaps the specification, clears approval, appends the version, closes the correction', () => {
    const { harness, corrections, task, gate, begin } = setup();
    harness.tasks.update(task.id, { specificationApprovedAt: '2026-09-06T00:00:00.000Z' });
    const source = gate();
    const opened = begin(source.id, SHA('1'), '{"v":"one"}');

    const { correction, version } = corrections.complete({
      correctionId: opened.id,
      versionId: 'version-two',
      expectedSpecificationJson: '{"v":"one"}',
      newSpecificationJson: '{"v":"two"}',
      newSpecificationSha256: SHA('2'),
      addressedJson: '[]'
    });

    expect(correction).toMatchObject({ status: 'completed', toVersion: 2, toSpecificationSha256: SHA('2'), lastError: null });
    expect(version).toMatchObject({ version: 2, origin: 'plan_correction', sourceCorrectionId: opened.id, specificationJson: '{"v":"two"}' });
    expect(harness.tasks.findById(task.id)).toMatchObject({ specificationJson: '{"v":"two"}', specificationApprovedAt: null });
  });

  it('stores what Codex said it addressed with the completion, and never before it', () => {
    const { corrections, gate, begin } = setup();
    const opened = begin(gate().id, SHA('1'), '{"v":"one"}');
    expect(opened.addressedJson).toBeNull();

    const addressed = JSON.stringify([{ finding: 0, field: 'summary', change: 'Reflected it.' }]);
    const { correction } = corrections.complete({
      correctionId: opened.id,
      versionId: 'version-two',
      expectedSpecificationJson: '{"v":"one"}',
      newSpecificationJson: '{"v":"two"}',
      newSpecificationSha256: SHA('2'),
      addressedJson: addressed
    });

    expect(correction.addressedJson).toBe(addressed);
    expect(corrections.findBySourceGate(opened.sourceGateId)?.addressedJson).toBe(addressed);
  });

  it('numbers a correction after the newest round, so a missing row can never wedge the next one', () => {
    const { harness, corrections, task, gate, begin } = setup();
    begin(gate().id, SHA('1'), '{"v":"one"}');
    begin(gate().id, SHA('1'), '{"v":"one"}');
    // A row that is gone leaves a gap; a count would now collide with round 2.
    harness.db.prepare('DELETE FROM plan_review_corrections WHERE task_id = ? AND round = 1').run(task.id);

    const next = begin(gate().id, SHA('1'), '{"v":"one"}');

    expect(next.round).toBe(3);
    expect(corrections.listByTask(task.id).map((entry) => entry.round)).toEqual([2, 3]);
  });

  it('rolls everything back when the specification moved: no version, no swap, the correction stays running', () => {
    const { harness, corrections, task, gate, begin } = setup();
    const source = gate();
    const opened = begin(source.id, SHA('1'), '{"v":"one"}');
    harness.tasks.update(task.id, { specificationJson: '{"v":"elsewhere"}' });

    expect(() =>
      corrections.complete({
        correctionId: opened.id,
        versionId: 'version-two',
        expectedSpecificationJson: '{"v":"one"}',
        newSpecificationJson: '{"v":"two"}',
        newSpecificationSha256: SHA('2'),
        addressedJson: '[]'
      })
    ).toThrow(/specification changed/i);

    expect(harness.tasks.findById(task.id)?.specificationJson).toBe('{"v":"elsewhere"}');
    expect(corrections.listVersions(task.id)).toHaveLength(1);
    expect(corrections.findBySourceGate(source.id)?.status).toBe('running');
  });

  it('refuses to complete a correction that is not running', () => {
    const { corrections, gate, begin } = setup();
    const source = gate();
    const opened = begin(source.id, SHA('1'), '{"v":"one"}');
    corrections.fail(opened.id, 'failed');

    expect(() =>
      corrections.complete({
        correctionId: opened.id,
        versionId: 'x',
        expectedSpecificationJson: '{"v":"one"}',
        newSpecificationJson: '{"v":"two"}',
        newSpecificationSha256: SHA('2'),
        addressedJson: '[]'
      })
    ).toThrow(/cannot be completed/i);
  });

  it('records content equal to an OLDER version as a new version instead of refusing it', () => {
    const { corrections, task, gate, begin } = setup();
    const a = gate();
    const b = gate();
    const first = begin(a.id, SHA('1'), '{"v":"one"}');
    corrections.complete({
      correctionId: first.id,
      versionId: 'v2',
      expectedSpecificationJson: '{"v":"one"}',
      newSpecificationJson: '{"v":"two"}',
      newSpecificationSha256: SHA('2'),
      addressedJson: '[]'
    });
    const second = begin(b.id, SHA('2'), '{"v":"two"}');

    // The next revision returns to the text of version 1.
    corrections.complete({
      correctionId: second.id,
      versionId: 'v3',
      expectedSpecificationJson: '{"v":"two"}',
      newSpecificationJson: '{"v":"one"}',
      newSpecificationSha256: SHA('1'),
      addressedJson: '[]'
    });

    expect(corrections.listVersions(task.id).map((entry) => [entry.version, entry.specificationSha256])).toEqual([
      [1, SHA('1')],
      [2, SHA('2')],
      [3, SHA('1')]
    ]);
  });

  it('makes a version immutable even to code that tries to change it', () => {
    const { harness, corrections, task, gate, begin } = setup();
    begin(gate().id, SHA('1'), '{"v":"one"}');

    expect(() =>
      harness.db.prepare('UPDATE task_specification_versions SET specification_json = ? WHERE task_id = ?').run('{"v":"tampered"}', task.id)
    ).toThrow(/immutable/i);
    expect(corrections.listVersions(task.id)[0]?.specificationJson).toBe('{"v":"one"}');
  });

  it('leaves history with the task: deleting the task removes it without tripping the immutability trigger', () => {
    const { harness, corrections, task, gate, begin } = setup();
    const opened = begin(gate().id, SHA('1'), '{"v":"one"}');
    corrections.complete({
      correctionId: opened.id,
      versionId: 'v2',
      expectedSpecificationJson: '{"v":"one"}',
      newSpecificationJson: '{"v":"two"}',
      newSpecificationSha256: SHA('2'),
      addressedJson: '[]'
    });

    harness.tasks.delete(task.id);

    expect(corrections.listVersions(task.id)).toEqual([]);
    expect(corrections.listByTask(task.id)).toEqual([]);
  });

  it('lets a gate be found by id and listed newest first', () => {
    const { harness, task, gate } = setup();
    const a = gate();
    const b = gate();

    expect(harness.planReviewGates.findById(a.id)?.id).toBe(a.id);
    expect(harness.planReviewGates.findById('missing')).toBeNull();
    expect(harness.planReviewGates.listByTask(task.id).map((entry) => entry.id)).toEqual([b.id, a.id]);
  });
});
