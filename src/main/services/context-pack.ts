/**
 * Context Pack (14A): build a pack from one task worktree, prove a pack is intact, and tell whether it still
 * describes the worktree. See docs/context-pack.md for the contract and `src/shared/domain/context-pack.ts` for
 * the vocabulary.
 *
 * Building is deterministic: the same request over the same bytes gives the same pack, hash included. Sources are
 * read twice (before and after the pack is assembled) and a pack whose sources differ between the two reads is
 * refused. That detects a change; it is not a snapshot or a lock (docs/context-pack.md, "What the two reads
 * prove"). Nothing here is wired into a model loop yet (14C).
 */

import { createHash } from 'node:crypto';
import { AgentRelayError } from '../../shared/domain/errors';
import {
  CONTEXT_PACK_LIMITS,
  CONTEXT_PACK_VERSION,
  contextPackRequestSchema,
  contextPackSchema,
  isContextPathAllowed,
  renderContextPack,
  type ContextFragment,
  type ContextObservation,
  type ContextOmission,
  type ContextOmissionReason,
  type ContextPack,
  type ContextPackRequest,
  type ContextProvenance,
  type ContextSelector,
  type ContextSource,
  type ContextSourceObservation
} from '../../shared/domain/context-pack';
import { classifyLineEnding } from '../../shared/domain/ornith';
import { containsSecretShape } from '../../shared/util/redact';
import { OrnithWorktreeTools, type OrnithWorktreeToolsOptions } from './ornith-worktree-tools';

/** Reads the requested paths of one worktree in one bounded pass. */
export interface ContextSourceReader {
  observe(paths: readonly string[], signal: AbortSignal): Promise<ContextObservation>;
}

/** The task worktree, read through the same safety checks as an Ornith `read_file`. */
export class WorktreeContextSourceReader implements ContextSourceReader {
  constructor(private readonly options: OrnithWorktreeToolsOptions) {}

  observe(paths: readonly string[], signal: AbortSignal): Promise<ContextObservation> {
    // A fresh instance each pass: its file manifest is the worktree's now, not as an earlier pass found it.
    return new OrnithWorktreeTools(this.options).observeContextSources(
      paths,
      { maxFileBytes: CONTEXT_PACK_LIMITS.maxSourceFileBytes, maxTotalBytes: CONTEXT_PACK_LIMITS.maxReadBytes },
      signal
    );
  }
}

export type ContextPackRefusal =
  /** The request does not satisfy its schema. */
  | 'invalid_request'
  /** A selector names a path outside the request's read scope. */
  | 'path_not_allowed'
  /** The worktree is not this task's checkout, or it moved to another commit while it was read. */
  | 'worktree_invalid'
  /** The requested sources add up to more than one pass may read. */
  | 'read_limit_exceeded'
  /** A source changed between the two reads of one build. */
  | 'sources_changed';

export type ContextPackBuildResult =
  | { readonly ok: true; readonly pack: ContextPack }
  | { readonly ok: false; readonly code: ContextPackRefusal; readonly message: string; readonly path?: string };

export type ContextStaleReason =
  | { readonly kind: 'checkout_changed' }
  | { readonly kind: 'worktree_invalid' }
  | { readonly kind: 'source_changed' | 'source_removed' | 'source_appeared'; readonly path: string };

export type ContextPackFreshness =
  | { readonly fresh: true }
  | { readonly fresh: false; readonly stale: readonly ContextStaleReason[] };

const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

/**
 * The text of exactly these bytes, or null when they are not UTF-8. A BOM is kept as U+FEFF, wherever it is —
 * a file's first bytes or the first bytes of a fragment inside it — so the text encodes back to the same bytes:
 * anchors, content, offsets and hashes all describe one sequence. (`TextDecoder` drops a leading BOM by default.)
 */
function decodeExactly(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}
const utf8Bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/** JSON with every object's keys sorted and `undefined` dropped: one text per value, however it was built. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Byte offset where each line starts, plus the file's end: line n (1-based) is [starts[n-1], starts[n]). */
function lineStarts(raw: Uint8Array): number[] {
  const starts = [0];
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] === 0x0a && index + 1 < raw.length) starts.push(index + 1);
  }
  starts.push(raw.length);
  return starts;
}

interface ReadableSource {
  readonly raw: Uint8Array;
  readonly text: string;
  readonly starts: readonly number[];
  readonly lineCount: number;
}

function describeSource(path: string, observed: ContextSourceObservation): { source: ContextSource; readable: ReadableSource | null } {
  if (observed.state === 'absent') return { source: { path, state: 'absent' }, readable: null };
  if (observed.state === 'refused') return { source: { path, state: 'refused', reason: observed.reason }, readable: null };
  const raw = observed.raw;
  const starts = lineStarts(raw);
  const lineCount = raw.length === 0 ? 0 : starts.length - 1;
  const text = decodeExactly(raw);
  const content = text === null ? 'not_text' : containsSecretShape(text) ? 'secret_shaped' : 'text';
  return {
    source: { path, state: 'read', sha256: sha256(raw), bytes: raw.length, lineCount, lineEnding: classifyLineEnding(raw), content },
    readable: content === 'text' && text !== null ? { raw, text, starts, lineCount } : null
  };
}

/**
 * A selector's lines: all it asks for (`startLine`–`endLine`), and its core (`coreStart`–`coreEnd`) — the lines
 * it is no use without: an anchor's own lines, otherwise its first line.
 */
type Resolved =
  | {
      readonly ok: true;
      readonly startLine: number;
      readonly endLine: number;
      readonly coreStart: number;
      readonly coreEnd: number;
      readonly anchorLine: number | null;
    }
  | { readonly ok: false; readonly reason: ContextOmissionReason };

function lineOfIndex(text: string, index: number): number {
  let line = 1;
  for (let at = text.indexOf('\n'); at !== -1 && at < index; at = text.indexOf('\n', at + 1)) line += 1;
  return line;
}

function resolveSelector(selector: ContextSelector, source: ReadableSource): Resolved {
  if (source.lineCount === 0) return { ok: false, reason: 'empty_file' };
  switch (selector.kind) {
    case 'file':
      return { ok: true, startLine: 1, endLine: source.lineCount, coreStart: 1, coreEnd: 1, anchorLine: null };
    case 'lines':
      if (selector.startLine > source.lineCount) return { ok: false, reason: 'line_out_of_range' };
      return {
        ok: true,
        startLine: selector.startLine,
        endLine: Math.min(selector.endLine, source.lineCount),
        coreStart: selector.startLine,
        coreEnd: selector.startLine,
        anchorLine: null
      };
    case 'anchor': {
      const first = source.text.indexOf(selector.anchor);
      if (first === -1) return { ok: false, reason: 'anchor_not_found' };
      if (source.text.indexOf(selector.anchor, first + 1) !== -1) return { ok: false, reason: 'anchor_ambiguous' };
      const anchorLine = lineOfIndex(source.text, first);
      const lastLine = lineOfIndex(source.text, first + selector.anchor.length - 1);
      return {
        ok: true,
        startLine: Math.max(1, anchorLine - selector.linesBefore),
        endLine: Math.min(source.lineCount, lastLine + selector.linesAfter),
        coreStart: anchorLine,
        coreEnd: lastLine,
        anchorLine
      };
    }
  }
}

/** The lines of one file the pack holds so far, and the size of the fragment a range would end up in. */
class HeldLines {
  private readonly held: Uint8Array;

  constructor(private readonly source: ReadableSource) {
    this.held = new Uint8Array(source.lineCount + 2);
  }

  has(line: number): boolean {
    return this.held[line] === 1;
  }

  bytesOf(first: number, last: number): number {
    return this.source.starts[last]! - this.source.starts[first - 1]!;
  }

  /** What holding `line` costs the budget: nothing when it is already held. */
  cost(line: number): number {
    return this.has(line) ? 0 : this.bytesOf(line, line);
  }

  /** The bytes of the fragment `first`–`last` would be part of: it, and every held line touching it. */
  runBytes(first: number, last: number): number {
    let low = first;
    while (low > 1 && this.has(low - 1)) low -= 1;
    let high = last;
    while (high < this.source.lineCount && this.has(high + 1)) high += 1;
    return this.bytesOf(low, high);
  }

  /** Whether `first`–`last` touches or overlaps a held line, and so joins an existing fragment. */
  joinsHeld(first: number, last: number): boolean {
    for (let line = Math.max(1, first - 1); line <= Math.min(this.source.lineCount, last + 1); line += 1) {
      if (this.has(line)) return true;
    }
    return false;
  }

  hold(first: number, last: number): void {
    for (let line = first; line <= last; line += 1) this.held[line] = 1;
  }

  /** The held lines as maximal runs: one fragment each. */
  runs(): { readonly startLine: number; readonly endLine: number }[] {
    const runs: { startLine: number; endLine: number }[] = [];
    for (let line = 1; line <= this.source.lineCount; line += 1) {
      if (!this.has(line)) continue;
      const last = runs.at(-1);
      if (last !== undefined && last.endLine === line - 1) last.endLine = line;
      else runs.push({ startLine: line, endLine: line });
    }
    return runs;
  }
}

/**
 * The pack a request yields over one observation. Pure apart from hashing: every rule that decides what goes in
 * — anchors, the order the budget is spent in, where a selector is cut, how fragments form — is here.
 *
 * The budget is spent selector by selector in the request's order, line by line: a selector first needs its core
 * (an anchor's lines, otherwise its first line), then grows forward to its last line and back to its first. A
 * line a more important selector already holds costs nothing, so shared lines are paid for once and a less
 * important selector can never take lines a more important one needs. Fragments are formed afterwards, from the
 * runs of held lines, so merging decides nothing about what is held.
 */
export function assembleContextPack(request: ContextPackRequest, observation: ContextObservation): ContextPack {
  const sources = new Map<string, { source: ContextSource; readable: ReadableSource | null }>();
  for (const path of [...new Set(request.selectors.map((selector) => selector.path))].sort()) {
    const observed = observation.sources.get(path);
    if (observed === undefined) throw new AgentRelayError('INTERNAL', 'A requested context source was not observed.');
    sources.set(path, describeSource(path, observed));
  }

  const omissions: ContextOmission[] = [];
  const held = new Map<string, HeldLines>();
  const answered: { readonly path: string; readonly provenance: ContextProvenance }[] = [];
  let fragmentCount = 0;
  let remaining = request.maxContentBytes;
  const cap = CONTEXT_PACK_LIMITS.maxFragmentBytes;
  request.selectors.forEach((selector, index) => {
    const omit = (reason: ContextOmissionReason): void => {
      omissions.push({ selector: index, path: selector.path, reason });
    };
    const entry = sources.get(selector.path)!;
    if (entry.readable === null) {
      omit(entry.source.state === 'read' ? entry.source.content as 'not_text' | 'secret_shaped' : entry.source.state);
      return;
    }
    const resolved = resolveSelector(selector, entry.readable);
    if (!resolved.ok) {
      omit(resolved.reason);
      return;
    }
    let lines = held.get(selector.path);
    if (lines === undefined) {
      lines = new HeldLines(entry.readable);
      held.set(selector.path, lines);
    }

    const { coreStart, coreEnd } = resolved;
    let coreCost = 0;
    for (let line = coreStart; line <= coreEnd; line += 1) coreCost += lines.cost(line);
    if (lines.bytesOf(coreStart, coreEnd) > cap || lines.runBytes(coreStart, coreEnd) > cap) {
      omit('fragment_too_large');
      return;
    }
    if (coreCost > remaining) {
      omit('budget_exhausted');
      return;
    }
    if (!lines.joinsHeld(coreStart, coreEnd) && fragmentCount >= CONTEXT_PACK_LIMITS.maxFragments) {
      omit('fragment_limit');
      return;
    }
    remaining -= coreCost;
    let first = coreStart;
    let last = coreEnd;
    for (let line = coreEnd + 1; line <= resolved.endLine; line += 1) {
      const cost = lines.cost(line);
      if (cost > remaining || lines.runBytes(first, line) > cap) break;
      remaining -= cost;
      last = line;
    }
    for (let line = coreStart - 1; line >= resolved.startLine; line -= 1) {
      const cost = lines.cost(line);
      if (cost > remaining || lines.runBytes(line, last) > cap) break;
      remaining -= cost;
      first = line;
    }
    lines.hold(first, last);
    fragmentCount = [...held.values()].reduce((total, file) => total + file.runs().length, 0);
    answered.push({
      path: selector.path,
      provenance: {
        selector: index,
        reason: selector.reason,
        ...(selector.label === undefined ? {} : { label: selector.label }),
        startLine: resolved.startLine,
        endLine: resolved.endLine,
        anchorLine: resolved.anchorLine,
        includedStartLine: first,
        includedEndLine: last
      }
    });
  });

  const kept: Omit<ContextFragment, 'id'>[] = [];
  for (const path of [...held.keys()].sort()) {
    const lines = held.get(path)!;
    const source = sources.get(path)!.readable!;
    for (const run of lines.runs()) {
      const startByte = source.starts[run.startLine - 1]!;
      const endByte = source.starts[run.endLine]!;
      const bytes = source.raw.subarray(startByte, endByte);
      kept.push({
        path,
        startLine: run.startLine,
        endLine: run.endLine,
        startByte,
        endByte,
        contentSha256: sha256(bytes),
        // A slice of valid UTF-8 cut at line breaks is valid UTF-8.
        content: decodeExactly(bytes)!,
        provenance: answered
          .filter((item) => item.path === path && item.provenance.includedStartLine >= run.startLine && item.provenance.includedEndLine <= run.endLine)
          .map((item) => item.provenance)
      });
    }
  }
  const fragments: ContextFragment[] = kept.map((fragment, index) => ({ id: `f${index + 1}`, ...fragment }));
  omissions.sort((left, right) => left.selector - right.selector || (left.reason < right.reason ? -1 : left.reason > right.reason ? 1 : 0));
  const unsigned = {
    version: CONTEXT_PACK_VERSION,
    request,
    checkout: observation.checkout,
    sources: [...sources.values()].map((entry) => entry.source),
    fragments,
    omissions,
    contentBytes: fragments.reduce((total, fragment) => total + utf8Bytes(fragment.content), 0)
  };
  const pack: ContextPack = { ...unsigned, renderedBytes: 0, sha256: packHash(unsigned) };
  return { ...pack, renderedBytes: utf8Bytes(renderContextPack(pack)) };
}

/** The pack's hash: everything but `renderedBytes` and the hash itself, each fragment's content by its own hash. */
function packHash(pack: Omit<ContextPack, 'renderedBytes' | 'sha256'>): string {
  return sha256(canonicalJson({ ...pack, fragments: pack.fragments.map(({ content: _content, ...rest }) => rest) }));
}

/** What changed between a pack and a later observation of the same worktree; empty when nothing did. */
export function staleSources(pack: ContextPack, observation: ContextObservation): ContextStaleReason[] {
  const stale: ContextStaleReason[] = [];
  if (observation.checkout.branch !== pack.checkout.branch || observation.checkout.headCommit !== pack.checkout.headCommit) {
    stale.push({ kind: 'checkout_changed' });
  }
  for (const source of pack.sources) {
    const now = observation.sources.get(source.path);
    if (now === undefined) {
      stale.push({ kind: 'source_changed', path: source.path });
      continue;
    }
    if (source.state === 'read') {
      if (now.state === 'absent') stale.push({ kind: 'source_removed', path: source.path });
      else if (now.state === 'refused' || sha256(now.raw) !== source.sha256) stale.push({ kind: 'source_changed', path: source.path });
    } else if (source.state === 'absent') {
      if (now.state !== 'absent') stale.push({ kind: 'source_appeared', path: source.path });
    } else if (now.state !== 'refused' || now.reason !== source.reason) {
      stale.push({ kind: now.state === 'absent' ? 'source_removed' : 'source_changed', path: source.path });
    }
  }
  return stale;
}

async function observe(
  reader: ContextSourceReader,
  paths: readonly string[],
  signal: AbortSignal
): Promise<{ ok: true; observation: ContextObservation } | { ok: false; code: ContextPackRefusal; message: string }> {
  if (signal.aborted) throw new AgentRelayError('CANCELLED', 'Reading the context was cancelled.');
  try {
    return { ok: true, observation: await reader.observe(paths, signal) };
  } catch (error) {
    if (!(error instanceof AgentRelayError)) throw error;
    if (error.code === 'WORKTREE_INVALID' || error.code === 'GIT_FAILED') {
      return { ok: false, code: 'worktree_invalid', message: error.message };
    }
    if (error.code === 'VALIDATION_FAILED') return { ok: false, code: 'read_limit_exceeded', message: error.message };
    throw error;
  }
}

/**
 * Build a pack for `input` from the worktree `reader` reads. A refusal says why and builds nothing; cancellation
 * and a timeout throw (`CANCELLED`, `TIMEOUT`) and leave nothing behind.
 */
export async function buildContextPack(
  input: unknown,
  reader: ContextSourceReader,
  signal: AbortSignal
): Promise<ContextPackBuildResult> {
  const parsed = contextPackRequestSchema.safeParse(input);
  if (!parsed.success) {
    const where = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(request)'))].slice(0, 5);
    return { ok: false, code: 'invalid_request', message: `The context request is not valid at: ${where.join(', ')}.` };
  }
  const request = parsed.data;
  const outside = request.selectors.find((selector) => !isContextPathAllowed(selector.path, request.allowedPaths));
  if (outside !== undefined) {
    return { ok: false, code: 'path_not_allowed', message: 'A selector names a path outside the allowed paths.', path: outside.path };
  }
  const paths = [...new Set(request.selectors.map((selector) => selector.path))];
  const first = await observe(reader, paths, signal);
  if (!first.ok) return first;
  const pack = assembleContextPack(request, first.observation);
  const second = await observe(reader, paths, signal);
  if (!second.ok) return second;
  const changed = staleSources(pack, second.observation);
  if (changed.length > 0) {
    const named = changed.find((reason) => 'path' in reason);
    return {
      ok: false,
      code: 'sources_changed',
      message: 'The worktree changed while the context was read. Retry when editing has stopped.',
      ...(named !== undefined && 'path' in named ? { path: named.path } : {})
    };
  }
  return { ok: true, pack };
}

/**
 * Whether `value` is a pack this module could have built: its schema, every fragment against its own hash and
 * byte range, the sources and omissions against the request, the order, the budget, the pack hash and the
 * rendered size. Says nothing about whether the worktree still matches — that is {@link checkContextPackFreshness}.
 */
export function verifyContextPackIntegrity(value: unknown): { ok: true; pack: ContextPack } | { ok: false; problem: string } {
  const parsed = contextPackSchema.safeParse(value);
  if (!parsed.success) return { ok: false, problem: 'The pack does not match its schema.' };
  const pack = parsed.data;
  const fail = (problem: string): { ok: false; problem: string } => ({ ok: false, problem });

  const paths = [...new Set(pack.request.selectors.map((selector) => selector.path))].sort();
  if (canonicalJson(pack.sources.map((source) => source.path)) !== canonicalJson(paths)) {
    return fail('The sources are not exactly the requested paths, in order.');
  }
  const sources = new Map(pack.sources.map((source) => [source.path, source]));
  const answered = new Map<number, number>();
  let contentBytes = 0;
  let previous: ContextFragment | null = null;
  for (const [index, fragment] of pack.fragments.entries()) {
    if (fragment.id !== `f${index + 1}`) return fail('Fragment ids are not f1, f2, … in order.');
    const source = sources.get(fragment.path);
    if (source?.state !== 'read' || source.content !== 'text') return fail(`${fragment.id} names a source with no readable text.`);
    if (fragment.endLine < fragment.startLine || fragment.endLine > source.lineCount) return fail(`${fragment.id} has impossible lines.`);
    const bytes = utf8Bytes(fragment.content);
    if (fragment.endByte - fragment.startByte !== bytes || fragment.endByte > source.bytes || bytes === 0) {
      return fail(`${fragment.id} does not match its byte range.`);
    }
    if (bytes > CONTEXT_PACK_LIMITS.maxFragmentBytes) return fail(`${fragment.id} is larger than a fragment may be.`);
    if (sha256(fragment.content) !== fragment.contentSha256) return fail(`${fragment.id} does not match its hash.`);
    if (previous !== null && (previous.path > fragment.path || (previous.path === fragment.path && previous.endLine + 1 >= fragment.startLine))) {
      return fail(`${fragment.id} is out of order or overlaps the fragment before it.`);
    }
    let reach = fragment.startLine - 1;
    let previousSelector = -1;
    for (const item of fragment.provenance) {
      if (pack.request.selectors[item.selector]?.path !== fragment.path) return fail(`${fragment.id} answers a selector of another path.`);
      if (item.selector <= previousSelector) return fail(`${fragment.id} does not list its selectors once each, in order.`);
      previousSelector = item.selector;
      if (
        item.endLine < item.startLine || item.includedStartLine < item.startLine || item.includedEndLine > item.endLine ||
        item.includedEndLine < item.includedStartLine || item.includedStartLine < fragment.startLine ||
        item.includedEndLine > fragment.endLine ||
        (item.anchorLine !== null && (item.anchorLine < item.includedStartLine || item.anchorLine > item.includedEndLine))
      ) {
        return fail(`${fragment.id} holds lines for selector ${item.selector} that it did not ask for.`);
      }
      answered.set(item.selector, (answered.get(item.selector) ?? 0) + 1);
    }
    // Every line of a fragment is there because a selector it answers included it: no line is unexplained.
    for (const item of [...fragment.provenance].sort((left, right) => left.includedStartLine - right.includedStartLine)) {
      if (item.includedStartLine > reach + 1) break;
      reach = Math.max(reach, item.includedEndLine);
    }
    if (reach !== fragment.endLine || fragment.provenance.every((item) => item.includedStartLine !== fragment.startLine)) {
      return fail(`${fragment.id} holds lines no selector included.`);
    }
    contentBytes += bytes;
    previous = fragment;
  }
  for (const omission of pack.omissions) {
    if (pack.request.selectors[omission.selector]?.path !== omission.path) return fail('An omission names a selector of another path.');
    answered.set(omission.selector, (answered.get(omission.selector) ?? 0) + 1);
  }
  for (let index = 0; index < pack.request.selectors.length; index += 1) {
    if (answered.get(index) !== 1) return fail(`Selector ${index} is not answered exactly once.`);
  }
  if (contentBytes !== pack.contentBytes || contentBytes > pack.request.maxContentBytes) return fail('The content does not fit its budget.');
  const { renderedBytes: _renderedBytes, sha256: recorded, ...unsigned } = pack;
  if (packHash(unsigned) !== recorded) return fail('The pack does not match its hash.');
  if (utf8Bytes(renderContextPack(pack)) !== pack.renderedBytes) return fail('The rendered size is not the recorded one.');
  return { ok: true, pack };
}

/** Whether the worktree still holds exactly what `pack` was built from: the same commit and every source the same. */
export async function checkContextPackFreshness(
  pack: ContextPack,
  reader: ContextSourceReader,
  signal: AbortSignal
): Promise<ContextPackFreshness> {
  const observed = await observe(reader, pack.sources.map((source) => source.path), signal);
  if (!observed.ok) return { fresh: false, stale: [{ kind: 'worktree_invalid' }] };
  const stale = staleSources(pack, observed.observation);
  return stale.length === 0 ? { fresh: true } : { fresh: false, stale };
}

/**
 * The pack to act on now: `pack` itself while it is fresh, otherwise one rebuilt from its own request. A caller
 * that is about to change the worktree on the strength of a pack calls this first (docs/context-pack.md).
 */
export async function refreshContextPack(
  pack: ContextPack,
  reader: ContextSourceReader,
  signal: AbortSignal
): Promise<(ContextPackBuildResult & { readonly rebuilt: boolean })> {
  const freshness = await checkContextPackFreshness(pack, reader, signal);
  if (freshness.fresh) return { ok: true, pack, rebuilt: false };
  return { ...(await buildContextPack(pack.request, reader, signal)), rebuilt: true };
}
