/**
 * The exact Coai tool profiles this build audits, and nothing else.
 *
 * A profile is a complete tool list, not a minimum. The transport already
 * refuses a server whose `tools/list` is not exactly the configured allowlist —
 * missing, extra or duplicated names all fail closed — and these constants are
 * what that allowlist is set to. Naming them here keeps "which shapes have been
 * read and agreed" a fact with one home rather than a set of literals scattered
 * across adapters.
 *
 * Why exactness rather than "the tools I need are present": a server that grew a
 * tool this build has never seen is a server whose OTHER tools may also have
 * changed, and the two are indistinguishable from here. The failure that buys is
 * a refusal to start; the failure the loose check buys is a review that ran
 * against a contract nobody read.
 */

/**
 * The nine-tool Coai 0.22 plan profile — what the currently installed server is.
 *
 * Plan review works against exactly this, and code review provably cannot: the
 * three tools an addressable round needs are absent, and `review_code` alone
 * names its round only after it has run.
 */
export const COAI_PLAN_PROFILE = [
  'providers',
  'open',
  'review_plan',
  'review_code',
  'review_document',
  'consult',
  'resolve',
  'status',
  'ask_human'
] as const;

/**
 * The twelve-tool addressable profile — the nine above plus the round lifecycle.
 *
 * `reserve_round` names a round before anything runs, `run_round` dispatches
 * exactly that name, and `round_status` reads exactly that name back. Agent
 * Relay's durable code-review contract needs all three: a locator known before
 * the non-idempotent call, and a read-back that cannot answer about somebody
 * else's round.
 *
 * **No server that ships today advertises this.** It is the contract this build
 * requires, written down so the refusal against a legacy server is specific
 * rather than a shrug. Nothing here depends on a sibling checkout or an
 * unpublished build: the profile is a wire shape, and a server either presents
 * it or is refused.
 */
export const COAI_ADDRESSABLE_PROFILE = [
  ...COAI_PLAN_PROFILE,
  'reserve_round',
  'run_round',
  'round_status'
] as const;

/** The three that make a round addressable. Named so a refusal can list them. */
export const COAI_ADDRESSABLE_TOOLS = ['reserve_round', 'run_round', 'round_status'] as const;

/**
 * The provider identity Agent Relay files an addressable round under.
 *
 * A locator is only meaningful inside one provider's namespace, so the durable
 * round records this and every echoed locator is checked against it. It is a
 * constant rather than something the server tells us: a server that could name
 * itself could also rename itself between the dispatch and the recovery, and the
 * recovery would then look for a round filed under a name nothing holds.
 */
export const COAI_PROVIDER_ID = 'coai-mcp';

/** Is this exactly one of the audited profiles? */
export function isAuditedProfile(
  tools: readonly string[],
  profile: readonly string[]
): boolean {
  if (tools.length !== profile.length) return false;
  const seen = new Set(tools);
  // Length equality plus set equality would still admit a duplicate paired with
  // a missing name, so the duplicate is checked as itself.
  if (seen.size !== tools.length) return false;

  return profile.every((name) => seen.has(name));
}

/** Which audited profile this tool list is, or null when it is neither. */
export function profileOf(tools: readonly string[]): 'plan' | 'addressable' | null {
  if (isAuditedProfile(tools, COAI_ADDRESSABLE_PROFILE)) return 'addressable';
  if (isAuditedProfile(tools, COAI_PLAN_PROFILE)) return 'plan';

  return null;
}
