import { describe, expect, it } from 'vitest';
import { readSpecification } from '../../src/main/services/orchestrator';
import type { Task } from '../../src/shared/domain/models';

/** A specification exactly as it was stored before `scopedFilePaths` existed. */
const LEGACY_JSON = JSON.stringify({
  title: 'Add a health endpoint',
  summary: 'Expose GET /health returning a JSON status payload.',
  assumptions: [],
  acceptanceCriteria: ['GET /health responds 200.'],
  constraints: [],
  suggestedTests: [],
  implementationPrompt: 'Add a /health route.'
});

const taskWith = (specificationJson: string | null): Task => ({ specificationJson }) as Task;

describe('reading a stored specification through the orchestrator', () => {
  it('reads a specification stored without scopedFilePaths, with an empty scope', () => {
    const specification = readSpecification(taskWith(LEGACY_JSON));
    expect(specification.title).toBe('Add a health endpoint');
    expect(specification.scopedFilePaths).toEqual([]);
  });

  it('reads a stored scopedFilePaths unchanged', () => {
    const stored = JSON.stringify({ ...JSON.parse(LEGACY_JSON), scopedFilePaths: ['docs/manual-test.md'] });
    expect(readSpecification(taskWith(stored)).scopedFilePaths).toEqual(['docs/manual-test.md']);
  });

  it('still refuses a stored specification that is not valid', () => {
    expect(() => readSpecification(taskWith('{"title":"only a title"}'))).toThrow(/could not be read/);
    expect(() => readSpecification(taskWith(null))).toThrow(/no specification/);
  });
});
