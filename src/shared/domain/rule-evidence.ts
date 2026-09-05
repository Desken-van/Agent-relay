/**
 * Immutable evidence captured from project and convention rule files.
 *
 * Paths are always source-relative POSIX paths. Absolute checkout paths never
 * enter a snapshot, which keeps evidence portable and avoids persisting local
 * machine details in prompts, logs or databases.
 */

import { z } from 'zod';
import { isoDateTime } from './models';

export const RULE_EVIDENCE_VERSION = 1 as const;

export const RULE_SOURCE_KINDS = ['project', 'conventions'] as const;
export const ruleSourceKindSchema = z.enum(RULE_SOURCE_KINDS);
export type RuleSourceKind = z.infer<typeof ruleSourceKindSchema>;

export const RULE_OMISSION_REASONS = [
  'missing',
  'not_file',
  'symlink',
  'outside_root',
  'too_large',
  'invalid_text',
  'unreadable',
  'discovery_limit',
  'file_limit',
  'total_budget'
] as const;
export const ruleOmissionReasonSchema = z.enum(RULE_OMISSION_REASONS);
export type RuleOmissionReason = z.infer<typeof ruleOmissionReasonSchema>;

const relativeRulePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => {
    if (
      value.includes('\\') ||
      value.startsWith('/') ||
      value.includes(':') ||
      value !== value.normalize('NFC') ||
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u001f]/.test(value)
    ) {
      return false;
    }
    const segments = value.split('/');
    return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
  });
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const gitRevisionSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

export const ruleEvidenceSourceSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(64)
      .refine((value) => value === value.trim())
      // eslint-disable-next-line no-control-regex
      .refine((value) => !/[\u0000-\u001f]/.test(value)),
    kind: ruleSourceKindSchema,
    /** Exact Git commit observed before files were read. */
    revision: gitRevisionSchema,
    /** False is recorded honestly for a project worktree; conventions can require true. */
    clean: z.boolean()
  })
  .strict();
export type RuleEvidenceSource = z.infer<typeof ruleEvidenceSourceSchema>;

export const ruleEvidenceFileSchema = z
  .object({
    sourceId: z.string().min(1).max(64),
    path: relativeRulePathSchema,
    bytes: z.number().int().nonnegative().max(512 * 1024),
    sha256: hashSchema,
    /** The whole UTF-8 file. Never truncated. */
    content: z.string().max(512 * 1024)
  })
  .strict();
export type RuleEvidenceFile = z.infer<typeof ruleEvidenceFileSchema>;

export const ruleEvidenceOmissionSchema = z
  .object({
    sourceId: z.string().min(1).max(64),
    path: relativeRulePathSchema,
    reason: ruleOmissionReasonSchema
  })
  .strict();
export type RuleEvidenceOmission = z.infer<typeof ruleEvidenceOmissionSchema>;

export const ruleEvidenceSnapshotSchema = z
  .object({
    version: z.literal(RULE_EVIDENCE_VERSION),
    sources: z.array(ruleEvidenceSourceSchema).max(8),
    files: z.array(ruleEvidenceFileSchema).max(256),
    omitted: z.array(ruleEvidenceOmissionSchema).max(2_560),
    totalBytes: z.number().int().nonnegative().max(2 * 1024 * 1024),
    /** Hash of canonical sources, file hashes and omissions; capturedAt is excluded. */
    sha256: hashSchema,
    capturedAt: isoDateTime
  })
  .strict();
export type RuleEvidenceSnapshot = z.infer<typeof ruleEvidenceSnapshotSchema>;
