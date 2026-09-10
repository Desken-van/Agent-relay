import { z } from 'zod';
import type { TaskStatus } from './workflow';

export const executionProviderSchema = z.enum(['claude', 'codex']);
export type ExecutionProvider = z.infer<typeof executionProviderSchema>;
export const providerLabel = (provider: ExecutionProvider): string => provider === 'codex' ? 'Codex' : 'Claude';

export function canChangeProviders(status: TaskStatus): boolean {
  return ['DRAFT', 'READY_FOR_IMPLEMENTATION', 'CHANGES_REQUESTED', 'READY_FOR_REVIEW'].includes(status);
}
