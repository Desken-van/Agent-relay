/**
 * A deterministic replay of the Ornith run observed in production (task
 * a5de435b…, run bb779441…), driven through the PRODUCTION
 * `OrnithImplementationService` and the PRODUCTION worktree tools over a real
 * temporary Git worktree. Only the model's answers are faked.
 *
 * The observed shape, reproduced byte for byte:
 *
 *   - the target `docs/manual-test.md` is 41,332 bytes;
 *   - the model read the WHOLE target in 25 windows, and `read_file` charges the
 *     file's full size for every window (25 × 41,332 = 1,033,300 bytes);
 *   - it then ran ONE repository-wide `search_text` over 260 files, which charged
 *     3,160,911 bytes;
 *   - 4,194,211 of the 4,194,304-byte repository read budget were gone — 93 bytes
 *     remained — and `replace_text` on the already-read target was refused, because
 *     validating the mutation needs Relay to read that target again.
 *
 * The replay is honest about what the model knows: every offset and the target's
 * hash come from the previous tool result's own progress event, never from the
 * test's knowledge of the file.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { locateExecutable } from '../../src/main/adapters/process/executable-locator';
import { ExecaProcessRunner } from '../../src/main/adapters/process/process-runner';
import { OrnithImplementationService, type OrnithImplementationResult } from '../../src/main/services/ornith-implementation';
import type { AgentProgressEvent, OrnithHealthyLease, OrnithInferenceLeaseService } from '../../src/main/ports';
import {
  LOCAL_INFERENCE_CONTRACT_VERSION,
  type LocalInferenceOutcome,
  type LocalInferenceRequest
} from '../../src/shared/domain/local-inference';
import type { TaskSpecification } from '../../src/shared/schemas/codex';
import { passedExecution } from './ornith-verification';

export const runner = new ExecaProcessRunner();
const located = locateExecutable('git');
if (!located) throw new Error('Git is required by the Ornith budget replay.');
export const gitPath = located.path;

export const TARGET = 'docs/manual-test.md';
export const TARGET_BYTES = 41_332;
/** One target plus 259 companions: the manifest of the observed run had 260 files. */
export const COMPANION_FILES = 259;
/** 25 windows, each charged the full file: 25 × 41,332. */
export const WINDOW_LIMIT = 1_654;
export const WINDOW_COUNT = 25;
export const OBSERVED_READ_CHARGE = WINDOW_COUNT * TARGET_BYTES; // 1,033,300
/** What the repository-wide search consumed in production. */
export const OBSERVED_SEARCH_CHARGE = 3_160_911;
export const DISCOVERY_BUDGET = 4 * 1024 * 1024;
/** 4,194,304 − 1,033,300 − 3,160,911. */
export const OBSERVED_REMAINING = DISCOVERY_BUDGET - OBSERVED_READ_CHARGE - OBSERVED_SEARCH_CHARGE; // 93

export const ORIGINAL_SENTENCE = 'Expected result: the dashboard loads.';
export const REPLACEMENT_SENTENCE = 'Expected result: the dashboard loads within two seconds.';
export const MISSING_NEEDLE = 'zz_no_such_needle_zz';

const specification: TaskSpecification = {
  title: 'Manual test wording',
  summary: 'Tighten one sentence in the manual test.',
  acceptanceCriteria: ['docs/manual-test.md states the two-second expectation.'],
  constraints: [],
  assumptions: [],
  suggestedTests: [],
  implementationPrompt: 'Use only the structured tool protocol.',
  scopedFilePaths: [TARGET]
};

/** Exactly `bytes` bytes of benign ASCII text: fixed-width lines plus a padded last line. */
export function textOf(bytes: number, label: string, head = ''): string {
  const line = (index: number): string =>
    `${label} entry ${String(index).padStart(6, '0')}: recorded during the manual test run.\n`;
  const lineBytes = line(0).length;
  const count = Math.max(0, Math.floor((bytes - head.length) / lineBytes));
  const parts: string[] = [head];
  for (let index = 0; index < count; index += 1) parts.push(line(index));
  const rest = bytes - head.length - count * lineBytes;
  if (rest > 0) parts.push(`${'.'.repeat(rest - 1)}\n`);
  const out = parts.join('');
  if (Buffer.byteLength(out) !== bytes) throw new Error(`The fixture text is ${Buffer.byteLength(out)} bytes, not ${bytes}.`);
  return out;
}

/** The marker successive edits of the same file rewrite, one digit at a time (same length, so the size never moves). */
export const marker = (revision: number): string => `Revision marker ${revision}.`;

export function targetContent(bytes = TARGET_BYTES): string {
  return textOf(bytes, 'Manual', `# Manual test\n\n${ORIGINAL_SENTENCE}\n${marker(0)}\n\n`);
}

/** Sizes of the 259 companions: 258 × 12,045 + 11,969 = 3,119,579, so the whole scan costs 3,160,911. */
export function companionSizes(): number[] {
  const sizes = Array.from({ length: COMPANION_FILES - 1 }, () => 12_045);
  sizes.push(OBSERVED_SEARCH_CHARGE - TARGET_BYTES - 12_045 * (COMPANION_FILES - 1));
  return sizes;
}

export interface ReplayFixture {
  readonly root: string;
  readonly repository: string;
  readonly worktreesRoot: string;
  readonly worktree: string;
  dispose(): void;
}

export async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await runner.run(gitPath, args, {
    cwd,
    timeoutMs: 60_000,
    env: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', GIT_EDITOR: 'true' }
  });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}

export interface FixtureOptions {
  /** Size of the target; the default is the observed 41,332 bytes. */
  readonly targetBytes?: number;
  /** Extra tracked files: relative path → content. */
  readonly extraFiles?: Readonly<Record<string, string>>;
  /** Omit the companions (a small repository for focused cases). */
  readonly companions?: boolean;
  /** Sizes of extra `fill/f<N>.txt` files a model can read (limit 1) to drain the discovery budget. */
  readonly fillerSizes?: readonly number[];
}

export const fillerPath = (index: number): string => `fill/f${index}.txt`;

export async function createReplayFixture(options: FixtureOptions = {}): Promise<ReplayFixture> {
  const root = mkdtempSync(join(tmpdir(), 'agent-relay-ornith-budget-'));
  const repository = join(root, 'repository');
  const worktreesRoot = join(root, 'worktrees');
  const worktree = join(worktreesRoot, 'task');
  mkdirSync(repository, { recursive: true });
  mkdirSync(worktreesRoot, { recursive: true });
  const write = (relative: string, content: string): void => {
    const absolute = join(repository, relative);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  };
  write(TARGET, targetContent(options.targetBytes ?? TARGET_BYTES));
  if (options.companions !== false) {
    companionSizes().forEach((size, index) => {
      write(`docs/generated/part-${String(index).padStart(3, '0')}.md`, textOf(size, `Part ${index}`));
    });
  }
  (options.fillerSizes ?? []).forEach((size, index) => write(fillerPath(index), textOf(size, `Filler ${index}`)));
  for (const [relative, content] of Object.entries(options.extraFiles ?? {})) write(relative, content);
  await git(repository, ['init', '-b', 'main']);
  // The observed byte counts are on-disk bytes; a Windows `autocrlf` checkout would grow every line.
  await git(repository, ['config', 'core.autocrlf', 'false']);
  await git(repository, ['config', 'core.eol', 'lf']);
  await git(repository, ['config', 'user.name', 'Ornith Fixture']);
  await git(repository, ['config', 'user.email', 'fixture@example.invalid']);
  await git(repository, ['add', '-A']);
  await git(repository, ['commit', '-q', '-m', 'fixture']);
  await git(repository, ['worktree', 'add', '-b', 'task', worktree, 'HEAD']);
  return {
    root,
    repository,
    worktreesRoot,
    worktree,
    dispose: () => rmSync(root, { recursive: true, force: true })
  };
}

export function lease(overrides: Partial<OrnithHealthyLease> = {}): OrnithHealthyLease {
  return {
    providerId: 'llama.cpp',
    modelId: 'ornith-fixture',
    runtimeInstanceId: 'runtime-fixture',
    contextLimitTokens: 32_768,
    maxOutputTokens: 1_024,
    release: () => undefined,
    onIndependentStop: () => undefined,
    ...overrides
  };
}

export function completed(request: LocalInferenceRequest, completion: string): LocalInferenceOutcome {
  return {
    kind: 'completed',
    version: LOCAL_INFERENCE_CONTRACT_VERSION,
    response: {
      version: LOCAL_INFERENCE_CONTRACT_VERSION,
      requestId: request.requestId,
      providerId: 'llama.cpp',
      modelId: 'ornith-fixture',
      runtimeVersion: 'fixture-1',
      runtimeInstanceId: 'runtime-fixture',
      durationMs: 1,
      completion,
      promptTokens: null,
      completionTokens: null,
      runtimeResponseId: null,
      finishReason: { kind: 'stop' }
    }
  };
}

/** What a model would learn from a `read_file` result, taken from the progress event that reports it. */
export interface ReadObservation {
  readonly offset: number;
  readonly bytesRead: number;
  readonly totalBytes: number;
  readonly sha256: string;
}

const READ_SUMMARY = /^read_file path="([^"]+)" offset=(\d+) bytes=(\d+) of (\d+) sha256=([0-9a-f]{64})$/;

export function observeRead(event: AgentProgressEvent, path = TARGET): ReadObservation | null {
  if (event.type !== 'tool_use') return null;
  const match = READ_SUMMARY.exec(event.text);
  if (match === null || match[1] !== path) return null;
  return { offset: Number(match[2]), bytesRead: Number(match[3]), totalBytes: Number(match[4]), sha256: match[5]! };
}

export interface ReplayResult {
  readonly result: OrnithImplementationResult;
  readonly events: readonly AgentProgressEvent[];
  readonly actions: readonly { readonly action: string; readonly [key: string]: unknown }[];
  /** Every prompt the model was sent, in order. */
  readonly prompts: readonly string[];
  /** The target as it is on disk afterwards. */
  readonly targetAfter: string;
  readonly status: string;
  readonly verifications: number;
}

/**
 * Where a step's `sha256` comes from — always something the model was actually shown:
 * `'observed'` is the hash of the last window it read of the target, `'shown'` the last
 * hash in the prompt it was most recently sent (which is how it learns a new hash after
 * its own edit), anything else a literal the test supplies (a stale or invented one).
 */
export type ShaSource = 'observed' | 'shown' | string;

export type ReplayStep =
  | { readonly kind: 'search_all' }
  /** A one-byte window of another file: it costs that file's WHOLE size, which is how a test spends discovery. */
  | { readonly kind: 'read'; readonly path: string }
  | {
      readonly kind: 'replace';
      readonly path?: string;
      readonly sha256?: ShaSource;
      readonly oldText?: string;
      readonly newText?: string;
    }
  | { readonly kind: 'delete'; readonly path?: string; readonly sha256?: ShaSource }
  | { readonly kind: 'verify' }
  | { readonly kind: 'diff' }
  /** `git_diff` with no `paths`: a different request from `diff`, covering the whole worktree. */
  | { readonly kind: 'diff_all' }
  | { readonly kind: 'finish' };

export interface ReplayScript {
  /** What the model asks for after its target windows, in order. */
  readonly afterRead: readonly ReplayStep[];
  /** Read windows of the target; defaults to the observed 25. */
  readonly windows?: number;
  /** Bytes per target window; defaults to the observed 1,654. */
  readonly windowLimit?: number;
  /** Runs when a request for the given (1-based) turn is answered — lets a test change the disk. */
  readonly beforeTurn?: (turn: number) => void;
  /**
   * The files the task declares it is confined to; defaults to the target alone. A declared scope
   * makes Relay refuse a repository-wide search until a search inside it comes up empty, so a replay
   * whose point is the discovery-budget arithmetic of that search passes `[]` (an unscoped task).
   */
  readonly scope?: readonly string[];
}

const SHOWN_HASH = /"sha256":"([0-9a-f]{64})"/g;

/**
 * Drive one whole implementation run. The model reads `windows` windows of the
 * target (following each result's own `nextOffset`), then follows `afterRead`.
 */
export async function replay(fixture: ReplayFixture, script: ReplayScript): Promise<ReplayResult> {
  const events: AgentProgressEvent[] = [];
  const actions: { action: string; [key: string]: unknown }[] = [];
  let lastRead: ReadObservation | null = null;
  let windowsDone = 0;
  let nextOffset = 0;
  let step = 0;
  let turn = 0;
  let verifications = 0;
  let latestPrompt = '';
  const prompts: string[] = [];
  const windows = script.windows ?? WINDOW_COUNT;
  const windowLimit = script.windowLimit ?? WINDOW_LIMIT;

  const resolveSha = (source: ShaSource | undefined): string | undefined => {
    if (source === undefined || source === 'observed') return lastRead?.sha256;
    if (source === 'shown') return [...latestPrompt.matchAll(SHOWN_HASH)].at(-1)?.[1];
    return source;
  };

  const next = (): Record<string, unknown> => {
    if (windowsDone < windows) {
      windowsDone += 1;
      const offset = nextOffset;
      return { version: 1, action: 'read_file', path: TARGET, offset, limit: windowLimit };
    }
    const item = script.afterRead[step];
    step += 1;
    if (item === undefined) return { version: 1, action: 'finish', summary: 'Nothing further to do.' };
    switch (item.kind) {
      case 'search_all':
        return { version: 1, action: 'search_text', query: MISSING_NEEDLE, caseSensitive: false, limit: 20 };
      case 'read':
        return { version: 1, action: 'read_file', path: item.path, offset: 0, limit: 1 };
      case 'replace':
        return {
          version: 1,
          action: 'replace_text',
          path: item.path ?? TARGET,
          sha256: resolveSha(item.sha256),
          replacements: [{ oldText: item.oldText ?? ORIGINAL_SENTENCE, newText: item.newText ?? REPLACEMENT_SENTENCE }]
        };
      case 'delete':
        return { version: 1, action: 'delete_file', path: item.path ?? TARGET, sha256: resolveSha(item.sha256) };
      case 'verify':
        return { version: 1, action: 'run_verification' };
      case 'diff':
        return { version: 1, action: 'git_diff', paths: [TARGET] };
      case 'diff_all':
        return { version: 1, action: 'git_diff' };
      case 'finish':
        return { version: 1, action: 'finish', summary: 'Tightened the expected result in the manual test.' };
    }
  };

  const leaseService: OrnithInferenceLeaseService = {
    acquireOrnithLease: async () => lease(),
    recheckOrnithLease: async () => true,
    inferForOrnith: async (_lease, request) => {
      turn += 1;
      latestPrompt = request.messages.map((message) => message.content).join('\n');
      prompts.push(latestPrompt);
      script.beforeTurn?.(turn);
      const action = next();
      actions.push(action as { action: string });
      return completed(request, JSON.stringify(action));
    }
  };

  const result = await new OrnithImplementationService().implement({
    worktreePath: fixture.worktree,
    worktreesRoot: fixture.worktreesRoot,
    repositoryPath: fixture.repository,
    branchName: 'task',
    specification: script.scope === undefined ? specification : { ...specification, scopedFilePaths: [...script.scope] },
    ruleEvidence: null,
    acceptedPlanReviewAddenda: null,
    correctionFindings: null,
    runType: 'implementation',
    round: 1,
    maxRounds: 3,
    loopDeadlineMs: 20 * 60_000,
    signal: new AbortController().signal,
    onProgress: (event) => {
      events.push(event);
      const observed = observeRead(event);
      if (observed !== null) {
        lastRead = observed;
        nextOffset = observed.offset + observed.bytesRead >= observed.totalBytes ? observed.offset : observed.offset + observed.bytesRead;
      }
    },
    runVerification: async () => {
      verifications += 1;
      return passedExecution();
    },
    lease: lease(),
    leaseService,
    gitExecutablePath: gitPath,
    runner
  });

  return {
    result,
    events,
    actions,
    prompts,
    targetAfter: readFileSync(join(fixture.worktree, TARGET), 'utf8'),
    status: await git(fixture.worktree, ['status', '--porcelain=v1', '--untracked-files=all']),
    verifications
  };
}

export const sha256Of = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');
