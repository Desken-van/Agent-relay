import { z } from 'zod';
import type { TaskStatus } from './workflow';

/**
 * The two provider roles, kept as separate schemas rather than one shared enum.
 *
 * Ornith is implementation-only: it never generates a specification, never
 * reviews code, and never becomes a task's `reviewProvider`. A single shared
 * schema would make "reject Ornith as a reviewer" a runtime check scattered
 * across every call site instead of a fact the type system already knows.
 */
export const implementationProviderSchema = z.enum(['claude', 'codex', 'ornith']);
export type ImplementationProvider = z.infer<typeof implementationProviderSchema>;

export const reviewProviderSchema = z.enum(['claude', 'codex']);
export type ReviewProvider = z.infer<typeof reviewProviderSchema>;

/**
 * Deprecated compatibility alias for code that has not yet migrated to the
 * narrower {@link ReviewProvider}/{@link ImplementationProvider} split.
 *
 * Intentionally identical to the pre-Ornith schema (`claude | codex`): nothing
 * that still imports this name is entitled to accept `ornith` merely because
 * this file grew a third provider.
 */
export const executionProviderSchema = z.enum(['claude', 'codex']);
export type ExecutionProvider = z.infer<typeof executionProviderSchema>;

function assertNeverProvider(value: never): never {
  throw new Error(`Unhandled provider: ${String(value)}`);
}

/**
 * Exhaustive by construction: an assert-never default means a provider added
 * to {@link implementationProviderSchema} without a case here fails to compile
 * rather than silently rendering as "Claude".
 *
 * {@link ReviewProvider} is a strict subset of {@link ImplementationProvider},
 * so this single function labels both roles.
 */
export function providerLabel(provider: ImplementationProvider): string {
  switch (provider) {
    case 'claude':
      return 'Claude';
    case 'codex':
      return 'Codex';
    case 'ornith':
      return 'Ornith';
    default:
      return assertNeverProvider(provider);
  }
}

export function canChangeProviders(status: TaskStatus): boolean {
  return ['DRAFT', 'READY_FOR_IMPLEMENTATION', 'CHANGES_REQUESTED', 'READY_FOR_REVIEW'].includes(status);
}
