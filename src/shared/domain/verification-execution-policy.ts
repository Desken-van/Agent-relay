/** Conservative default for Vitest processes started by Relay, including older task checkouts.
 * Projects can explicitly override it in their Vitest config or command-line arguments.
 * Keep it in the verification fingerprint: changing this changes execution conditions.
 */
export const VERIFICATION_VITEST_MAX_WORKERS = 2;
