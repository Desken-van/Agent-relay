/**
 * Why a verification did not pass — decided conservatively, from the locally held and bounded command
 * output, BEFORE anything about it is persisted or shown.
 *
 * The Run screen offers exactly one next step after a failed verification, and the step depends on WHAT
 * failed: a check that the current files did not pass is the implementation provider's to fix; a failure of
 * the test runner's own machinery (a worker that stopped answering, a process that never started) is not,
 * and asking a model to "fix" it would spend a round and a correction prompt on nothing. So the two must be
 * told apart — but only on positive evidence. The rules here are deliberately narrow: `implementation` needs
 * an explicit lint, typecheck, build or test-assertion failure in the output; `infrastructure` needs a known
 * runner-level signature and NO such failure beside it; everything else is `unknown`, which fails closed
 * (verification is simply run again to obtain a clear result; no implementation round is spent).
 *
 * Pure: no I/O, no clock. Every reason returned is a fixed, Relay-authored sentence plus at most an exit code
 * and a duration — never a line the command printed.
 */

import { boundedVerificationOutputWindow, formatVerificationDuration, type ExecutedVerificationOutcome } from './ornith-verification';

export const VERIFICATION_FAILURE_KINDS = ['implementation', 'infrastructure', 'cancelled', 'unknown'] as const;
export type VerificationFailureKind = (typeof VERIFICATION_FAILURE_KINDS)[number];

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
  /** The command's stdout and stderr as the process layer returned them (already secret-redacted, bounded). */
  readonly output: string;
}

/**
 * The test runner's own machinery failing — every pattern is a literal message from vitest's pool
 * (`node_modules/vitest/dist/chunks/cli-api*.js`), which is what the project's verification uses. Each is
 * paired with the short, fixed label the reason names it by.
 */
const INFRASTRUCTURE_SIGNATURES: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /\[vitest-pool-runner\]: Timeout waiting for worker to respond/, label: 'a Vitest worker stopped answering (worker timeout)' },
  { pattern: /\[vitest-pool\]: Timeout starting \w+ runner/, label: 'a Vitest worker did not start in time' },
  { pattern: /\[vitest-pool\]: Failed to start \w+ worker/, label: 'a Vitest worker could not be started' },
  { pattern: /\[vitest-pool\]: Worker \w+ emitted error/, label: 'a Vitest worker crashed' },
  { pattern: /\bWorker exited unexpectedly\b/, label: 'a Vitest worker exited unexpectedly' },
  { pattern: /\[vitest-pool\]: Timeout terminating \w+ worker/, label: 'a Vitest worker could not be shut down in time' },
  { pattern: /\[vitest-pool-runner\]: Cannot start a stopped runner/, label: 'the Vitest worker pool was already stopped' },
  { pattern: /\bERR_IPC_CHANNEL_CLOSED\b/, label: 'the test runner lost its channel to a worker' }
];

/** Positive evidence that the CURRENT FILES failed a check. Nothing weaker counts. */
const IMPLEMENTATION_SIGNATURES: readonly { readonly pattern: RegExp; readonly label: string }[] = [
  { pattern: /\bAssertionError\b/, label: 'a test assertion failed' },
  { pattern: /\berror TS\d{4,5}\b/, label: 'the TypeScript check reported errors' },
  { pattern: /✖ \d+ problems? \(\d+ errors?/, label: 'ESLint reported errors' },
  { pattern: /\berror during build\b|\bRollupError\b|\[vite\]: Rollup failed/i, label: 'the build failed' }
];

const CANCELLED_REASON = 'Verification cancelled; success was not established.';

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
 * Decide the kind of a verification that did not pass. The order is the safety order: a cancellation and an
 * invalidated result are known before any output is read; a real failure of the files outranks a runner
 * hiccup that happened beside it; a runner hiccup alone is retryable; anything else is unknown and fails
 * closed.
 */
export function classifyVerificationFailure(input: VerificationFailureInput): VerificationFailureClassification {
  if (input.outcome === 'cancelled') {
    return { kind: 'cancelled', reason: CANCELLED_REASON };
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
  if (input.exitCode === null) {
    return {
      kind: 'infrastructure',
      reason: 'Verification could not complete: the command ended without an exit code (it could not be started, ' +
        'or the system terminated it). That is not a failure of the current files.'
    };
  }

  const text = boundedVerificationOutputWindow(input.output);
  const implementation = labelsMatching(IMPLEMENTATION_SIGNATURES, text);
  const infrastructure = labelsMatching(INFRASTRUCTURE_SIGNATURES, text);
  const exit = `npm run verify failed (exit ${input.exitCode})`;

  if (implementation.length > 0) {
    // A real failure of the files stands even when the runner also hiccupped beside it.
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
