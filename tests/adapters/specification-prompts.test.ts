import { describe, expect, it } from 'vitest';
import { buildSpecificationRevisionPrompt } from '../../src/main/adapters/codex/prompts';
import type { AcceptedPlanFinding } from '../../src/shared/domain/plan-correction';
import { makeSpecification } from '../helpers/fakes';

const accepted: AcceptedPlanFinding = {
  finding: 2,
  severity: 'major',
  category: 'reliability',
  file: 'docs/manual-test.md',
  line: 0,
  title: 'The section names no fixture policy',
  why: 'The implementer could reach the live database.',
  fix: 'Require synthetic fixtures in the constraints and in the instruction.',
  operatorNote: ''
};

const revision = (): string =>
  buildSpecificationRevisionPrompt({
    projectPath: 'C:\\repo',
    taskTitle: 'Add a section',
    originalRequest: 'Add it.',
    currentSpecification: makeSpecification(),
    acceptedFindings: [accepted],
    round: 1,
    maxRounds: 3
  });

/** The prompt is hard-wrapped; compare it as running text. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');

describe('the specification revision prompt: what "addressed" must contain', () => {
  it('asks for one entry per (accepted finding, changed field) pair, repeating a finding per field', () => {
    const prompt = flat(revision());

    expect(prompt).toContain('one entry for every (accepted finding, changed field) PAIR');
    expect(prompt).toContain('ONE specification field you changed for it');
    expect(prompt).toContain(
      'A finding that required changes to several fields gets one entry per field, repeating the same finding number'
    );
    expect(prompt).toContain('"constraints" and in "implementationPrompt" is two entries, both with its number');
    expect(prompt).toContain('A field changed for several findings gets one entry per finding');
    expect(prompt).toContain(
      'Every accepted finding appears in at least one entry, and every field whose value differs from the current specification appears in at least one entry'
    );
    expect(prompt).toContain('when a field changed without an entry tying it to an accepted finding');
  });

  it('no longer asks for one entry per finding, which cannot describe a finding fixed in two fields', () => {
    expect(flat(revision())).not.toMatch(/one entry for EACH accepted finding/i);
  });
});
