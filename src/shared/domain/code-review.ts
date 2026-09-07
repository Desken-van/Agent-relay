/**
 * Durable identity and typed evidence for the external CODE review.
 *
 * ## Why this is not the plan-review gate
 *
 * The plan gate asks "is this specification worth implementing", answers once
 * per specification identity, and keeps its findings as one opaque JSON blob
 * that is decided in a single `resolve` call. Code review asks a different
 * question repeatedly against a moving artefact: the same defect can survive
 * several rounds, be fixed in one of them, and reappear. That needs findings
 * that are rows with their own identity and history, not an array re-serialised
 * every round — an array index is not an identity, and the third round's index
 * 2 is rarely the first round's index 2.
 *
 * So the two live side by side deliberately. Sharing one table to save code
 * would force one of the two questions to be asked badly.
 *
 * ## What is hashed, and what is not
 *
 * A review is only as trustworthy as its statement of what was reviewed. The
 * canonical form below is built so that two captures of the same working state
 * produce the same hash on any machine, and any change to the reviewed content
 * produces a different one. It therefore contains repository-relative POSIX
 * paths and content digests, and it contains no absolute path, no checkout
 * location, no timestamp and no machine identity: those differ between
 * machines without the reviewed code differing at all.
 */

import { z } from 'zod';
import { idSchema, isoDateTime } from './models';

/* -------------------------------------------------------------------------- */
/* Snapshot: the immutable statement of what is under review                   */
/* -------------------------------------------------------------------------- */

/** How a path came to be part of the reviewed content. */
export const CODE_SNAPSHOT_CHANGES = [
  'added',
  'modified',
  'deleted',
  'renamed',
  /** Present in the worktree and not tracked by Git at all. */
  'untracked'
] as const;
export type CodeSnapshotChange = (typeof CODE_SNAPSHOT_CHANGES)[number];

/**
 * Why a path that belongs to the change set carries no content digest.
 *
 * Both reasons make the snapshot INCOMPLETE, and there is deliberately no
 * size-based reason among them. A file skipped for being large used to record
 * only its path, reason and byte count — so two different files of exactly the
 * same size produced identical omission entries and therefore an identical
 * subject hash. Different code with the same identity is the one failure this
 * whole design exists to prevent, so every regular file is now streamed and
 * digested regardless of size, and what remains is only what genuinely cannot
 * be read.
 */
export const CODE_SNAPSHOT_OMISSIONS = [
  /** The bytes could not be read at all. */
  'unreadable',
  /** A symlink or reparse point leaving the worktree; never followed. */
  'unsafe_path'
] as const;
export type CodeSnapshotOmission = (typeof CODE_SNAPSHOT_OMISSIONS)[number];

export const codeSnapshotEntrySchema = z
  .object({
    /** Repository-relative POSIX path. Never an absolute or machine path. */
    path: z.string().min(1).max(1_024),
    change: z.enum(CODE_SNAPSHOT_CHANGES),
    /**
     * SHA-256 of the file's bytes as they stand in the worktree.
     *
     * Null only for a deletion, where there is no content, or for a path listed
     * in `omitted`, where the content was deliberately not read. Both cases are
     * visible in the canonical form, so a snapshot can never quietly claim to
     * cover bytes it never looked at.
     */
    contentSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    bytes: z.number().int().nonnegative()
  })
  .strict();
export type CodeSnapshotEntry = z.infer<typeof codeSnapshotEntrySchema>;

export const codeSnapshotOmissionSchema = z
  .object({
    path: z.string().min(1).max(1_024),
    reason: z.enum(CODE_SNAPSHOT_OMISSIONS),
    bytes: z.number().int().nonnegative()
  })
  .strict();
export type CodeSnapshotOmissionEntry = z.infer<typeof codeSnapshotOmissionSchema>;

export const CODE_SNAPSHOT_VERSION = 1;

export const codeReviewSnapshotSchema = z
  .object({
    version: z.literal(CODE_SNAPSHOT_VERSION),
    /** The commit the task branched from. Identity, not a moving branch name. */
    baseCommit: z.string().regex(/^[0-9a-f]{40}$/),
    /** The task branch's exact tip at capture time. */
    headCommit: z.string().regex(/^[0-9a-f]{40}$/),
    /** The branch name, recorded for humans; identity rests on the commits. */
    branch: z.string().min(1).max(255),
    entries: z.array(codeSnapshotEntrySchema).max(4_096),
    omitted: z.array(codeSnapshotOmissionSchema).max(4_096),
    /** Sum of `bytes` over entries whose content was actually digested. */
    totalBytes: z.number().int().nonnegative(),
    /** True when the change set itself was cut short by the entry ceiling. */
    truncated: z.boolean(),
    /**
     * Whether this snapshot digested every changed file it found.
     *
     * False when the file list was truncated or any path could not be read.
     * An incomplete snapshot is a real, storable observation — it says what was
     * seen and what was not — but it is never treated as an exact statement of
     * the code, so it cannot be reviewed against or decided on. Presenting a
     * partial capture as exact is how a review comes to describe code nobody
     * looked at.
     */
    complete: z.boolean(),
    /**
     * Whether the worktree holds tracked edits or untracked files.
     *
     * Recorded because it decides whether a reviewer that reads only committed
     * refs could possibly be looking at this subject. When it is true, such a
     * reviewer is reading something else.
     */
    hasUncommittedState: z.boolean()
  })
  .strict();
export type CodeReviewSnapshot = z.infer<typeof codeReviewSnapshotSchema>;

/**
 * The exact bytes that are hashed to identify a snapshot.
 *
 * Deterministic by construction rather than by convention: entries and
 * omissions are sorted by path, every field is written in a fixed order, and
 * nothing machine-specific is included. Two captures of the same working state
 * on two machines produce byte-identical output, and any change to the reviewed
 * content — a commit, an edit, a new untracked file, a deletion — changes it.
 *
 * `JSON.stringify` of the parsed object would almost work, but "almost" is not
 * a hash contract: it depends on key insertion order, which depends on how the
 * object was built. This writes the order out explicitly instead.
 */
export function canonicalCodeSnapshot(snapshot: CodeReviewSnapshot): string {
  const entries = [...snapshot.entries]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((entry) => [entry.path, entry.change, entry.contentSha256 ?? '', entry.bytes]);
  const omitted = [...snapshot.omitted]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((entry) => [entry.path, entry.reason, entry.bytes]);

  return JSON.stringify([
    'agent-relay/code-review-snapshot',
    snapshot.version,
    snapshot.baseCommit,
    snapshot.headCommit,
    snapshot.branch,
    entries,
    omitted,
    snapshot.totalBytes,
    snapshot.truncated,
    snapshot.complete,
    snapshot.hasUncommittedState
  ]);
}

/**
 * Is this a path a finding is allowed to point at?
 *
 * Repository-relative POSIX, or empty for a finding with no location. Reviewer
 * output is data from outside this application, and a path is the one field in
 * it that something downstream will eventually try to open. Absolute paths,
 * drive letters, UNC shares, `..` traversal, backslashes and NUL bytes are all
 * refused here rather than sanitised, because a path that needed sanitising is
 * a path whose author meant something this gate does not permit.
 */
export function isSafeRepositoryRelativePath(value: string): boolean {
  if (value === '') return true;
  if (value.length > 1_024) return false;
  if (value.includes('\u0000')) return false;
  // Backslashes are refused outright rather than translated: a POSIX path is
  // the contract, and translating would accept `..\..\etc` as if it were fine.
  if (value.includes('\\')) return false;
  if (value.startsWith('/')) return false;
  // `C:/x`, and the UNC forms `//host/share` and `\\host\share`.
  if (/^[a-zA-Z]:/.test(value)) return false;
  if (value.startsWith('//')) return false;
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return false;
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* Rounds                                                                      */
/* -------------------------------------------------------------------------- */

export const CODE_REVIEW_ROUND_STATUSES = [
  /** Durable intent, written BEFORE the non-idempotent reviewer call goes out. */
  'requested',
  /** The call is out and its answer has not come back. */
  'reviewing',
  'completed',
  /**
   * Dispatched, and the answer never arrived.
   *
   * Not `failed`: nothing refused the call, and it may well have run. This
   * state exists so that a lost answer is never mistaken for a call that did
   * not happen, and it never authorises an automatic repeat.
   */
  'interrupted',
  /** Refused before anything was dispatched, so provably without effect. */
  'failed'
] as const;
export type CodeReviewRoundStatus = (typeof CODE_REVIEW_ROUND_STATUSES)[number];

/** Round statuses whose outcome is not known to this side. */
export const CODE_REVIEW_UNRESOLVED_STATUSES = ['requested', 'reviewing', 'interrupted'] as const;

export const CODE_REVIEW_VERDICTS = [
  'proceed',
  'revise',
  'continue_anyway',
  'good_enough',
  'call_human',
  'escalated'
] as const;
export type CodeReviewVerdict = (typeof CODE_REVIEW_VERDICTS)[number];

/* -------------------------------------------------------------------------- */
/* Findings                                                                    */
/* -------------------------------------------------------------------------- */

export const CODE_FINDING_SEVERITIES = ['blocking', 'major', 'minor', 'nit'] as const;
export type CodeFindingSeverity = (typeof CODE_FINDING_SEVERITIES)[number];

export const CODE_FINDING_CATEGORIES = [
  'architecture',
  'security',
  'reliability',
  'performance',
  'ux',
  'convention'
] as const;
export type CodeFindingCategory = (typeof CODE_FINDING_CATEGORIES)[number];

/**
 * One finding as a provider stated it, after validation.
 *
 * Everything here is DATA. `title`, `body` and `fix` are reviewer prose: they
 * are stored, shown and hashed, and they are never interpreted as instructions,
 * paths to open, or commands to run.
 */
export const providerCodeFindingSchema = z
  .object({
    severity: z.enum(CODE_FINDING_SEVERITIES),
    category: z.enum(CODE_FINDING_CATEGORIES),
    /** Whether the provider counted this one against its gate. */
    gating: z.boolean(),
    title: z.string().min(1).max(500),
    body: z.string().min(1).max(20_000),
    fix: z.string().max(20_000),
    /** Repository-relative path the finding points at, or '' when it has none. */
    file: z
      .string()
      .max(1_024)
      .refine(isSafeRepositoryRelativePath, {
        message:
          'A finding location must be empty or a repository-relative POSIX path without traversal.'
      }),
    line: z.number().int().nonnegative(),
    /** Which vendor produced it, and in which reviewer role. */
    provider: z.string().min(1).max(200),
    role: z.string().max(100)
  })
  .strict();
export type ProviderCodeFinding = z.infer<typeof providerCodeFindingSchema>;

/**
 * Collapse cosmetic variation without collapsing meaning.
 *
 * Case and whitespace are normalised because a provider rewrapping a line is
 * not a different defect. Nothing else is: no stemming, no similarity, no
 * truncation. Two findings match only when their normalised text is EQUAL.
 */
export function normaliseFindingText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * The exact bytes whose digest becomes a finding's dedup fingerprint.
 *
 * Deduplication here is equality, never similarity. Two findings are the same
 * finding when the provider, role, category, severity, location and normalised
 * prose all match exactly; anything else keeps them apart. That direction is
 * chosen deliberately: merging two distinct defects hides one of them for good,
 * while failing to merge a repeat costs an operator one extra line to read.
 *
 * The body is included, so a materially rewritten finding is a new record — it
 * says something the previous one did not, and inheriting the earlier decision
 * would apply an answer to a question that was never asked.
 */
export function codeFindingFingerprintInput(
  subjectSha256: string,
  finding: ProviderCodeFinding
): string {
  return JSON.stringify([
    'agent-relay/code-review-finding',
    subjectSha256,
    finding.provider.trim().toLowerCase(),
    finding.role.trim().toLowerCase(),
    finding.category,
    finding.severity,
    finding.file.trim(),
    finding.line,
    normaliseFindingText(finding.title),
    normaliseFindingText(finding.body)
  ]);
}

/* -------------------------------------------------------------------------- */
/* Decisions                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What an operator decided about one finding.
 *
 * `resolved` is distinct from `accept` on purpose: accepting says the finding
 * is legitimate and will be addressed, while resolving says the code has since
 * been changed so that it no longer applies. Collapsing them would make it
 * impossible to tell an outstanding commitment from finished work.
 */
export const CODE_REVIEW_DECISION_ACTIONS = ['accept', 'reject', 'resolved'] as const;
export type CodeReviewDecisionAction = (typeof CODE_REVIEW_DECISION_ACTIONS)[number];

/** Who decided. Not a free-text field: an audit trail needs a closed set. */
export const CODE_REVIEW_ACTORS = ['operator', 'system'] as const;
export type CodeReviewActor = (typeof CODE_REVIEW_ACTORS)[number];

/* -------------------------------------------------------------------------- */
/* Durable rows                                                                */
/* -------------------------------------------------------------------------- */

export const codeReviewSubjectSchema = z
  .object({
    id: idSchema,
    taskId: idSchema,
    baseCommit: z.string().regex(/^[0-9a-f]{40}$/),
    headCommit: z.string().regex(/^[0-9a-f]{40}$/),
    branch: z.string().min(1).max(255),
    /** The canonical snapshot, verbatim. Immutable once written. */
    snapshotJson: z.string().min(1).max(4_000_000),
    subjectSha256: z.string().regex(/^[0-9a-f]{64}$/),
    fileCount: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
    /** False when anything could not be digested. Blocks review and decisions. */
    complete: z.boolean(),
    hasUncommittedState: z.boolean(),
    capturedAt: isoDateTime,
    createdAt: isoDateTime
  })
  .strict();
export type CodeReviewSubject = z.infer<typeof codeReviewSubjectSchema>;

export const codeReviewRoundSchema = z
  .object({
    id: idSchema,
    taskId: idSchema,
    subjectId: idSchema,
    /**
     * Denormalised from the subject on purpose.
     *
     * A result carries the hash it was computed against, and comparing it here
     * needs no join and cannot be defeated by a subject row being swapped —
     * which the repository forbids anyway, so the two must always agree.
     */
    subjectSha256: z.string().regex(/^[0-9a-f]{64}$/),
    status: z.enum(CODE_REVIEW_ROUND_STATUSES),
    verdict: z.enum(CODE_REVIEW_VERDICTS).nullable(),
    /**
     * The provider's identity for this round, written before dispatch.
     *
     * Null only between the durable intent and the moment the provider names
     * the round, and null in all three parts together — the database refuses
     * half a locator. A round with no locator can never be settled by recovery:
     * there is nothing to ask about, and guessing from the subject would let
     * another round's verdict land here. `providerId` is part of the name
     * because a session id means nothing without the provider it belongs to.
     */
    providerId: z.string().min(1).max(128).nullable(),
    sessionId: z.string().min(1).max(128).nullable(),
    providerRoundId: z.string().min(1).max(128).nullable(),
    serverName: z.string().min(1).max(200).nullable(),
    serverVersion: z.string().min(1).max(200).nullable(),
    reviewers: z.string().max(2_000).nullable(),
    gatingCount: z.number().int().nonnegative().nullable(),
    threshold: z.number().int().nonnegative().nullable(),
    /** Provider-reported usage. Null means unknown, which is never zero. */
    tokensIn: z.number().int().nonnegative().nullable(),
    tokensOut: z.number().int().nonnegative().nullable(),
    lastError: z.string().max(10_000).nullable(),
    /** Monotonic, bumped by every durable write, for compare-and-set. */
    revision: z.number().int().nonnegative(),
    startedAt: isoDateTime.nullable(),
    completedAt: isoDateTime.nullable(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime
  })
  .strict();
export type CodeReviewRound = z.infer<typeof codeReviewRoundSchema>;

export const codeReviewFindingSchema = z
  .object({
    /** Stable local identity. Survives every later round; never an index. */
    id: idSchema,
    taskId: idSchema,
    subjectSha256: z.string().regex(/^[0-9a-f]{64}$/),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    severity: z.enum(CODE_FINDING_SEVERITIES),
    category: z.enum(CODE_FINDING_CATEGORIES),
    gating: z.boolean(),
    title: z.string().min(1).max(500),
    body: z.string().min(1).max(20_000),
    fix: z.string().max(20_000),
    file: z.string().max(1_024),
    line: z.number().int().nonnegative(),
    provider: z.string().min(1).max(200),
    role: z.string().max(100),
    /** The round that first stated it, and the last one that repeated it. */
    firstRoundId: idSchema,
    lastRoundId: idSchema,
    timesReported: z.number().int().positive(),
    /** Monotonic, so a stale decision cannot overwrite a newer one. */
    revision: z.number().int().nonnegative(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime
  })
  .strict();
export type CodeReviewFinding = z.infer<typeof codeReviewFindingSchema>;

/**
 * What one round actually said about one finding.
 *
 * The stable finding row keeps identity and history; this keeps the round's own
 * words. They diverge more often than they look like they should: a later round
 * can re-raise the same defect at a different severity, mark it gating when the
 * first did not, or suggest a different fix. Folding those into the stable row
 * would silently rewrite what an earlier round said, and an audit trail that
 * edits its own history is not one.
 */
export const codeReviewOccurrenceSchema = z
  .object({
    id: idSchema,
    findingId: idSchema,
    roundId: idSchema,
    subjectSha256: z.string().regex(/^[0-9a-f]{64}$/),
    severity: z.enum(CODE_FINDING_SEVERITIES),
    category: z.enum(CODE_FINDING_CATEGORIES),
    gating: z.boolean(),
    title: z.string().min(1).max(500),
    body: z.string().min(1).max(20_000),
    fix: z.string().max(20_000),
    file: z.string().max(1_024),
    line: z.number().int().nonnegative(),
    provider: z.string().min(1).max(200),
    role: z.string().max(100),
    createdAt: isoDateTime
  })
  .strict();
export type CodeReviewOccurrence = z.infer<typeof codeReviewOccurrenceSchema>;

export const codeReviewDecisionSchema = z
  .object({
    id: idSchema,
    findingId: idSchema,
    /** The snapshot the decision was made against. Never inherited forward. */
    subjectSha256: z.string().regex(/^[0-9a-f]{64}$/),
    action: z.enum(CODE_REVIEW_DECISION_ACTIONS),
    reason: z.string().min(1).max(10_000),
    actor: z.enum(CODE_REVIEW_ACTORS),
    /** Where it came from, e.g. an IPC channel name. Never a path or secret. */
    source: z.string().min(1).max(200),
    /** The finding revision this decision was taken against. */
    findingRevision: z.number().int().nonnegative(),
    decidedAt: isoDateTime,
    createdAt: isoDateTime
  })
  .strict();
export type CodeReviewDecision = z.infer<typeof codeReviewDecisionSchema>;

/**
 * Whether a stored subject still describes the task's working state.
 *
 * The same four-state shape the plan gate settled on, and for the same reason:
 * "no" was doing two incompatible jobs. `stale` is a claim backed by two hashes
 * that were both read and differ. `unknown` is the admission that the working
 * state could not be captured at all — a missing branch, an unreadable
 * checkout — and it must never be presented as staleness, because the action
 * staleness suggests is to capture again, which is the one thing that cannot
 * work when capture is what failed.
 */
export type CodeReviewSubjectIdentity =
  | 'no_subject'
  | 'current'
  | 'stale'
  | 'unknown'
  /**
   * A subject was captured, and it is not an exact statement of the code.
   *
   * Kept apart from `stale` and `unknown` because it is neither: the capture
   * succeeded and the code has not moved, but something in it could not be
   * digested. Nothing may be reviewed or decided against it, and the honest
   * remedy is to fix what could not be read, not to capture again.
   */
  | 'incomplete';
