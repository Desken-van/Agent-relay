/**
 * The kinds a verification that did not pass is classified into. A leaf module with no imports, so the record
 * schemas in `verification.ts` and `ornith-verification.ts` and the classifier in `verification-failure.ts`
 * all name the same list without a cycle.
 *
 * - `implementation`: positive evidence that the current files failed a check (assertion, type, lint, build).
 * - `infrastructure`: the test runner's own machinery failed, or the result was invalidated; a plain re-run is right.
 * - `output_limit`: the command's output reached Agent Relay's retention limit and was stopped there. The result
 *   cannot be classified, and the same command under the same settings would stop at the same limit, so it is
 *   never simply re-run: the files or the settings must change first.
 * - `cancelled`: stopped before it finished.
 * - `unknown`: nothing above could be established; fails closed.
 */
export const VERIFICATION_FAILURE_KINDS = ['implementation', 'infrastructure', 'output_limit', 'cancelled', 'unknown'] as const;
export type VerificationFailureKind = (typeof VERIFICATION_FAILURE_KINDS)[number];
