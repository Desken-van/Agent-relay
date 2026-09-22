/**
 * What `npm run verify` prints when it fails in each of the ways the failure classifier must tell apart.
 * The shapes are vitest's, tsc's, ESLint's and Vite's real output formats; the worker-timeout fixture is
 * the live failure of task a5de435b (2026-09-22, run bfc7482a) — three tests of one file attributed a
 * pool-level error while 2,282 others passed — with a machine path and a token-shaped string planted so
 * the same fixture also proves nothing raw or sensitive leaks past the sanitizer.
 */

export const PLANTED_PATH = 'C:\\Users\\someone\\AppData\\Roaming\\agent-relay\\worktrees\\a5de435b-add-configured-provider-smoke-test-check';
export const PLANTED_SECRET = `ghp_${'Q9w8E7r6T5y4U3i2O1p0A9s8D7f6'}`;

const RUN_HEADER = [
  '> agent-relay@0.1.0 verify',
  '> npm run lint && npm run typecheck && npm run test && npm run build && npm run test:e2e',
  '',
  '> agent-relay@0.1.0 lint',
  '> eslint .',
  '',
  '> agent-relay@0.1.0 typecheck',
  '> npm run typecheck:node && npm run typecheck:web',
  '',
  '> agent-relay@0.1.0 test',
  '> vitest run',
  '',
  ` RUN  v4.1.10 ${PLANTED_PATH}`,
  '',
  ' ✓ tests/domain/workflow.test.ts (28 tests) 41ms',
  ' ✓ tests/domain/ornith.test.ts (61 tests) 88ms'
].join('\n');

function poolFailureBlock(index: number, name: string): string {
  return [
    ` FAIL  tests/adapters/ornith-worktree-tools.test.ts > OrnithWorktreeTools containment and budgets > ${name}`,
    'Error: [vitest-pool]: Failed to start forks worker for test files tests/adapters/ornith-worktree-tools.test.ts.',
    ' ❯ runNextTicks node:internal/process/task_queues:64:5',
    ' ❯ processTimers node:internal/timers:518:9',
    ' ❯ Pool.schedule node_modules/vitest/dist/chunks/cli-api.BK8pd4xc.js:3465:5',
    'Caused by: Error: [vitest-pool-runner]: Timeout waiting for worker to respond',
    ' ❯ Timeout.<anonymous> node_modules/vitest/dist/chunks/cli-api.BK8pd4xc.js:3041:58',
    ' ❯ listOnTimeout node:internal/timers:585:17',
    ' ❯ processTimers node:internal/timers:521:7',
    '',
    `⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[${index}/3]⎯`
  ].join('\n');
}

const LIVE_FAILED_TESTS = [
  'the native mutation guard independently refuses create, replace, delete and mkdirp when the ancestor is swapped after every JavaScript-level recheck',
  'the native mutation guard refuses create, replace, delete and mkdirp when the entire worktree root is replaced by an ordinary directory after validation',
  'replace refuses a different same-name file introduced after the JavaScript hash check even when its content and hash are identical'
];

/** The live failure: vitest's pool lost a worker; every test of the current files that ran, passed. */
export const VITEST_WORKER_TIMEOUT_OUTPUT = [
  RUN_HEADER,
  ' ❯ tests/adapters/ornith-worktree-tools.test.ts (90 tests | 3 failed) 214922ms',
  `     × ${LIVE_FAILED_TESTS[0]} 14945ms`,
  `     × ${LIVE_FAILED_TESTS[1]} 13918ms`,
  `     × ${LIVE_FAILED_TESTS[2]} 14079ms`,
  '',
  '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 3 ⎯⎯⎯⎯⎯⎯⎯',
  '',
  ...LIVE_FAILED_TESTS.map((name, index) => poolFailureBlock(index + 1, name)),
  '',
  ' Test Files  1 failed | 82 passed (83)',
  '      Tests  3 failed | 2282 passed (2285)',
  '   Start at  14:00:12',
  '   Duration  573.02s (transform 96.44s, setup 0ms, import 467.24s, tests 2534.19s, environment 138.94s)',
  `npm error token=${PLANTED_SECRET}`
].join('\n');

/** A genuine test failure of the current files. */
export const VITEST_ASSERTION_FAILURE_OUTPUT = [
  RUN_HEADER,
  ' ❯ tests/domain/example.test.ts (4 tests | 1 failed) 52ms',
  '     × adds numbers 9ms',
  '',
  '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯',
  '',
  ' FAIL  tests/domain/example.test.ts > adds numbers',
  'AssertionError: expected 3 to be 4 // Object.is equality',
  '',
  '- Expected',
  '+ Received',
  '',
  '- 4',
  '+ 3',
  '',
  ' ❯ tests/domain/example.test.ts:12:19',
  '',
  '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯',
  '',
  ' Test Files  1 failed | 82 passed (83)',
  '      Tests  1 failed | 2284 passed (2285)'
].join('\n');

/** The same runner failure AND a real assertion failure in one run: the files' failure stands. */
export const VITEST_MIXED_FAILURE_OUTPUT = [
  RUN_HEADER,
  ' ❯ tests/domain/example.test.ts (4 tests | 1 failed) 52ms',
  '     × adds numbers 9ms',
  ` ❯ tests/adapters/ornith-worktree-tools.test.ts (90 tests | 1 failed) 214922ms`,
  `     × ${LIVE_FAILED_TESTS[0]} 14945ms`,
  '',
  '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯',
  '',
  ' FAIL  tests/domain/example.test.ts > adds numbers',
  'AssertionError: expected 3 to be 4 // Object.is equality',
  ' ❯ tests/domain/example.test.ts:12:19',
  '',
  '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯',
  '',
  poolFailureBlock(2, LIVE_FAILED_TESTS[0]!),
  '',
  ' Test Files  2 failed | 81 passed (83)',
  '      Tests  2 failed | 2283 passed (2285)'
].join('\n');

/** tsc found an error in the current files (the verify chain stops before the tests). */
export const TYPECHECK_FAILURE_OUTPUT = [
  '> agent-relay@0.1.0 verify',
  '> npm run lint && npm run typecheck && npm run test && npm run build && npm run test:e2e',
  '',
  '> agent-relay@0.1.0 typecheck:node',
  '> tsc --noEmit -p tsconfig.node.json',
  '',
  "src/main/services/orchestrator.ts(410,15): error TS2322: Type 'string' is not assignable to type 'number'.",
  ''
].join('\n');

/** ESLint found errors in the current files. */
export const ESLINT_FAILURE_OUTPUT = [
  '> agent-relay@0.1.0 lint',
  '> eslint .',
  '',
  `${PLANTED_PATH}\\src\\main\\services\\orchestrator.ts`,
  "  410:9  error  'unused' is assigned a value but never used  @typescript-eslint/no-unused-vars",
  '',
  '✖ 1 problem (1 error, 0 warnings)',
  ''
].join('\n');

/** The build failed on the current files. */
export const BUILD_FAILURE_OUTPUT = [
  '> agent-relay@0.1.0 build',
  '> electron-vite build',
  '',
  'vite v7.1.0 building for production...',
  'error during build:',
  'RollupError: Could not resolve "./missing" from "src/main/index.ts"',
  ''
].join('\n');

/**
 * The second live failure of the same task (run e6ead19a): the app's environment carried `NODE_ENV=production`
 * into the test run, React's production build has no `act`, and 528 renderer tests failed with a TypeError
 * thrown inside node_modules. Nothing about the files under test — and nothing an assertion, a type error, a
 * lint error or a runner signature would name. It must fail CLOSED: unknown, never "fix the files".
 */
export const REACT_PRODUCTION_ACT_OUTPUT = [
  RUN_HEADER,
  ' ❯ tests/renderer/run-verification.test.tsx (6 tests | 6 failed) 108ms',
  '     × blocks every action on the target it belongs to, and says why 108ms',
  '     × stays blocked after a diagnostic whose reply was lost 26ms',
  '',
  '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 528 ⎯⎯⎯⎯⎯⎯⎯',
  '',
  ' FAIL  tests/renderer/run-verification.test.tsx > shows the command, exit, snapshot and historical nature of a stored result',
  'TypeError: React.act is not a function',
  ' ❯ exports.act node_modules/react-dom/cjs/react-dom-test-utils.production.js:20:16',
  ' ❯ node_modules/@testing-library/react/dist/act-compat.js:46:25',
  ' ❯ renderRoot node_modules/@testing-library/react/dist/pure.js:198:26',
  ' ❯ render node_modules/@testing-library/react/dist/pure.js:300:10',
  ' ❯ tests/renderer/run-verification.test.tsx:9:3',
  '',
  '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[266/528]⎯',
  '',
  ' Test Files  40 failed | 43 passed (83)',
  '      Tests  528 failed | 1757 passed (2285)'
].join('\n');

/** A test exceeded its own budget: the test hung or the machine was too slow — the output cannot say which. */
export const VITEST_TEST_OWN_TIMEOUT_OUTPUT = [
  RUN_HEADER,
  ' ❯ tests/adapters/ornith-worktree-tools.test.ts (90 tests | 1 failed) 90212ms',
  '     × the native mutation guard independently refuses create, replace, delete and mkdirp when the ancestor is swapped after every JavaScript-level recheck 60001ms',
  '',
  ' FAIL  tests/adapters/ornith-worktree-tools.test.ts > OrnithWorktreeTools containment and budgets > the native mutation guard independently refuses create, replace, delete and mkdirp when the ancestor is swapped after every JavaScript-level recheck',
  'Error: Test timed out in 60000ms.',
  'If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".',
  '',
  ' Test Files  1 failed | 82 passed (83)',
  '      Tests  1 failed | 2284 passed (2285)'
].join('\n');
