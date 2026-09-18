/**
 * Parse and hash a task's stored specification.
 *
 * Pulled out as its own module so neither review gate depends on the
 * other's service for this: `plan-review-gate.ts` and `code-review.ts`
 * both need "the current specification and its identity", and importing it
 * from one gate's own service module would make a change to that gate's
 * unrelated logic able to silently change the other's identity semantics.
 */

import { createHash } from 'node:crypto';
import { AgentRelayError } from '../../shared/domain/errors';
import { taskSpecificationSchema, type TaskSpecification } from '../../shared/schemas/codex';

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
  // The identity is persisted (plan-review gates, review subjects) and compared
  // by equality, so it must not move when the reader fills in a default. A
  // specification stored without `scopedFilePaths` keeps hashing exactly as it
  // did before the field was normalized; presence is read from the stored
  // JSON, because the parsed value always has the key.
  const storedScope = typeof value === 'object' && value !== null && Object.hasOwn(value, 'scopedFilePaths');
  const { scopedFilePaths: _normalized, ...withoutScope } = specification;
  const canonical = JSON.stringify(storedScope ? specification : withoutScope);
  return { specification, canonical, sha256: hash(canonical) };
}
