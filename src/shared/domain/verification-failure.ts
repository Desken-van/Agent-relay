/**
 * Why a verification did not pass — decided conservatively, from the locally held and bounded command
 * output, BEFORE anything about it is persisted or shown.
 *
 * The Run screen offers exactly one next step after a failed verification, and the step depends on WHAT
 * failed: a check that the current files did not pass is the implementation provider's to fix; a failure of
 * the test runner's own machinery (a worker that stopped answering, a process that never started) is not,
 * and asking a model to "fix" it would spend a round and a correction prompt on nothing. So the two must be
 * told apart — but only on positive evidence. The rules here are deliberately narrow: `implementation` needs
 * an explicit lint, typecheck, build or test-assertion failure, or one of two node:test module errors located
 * in the project's own files, without runner failure; mixed failures are
 * `unknown` and require bounded diagnosis; `infrastructure` needs a known
 * runner-level signature and NO such failure beside it; a command the process layer stopped at the output
 * retention limit is `output_limit` (nothing about the files is established, and the same command under the
 * same settings would stop at the same limit, so it is never simply re-run); everything else is `unknown`,
 * which fails closed (one diagnostic re-run; no implementation round is spent).
 *
 * Pure: no I/O, no clock. Every reason returned is a fixed, Relay-authored sentence plus at most an exit code
 * and a duration — never a line the command printed.
 */

import { boundedVerificationOutputWindow, formatVerificationDuration, type ExecutedVerificationOutcome } from './ornith-verification';

import type { VerificationFailureKind } from './verification-failure-kind';
export { VERIFICATION_FAILURE_KINDS, type VerificationFailureKind } from './verification-failure-kind';

export interface VerificationFailureClassification {
  readonly kind: VerificationFailureKind;
  /** Bounded and Relay-authored: what was found and what the right next step is. Never command text. */
  readonly reason: string;
}

export interface VerificationFailureInput {
  readonly outcome: ExecutedVerificationOutcome;
  readonly exitCode: number | null;
  readonly durationMs: number;
  /** The worktree's identity differed after the command from before it: the result cannot stand. */
  readonly identityChanged?: boolean;
  /** The process layer stopped the command because its output reached the caller's `maxOutputBytes`. */
  readonly outputLimitExceeded?: boolean;
  /** That limit, when the caller knows it, so the reason can name it the way Settings does. */
  readonly outputLimitBytes?: number;
  /** The command's stdout and stderr as the process layer returned them (already secret-redacted, bounded). */
  readonly output: string;
  /**
   * The directory the command ran in, as configured and as resolved (Node prints resolved paths). Only a
   * module error Node located inside one of these, outside `node_modules`, can be the files' own; without
   * them no such error is ever read as one.
   */
  readonly worktreeRoots?: readonly string[];
}

/**
 * The test runner's own machinery failing — every pattern is a literal message from vitest's pool
 * (`node_modules/vitest/dist/chunks/cli-api*.js`), which is what the project's verification uses. Each is
 * paired with the short, fixed label the reason names it by.
 */
const INFRASTRUCTURE_SIGNATURES: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /Electron failed to install correctly\b/, label: 'the installed Electron runtime is incomplete or inaccessible' },
  { pattern: /Electron is missing or incomplete\b/, label: 'the installed Electron runtime is incomplete or inaccessible' },
  { pattern: /\[vitest-pool-runner\]: Timeout waiting for worker to respond/, label: 'a Vitest worker stopped answering (worker timeout)' },
  { pattern: /\[vitest-pool\]: Timeout starting \w+ runner/, label: 'a Vitest worker did not start in time' },
  { pattern: /\[vitest-pool\]: Failed to start \w+ worker/, label: 'a Vitest worker could not be started' },
  { pattern: /\[vitest-pool\]: Worker \w+ emitted error/, label: 'a Vitest worker crashed' },
  { pattern: /\bWorker exited unexpectedly\b/, label: 'a Vitest worker exited unexpectedly' },
  { pattern: /\[vitest-pool\]: Timeout terminating \w+ worker/, label: 'a Vitest worker could not be shut down in time' },
  { pattern: /\[vitest-pool-runner\]: Cannot start a stopped runner/, label: 'the Vitest worker pool was already stopped' },
  { pattern: /\bERR_IPC_CHANNEL_CLOSED\b/, label: 'the test runner lost its channel to a worker' }
];

/** Runner evidence also lets old records with lossy summaries take the bounded diagnostic path. */
export function hasVerificationInfrastructureFailure(output: string): boolean {
  return INFRASTRUCTURE_SIGNATURES.some(({ pattern }) => pattern.test(boundedVerificationOutputWindow(output)));
}

/** Positive evidence that the CURRENT FILES failed a check. Nothing weaker counts. */
const IMPLEMENTATION_SIGNATURES: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /\bAssertionError\b/, label: 'a test assertion failed' },
  { pattern: /\berror TS\d{4,5}\b/, label: 'the TypeScript check reported errors' },
  { pattern: /✖ \d+ problems? \(\d+ errors?/, label: 'ESLint reported errors' },
  { pattern: /\berror during build\b|\bRollupError\b|\[vite\]: Rollup failed/i, label: 'the build failed' }
];

/**
 * node:test (`node --test`, spec and tap reporters) reports a test file that could not even be loaded as one
 * failed test whose only evidence is the error Node printed above it: the `file://…:LINE` location, the code
 * frame, then the message. Two such messages are the files' own, and only under all of these conditions:
 * node:test's own summary counts a failure; Node located the error in a file of this worktree outside
 * `node_modules`; a missing export was requested from a relative module of the project; no other
 * SyntaxError appears (a test's own `JSON.parse`, a dependency, an unsupported syntax for this Node); and no
 * Node module-environment error appears beside it (a package that is not installed, a file kind Node cannot
 * load). Anything else stays unknown. The dot reporter keeps only "test failed", so it stays unknown too.
 */
const NODE_TEST_FAILED_SUMMARY = /^(?:ℹ|#) fail [1-9]\d*$/m;
const NODE_DUPLICATE_DECLARATION = /^SyntaxError: Identifier '[^'\n]{1,200}' has already been declared$/;
const NODE_MISSING_EXPORT = /^SyntaxError: The requested module '([^'\n]{1,500})' does not provide an export named '[^'\n]{1,200}'$/;
const NODE_SYNTAX_ERROR = /\bSyntaxError\b/;
const NODE_LOCATION = /^(file:\/\/\S+?):\d+$/;
const NODE_LOCATION_LOOKBACK_LINES = 5;
const NODE_ENVIRONMENT_ERRORS =
  /\bERR_(?:MODULE_NOT_FOUND|UNKNOWN_FILE_EXTENSION|REQUIRE_ESM|UNSUPPORTED_DIR_IMPORT|UNSUPPORTED_ESM_URL_SCHEME|PACKAGE_PATH_NOT_EXPORTED|PACKAGE_IMPORT_NOT_DEFINED|INVALID_PACKAGE_CONFIG)\b/;
const NODE_DUPLICATE_DECLARATION_LABEL = 'node:test could not load a test because a project file declares the same name twice';
const NODE_MISSING_EXPORT_LABEL = 'node:test could not load a test because a project module does not export a name that is imported from it';
const ESCAPE = String.fromCharCode(27);
const ANSI_SEQUENCE = new RegExp(`${ESCAPE}\\[[0-9;?]*[ -/]*[@-~]`, 'g');

function normalizedPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** The path a `file://` URL names, or null when it cannot be decoded. */
function fileUrlPath(url: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(url.slice('file://'.length));
  } catch {
    return null;
  }
  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
}

/** True when `path` is a file inside one of `roots`, not under `node_modules` and without dot segments. */
function isProjectFile(path: string, roots: readonly string[]): boolean {
  const file = normalizedPath(path);
  const windows = /^[A-Za-z]:\//.test(file);
  return roots.some((root) => {
    const prefix = `${normalizedPath(root)}/`;
    if (prefix === '/') return false;
    const inside = windows ? file.toLowerCase().startsWith(prefix.toLowerCase()) : file.startsWith(prefix);
    if (!inside) return false;
    return file.slice(prefix.length).split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..' && segment !== 'node_modules');
  });
}

function nodeTestSourceFailures(text: string, roots: readonly string[]): string[] {
  if (roots.length === 0 || !NODE_TEST_FAILED_SUMMARY.test(text) || NODE_ENVIRONMENT_ERRORS.test(text)) return [];
  // The tap reporter prefixes each line of the child's stderr with "# "; spec prints it as is.
  const lines = text.split('\n').map((line) => line.replace(/^\s*(?:#\s)?/, '').trimEnd());
  const labels = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!NODE_SYNTAX_ERROR.test(line)) continue;
    const duplicate = NODE_DUPLICATE_DECLARATION.test(line);
    const missingExport = NODE_MISSING_EXPORT.exec(line);
    if (!duplicate && missingExport === null) return [];
    if (missingExport !== null && !/^\.\.?\//.test(missingExport[1]!)) return [];
    let location: string | null = null;
    for (let back = index - 1; back >= Math.max(0, index - NODE_LOCATION_LOOKBACK_LINES) && location === null; back -= 1) {
      location = NODE_LOCATION.exec(lines[back]!)?.[1] ?? null;
    }
    const path = location === null ? null : fileUrlPath(location);
    if (path === null || !isProjectFile(path, roots)) return [];
    labels.add(duplicate ? NODE_DUPLICATE_DECLARATION_LABEL : NODE_MISSING_EXPORT_LABEL);
  }
  return [...labels];
}

const CANCELLED_REASON = 'Verification cancelled; success was not established.';

/** Names the limit the way the Settings screen does ("Stored log budget: N k characters per run"). */
function outputLimitReason(limitBytes: number | undefined): string {
  const limit = limitBytes === undefined || !Number.isFinite(limitBytes) ? '' : ` (${Math.round(limitBytes / 1000)}k characters per run)`;
  return `Verification output exceeded Agent Relay's configured retention limit${limit}, so the result could not be ` +
    'classified safely: the command was stopped at the limit and only the output up to it was kept. Raise "Stored log ' +
    'budget" in Settings or reduce what npm run verify prints; running it again unchanged would stop at the same limit.';
}

function labelsMatching(
  signatures: readonly { readonly pattern: RegExp; readonly label: string }[],
  text: string
): string[] {
  return signatures.filter(({ pattern }) => pattern.test(text)).map(({ label }) => label);
}

function joinLabels(labels: readonly string[]): string {
  return labels.length <= 1 ? (labels[0] ?? '') : `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
}

/**
 * Decide the kind of a verification that did not pass. The order is the safety order: a cancellation, a
 * command stopped at the output limit and an invalidated result are known before any output is read (an
 * output that overflowed is incomplete by definition, so nothing in it — not even an assertion beside the
 * cut — is taken as evidence about the files); checks and runner failures together require a bounded
 * diagnostic re-run; a runner failure alone is retryable; anything else is unknown and fails closed.
 */
export function classifyVerificationFailure(input: VerificationFailureInput): VerificationFailureClassification {
  if (input.outcome === 'cancelled') {
    return { kind: 'cancelled', reason: CANCELLED_REASON };
  }
  if (input.outputLimitExceeded === true) {
    return { kind: 'output_limit', reason: outputLimitReason(input.outputLimitBytes) };
  }
  if (input.identityChanged === true) {
    return {
      kind: 'infrastructure',
      reason: 'Files or task inputs changed while verification was running, so its result cannot stand.'
    };
  }
  if (input.outcome === 'timed_out') {
    return {
      kind: 'unknown',
      reason: 'Verification timed out; success was not established. npm run verify did not finish within Agent ' +
        `Relay's process time limit (${formatVerificationDuration(input.durationMs)}), and the output does not say ` +
        'whether a check hung or the machine was too slow.'
    };
  }
  const text = boundedVerificationOutputWindow(input.output);
  const implementation = [
    ...labelsMatching(IMPLEMENTATION_SIGNATURES, text),
    ...nodeTestSourceFailures(text.replace(ANSI_SEQUENCE, '').replace(/\r\n?/g, '\n'), input.worktreeRoots ?? [])
  ];
  const infrastructure = labelsMatching(INFRASTRUCTURE_SIGNATURES, text);
  if (input.exitCode === null && implementation.length === 0 && infrastructure.length > 0) {
    return { kind: 'infrastructure', reason: `Verification could not start: ${joinLabels(infrastructure)}. Repair the installed verification tooling; the task files are preserved.` };
  }
  if (input.exitCode === null) {
    return {
      kind: 'infrastructure',
      reason: 'Verification could not complete: the command ended without an exit code (it could not be started, ' +
        'or the system terminated it). That is not a failure of the current files.'
    };
  }

  const exit = `npm run verify failed (exit ${input.exitCode})`;

  if (implementation.length > 0 && infrastructure.length > 0) {
    return {
      kind: 'unknown',
      reason: `${exit}: checks failed and the test runner also failed. Success was not established. ` +
        'Keep the existing changes and diagnose once under bounded concurrency before asking an implementation agent to repair them.'
    };
  }
  if (implementation.length > 0) {
    return { kind: 'implementation', reason: `${exit}: ${joinLabels(implementation)}. The current files did not pass.` };
  }
  if (infrastructure.length > 0) {
    return {
      kind: 'infrastructure',
      reason: `Verification could not complete: ${joinLabels(infrastructure)}. That is a failure of the test ` +
        'infrastructure, not of the current files.'
    };
  }
  return { kind: 'unknown', reason: `${exit}, but the output does not show which check failed or why.` };
}
