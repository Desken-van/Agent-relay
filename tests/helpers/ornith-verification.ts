import type { OrnithVerificationExecution } from '../../src/shared/domain/ornith-verification';

/** What the process layer would report for a verification that exited 0. */
export function passedExecution(durationMs = 1, output = 'Test Files  1 passed (1)'): OrnithVerificationExecution {
  return { exitCode: 0, failed: false, timedOut: false, cancelled: false, durationMs, output };
}

/** A verification that ran to a nonzero exit — the live failure's shape. */
export function failedExecution(
  exitCode = 1,
  durationMs = 511_795,
  output = ' FAIL  tests/adapters/ornith-worktree-tools.test.ts > native guard\nAssertionError: expected timeout to be stale_hash\n Test Files  1 failed | 118 passed (119)'
): OrnithVerificationExecution {
  return { exitCode, failed: true, timedOut: false, cancelled: false, durationMs, output };
}

/** A verification stopped by its own command timeout. */
export function timedOutExecution(durationMs = 600_000, output = 'still running…'): OrnithVerificationExecution {
  return { exitCode: null, failed: true, timedOut: true, cancelled: false, durationMs, output };
}

/** A verification that was aborted through its signal. */
export function cancelledExecution(durationMs = 1_000, output = ''): OrnithVerificationExecution {
  return { exitCode: null, failed: true, timedOut: false, cancelled: true, durationMs, output };
}
