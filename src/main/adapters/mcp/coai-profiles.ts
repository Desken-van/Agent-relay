import { createHash } from 'node:crypto';

/**
 * The Coai tool names this build knows, and what each operation needs.
 *
 * Two different questions live here, and they used to be one:
 *
 * 1. What does THIS OPERATION require to run? Answered by the small,
 *    per-operation constants below (`COAI_PLAN_REVIEW_TOOLS`,
 *    `COAI_HUMAN_ESCALATION_TOOLS`, `COAI_CODE_REVIEW_TOOLS`,
 *    `COAI_RECONCILIATION_TOOLS`). Each names only the tools the
 *    corresponding adapter method actually calls. The transport
 *    (stdio-mcp-client.ts) enforces these as a REQUIRED subset, not an exact
 *    match: the server must advertise every name in the set an operation
 *    declares, but is free to advertise other tools beyond it — a server
 *    growing an unrelated capability, or even one this build has never heard
 *    of, must not break a DIFFERENT, otherwise-compatible operation. That is
 *    what makes the four operations independent: enabling or losing one
 *    never depends on any other's tools being present.
 *
 * 2. Which shapes has this build actually read and agreed, for LABELLING a
 *    discovered server in diagnostics (never for gating an operation)?
 *    Answered by `COAI_PLAN_PROFILE` and `COAI_ADDRESSABLE_PROFILE`, the two
 *    full server shapes this build has audited end to end, plus
 *    `isAuditedProfile`/`profileOf` to recognise an EXACT match against one
 *    of them. A server that is neither is not thereby refused — the
 *    per-operation requirements above already decided that independently —
 *    it is simply reported as "not a shape this build recognises by name",
 *    which is informational context for a person, not a safety gate.
 *
 * What never changes, whichever question is being asked: an unaudited tool
 * name is never added to what any adapter is willing to CALL. Discovery
 * tolerating extra tools is not the same as trusting them — see
 * `StdioMcpClient.call`'s unconditional local allowlist check.
 */

/**
 * What `CoaiPlanReviewer` actually calls: open, read status back, submit a
 * plan for review, record decisions. Nothing else — `providers`,
 * `review_code`, `review_document`, `consult` and `ask_human` are part of the
 * audited SERVER shapes below, but this adapter never invokes any of them, so
 * their absence does not stop plan review from working.
 */
export const COAI_PLAN_REVIEW_TOOLS = ['open', 'status', 'review_plan', 'resolve'] as const;

/**
 * Escalating an open finding to a person, via the server's `ask_human` tool.
 *
 * Tracked as its OWN capability, independent of plan review and code review,
 * because it answers a different question ("can this server reach a human")
 * than either does. No Agent Relay adapter calls this tool today — it is
 * named here so Settings can report it accurately, and so a future caller has
 * a single place to depend on rather than a new literal.
 */
export const COAI_HUMAN_ESCALATION_TOOLS = ['ask_human'] as const;

/**
 * What plan-review reconciliation reads back: `status`, read-only, never
 * `review_plan` or `resolve` — reconciliation must never re-run either of
 * those non-idempotent calls. A subset of {@link COAI_PLAN_REVIEW_TOOLS},
 * named on its own because it is a distinct operation with its own
 * availability question: a server could in principle serve fresh plan rounds
 * but not answer `status`, or vice versa.
 */
export const COAI_RECONCILIATION_TOOLS = ['status'] as const;

/**
 * What `CoaiCodeReviewer` actually calls: reserve a round, run exactly that
 * round, read it back by its locator. `reserve_round` names a round before
 * anything runs, `run_round` dispatches exactly that name, and `round_status`
 * reads exactly that name back — Agent Relay's durable code-review contract
 * needs all three: a locator known before the non-idempotent call, and a
 * read-back that cannot answer about somebody else's round.
 */
export const COAI_CODE_REVIEW_TOOLS = ['reserve_round', 'run_round', 'round_status'] as const;

/** Backward-compatible name for {@link COAI_CODE_REVIEW_TOOLS}. */
export const COAI_ADDRESSABLE_TOOLS = COAI_CODE_REVIEW_TOOLS;

/**
 * The nine-tool Coai 0.22 plan-only server shape, for diagnostic labelling.
 *
 * No operation requires this exact set any more — see the module doc. It
 * survives as a recognised SHAPE because Settings can usefully say "this is
 * the plan-only server Coai has shipped" rather than only "plan review works,
 * code review does not".
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
 * The twelve-tool addressable server shape — the nine above plus the round
 * lifecycle — for diagnostic labelling. See the module doc: no operation
 * requires this exact set either. No server that ships today advertises it;
 * it is the full shape this build has audited, written down so a diagnostic
 * can name it precisely rather than only describe individual gaps.
 */
export const COAI_ADDRESSABLE_PROFILE = [
  ...COAI_PLAN_PROFILE,
  ...COAI_CODE_REVIEW_TOOLS
] as const;

/** Every tool name this build has ever given meaning to, across every operation and both labelled shapes. */
export const COAI_KNOWN_TOOLS = COAI_ADDRESSABLE_PROFILE;

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

/** Is this exactly one of the two labelled server shapes? Never used to gate an operation — see the module doc. */
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

/** Which labelled server shape this tool list is exactly, or null when it is neither. Informational only. */
export function profileOf(tools: readonly string[]): 'plan' | 'addressable' | null {
  if (isAuditedProfile(tools, COAI_ADDRESSABLE_PROFILE)) return 'addressable';
  if (isAuditedProfile(tools, COAI_PLAN_PROFILE)) return 'plan';

  return null;
}

/**
 * A minimal shape `computeCoaiContractFingerprint` needs from a discovered
 * tool — deliberately narrower than {@link ExternalMcpTool} so this file
 * never has to import the full port type, and so a caller building test
 * fixtures does not have to invent annotations/title/description it does not
 * have.
 */
export interface CoaiFingerprintableTool {
  readonly name: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/**
 * Property names whose ARRAY value is a JSON Schema SET, not a sequence,
 * WHEN that key is read as a schema keyword: `required` lists property
 * names and a `type` union lists alternative types — neither means anything
 * different when listed in a different order.
 *
 * `enum` belongs to the same idea but is handled separately, below, because
 * unlike these two its elements are not plain strings to sort directly —
 * each alternative is itself a full literal JSON value whose own nested
 * structure must be canonicalized as DATA (object keys sorted, but every
 * array inside it left exactly as it was) before the alternatives, now
 * comparable, are sorted as a set.
 *
 * Scoped to exactly these two names, and only while `canonicalizeAt` is
 * still walking SCHEMA — never inside `const`, `default`, `examples`, or an
 * `enum` alternative's own contents. Literal data can legally contain a key
 * that happens to be spelled `required` or `type` without meaning the JSON
 * Schema keyword at all (an argument's own data, or a value inside `const`),
 * and reordering an array under such a key would silently change what that
 * data means. See `computeCoaiContractFingerprint`'s regression test for the
 * concrete case: `const: { enum: [1, 2] }` and `const: { enum: [2, 1] }` are
 * two DIFFERENT literal values and must fingerprint differently, even though
 * the inner key is spelled exactly like the schema keyword.
 */
const SCHEMA_SET_ARRAY_KEYS = new Set(['required', 'type']);

/**
 * Keys under which a JSON Schema keyword's value is literal DATA, not a
 * further schema — everything canonicalized underneath one of these keys
 * (and everything nested inside THAT, arbitrarily deep) switches to DATA
 * mode for the rest of the walk: object keys still sort for stable
 * serialization, but no array anywhere below is ever reordered again,
 * whatever any of its keys happen to be spelled.
 *
 * This only fires when one of these names is encountered as a SCHEMA's own
 * keyword — see {@link SCHEMA_MAP_KEYS} for the other case a key can occur
 * in, where it never means this at all.
 */
const SCHEMA_DATA_ONLY_KEYS = new Set(['const', 'default', 'examples']);

/**
 * Keys whose value is a MAP from an ARBITRARY name to a subschema —
 * `properties` maps property names, `patternProperties` maps regex
 * patterns, `$defs`/`definitions` map reusable-schema names, and
 * `dependentSchemas` maps property names to the subschema that applies when
 * that property is present — never a schema's own keyword set. The map's
 * KEYS carry no meaning `canonicalizeAt` should ever act on; only its VALUES
 * are schemas, and each is walked in SCHEMA mode regardless of what its key
 * happens to be spelled.
 *
 * This is the fix for the location-awareness gap a name-only check would
 * still have: a property is free to be NAMED `default`, `const`, `examples`,
 * `enum`, `required` or `type` without that name meaning anything about the
 * property's OWN subschema — `properties: { default: { enum: ["a", "b"] } }`
 * has a property called "default" whose subschema has a perfectly ordinary
 * `enum`, which must still be sorted as the set it is. Checking the key
 * `"default"` against {@link SCHEMA_DATA_ONLY_KEYS} without first knowing
 * whether that key was reached as a schema's own keyword or as one entry of
 * a `properties` (or `dependentSchemas`) map would wrongly switch that
 * subschema into data mode.
 */
const SCHEMA_MAP_KEYS = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas'
]);

/** A stable ordering key for an already-canonicalized JSON value, used only to sort order-insensitive arrays deterministically. */
function canonicalSortKey(value: unknown): string {
  return JSON.stringify(value);
}

function sortCanonicalArray(items: readonly unknown[]): unknown[] {
  return [...items].sort((a, b) => {
    const sortKeyA = canonicalSortKey(a);
    const sortKeyB = canonicalSortKey(b);
    return sortKeyA < sortKeyB ? -1 : sortKeyA > sortKeyB ? 1 : 0;
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

type CanonicalizeMode = 'schema' | 'data';

/**
 * Recursively sorts an object's keys so semantically identical JSON always
 * serializes to the same text regardless of property declaration order —
 * and, for a `required` list, a `type` union, or the OUTER list of `enum`
 * alternatives, sorts the array's own elements too, so a server or SDK that
 * happens to enumerate one of those in a different order never moves the
 * fingerprint on its own.
 *
 * Every other array keeps its original element order — a tuple-form
 * `items`, `prefixItems`, a literal array inside `const`/`default`, an
 * individual `enum` alternative's own nested arrays, or arbitrary argument
 * data — because for those the order genuinely is part of what the array
 * means. The distinction is tracked with a MODE, not just a key name: once
 * the walk enters literal data (`const`/`default`/`examples`, or one
 * `enum` alternative), it stays in data mode all the way down, so a key
 * spelled `required`/`type`/`enum` INSIDE that data is never mistaken for
 * the schema keyword of the same name.
 *
 * The mode switch is additionally LOCATION-aware, not merely name-aware: a
 * key is only read as the `const`/`default`/`examples` KEYWORD when it is
 * one of a SCHEMA's own keys. When it is instead one entry of a
 * {@link SCHEMA_MAP_KEYS} map (a property name under `properties`, a
 * definition name under `$defs`), every entry's value is walked as a schema
 * regardless of what that entry's own key is spelled — see
 * `computeCoaiContractFingerprint`'s regression tests for the concrete case:
 * a PROPERTY named "default" whose own subschema has an `enum` must still
 * have that `enum` treated as a set, exactly as any other property's would.
 */
export function canonicalizeJson(value: unknown): unknown {
  return canonicalizeAt(value, null, 'schema');
}

/** Canonicalizes a map of arbitrary names to subschemas — see {@link SCHEMA_MAP_KEYS}. Keys sort for stable serialization; every value is walked as its OWN schema. */
function canonicalizeSchemaMap(map: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(map)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, subSchema]) => [name, canonicalizeAt(subSchema, null, 'schema')] as const);
  return Object.fromEntries(entries);
}

function canonicalizeAt(value: unknown, key: string | null, mode: CanonicalizeMode): unknown {
  if (Array.isArray(value)) {
    if (mode === 'schema' && key === 'enum') {
      // Each alternative is a literal value, canonicalized as DATA — its own
      // structure is stabilized but never reordered — and only then are the
      // (now comparable) alternatives themselves sorted as a set.
      const alternatives = value.map((item) => canonicalizeAt(item, null, 'data'));
      return sortCanonicalArray(alternatives);
    }
    const canonicalized = value.map((item) => canonicalizeAt(item, null, mode));
    if (mode === 'schema' && key !== null && SCHEMA_SET_ARRAY_KEYS.has(key)) {
      return sortCanonicalArray(canonicalized);
    }
    return canonicalized;
  }
  if (isPlainRecord(value)) {
    const entries = Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([entryKey, entryValue]) => {
        // A MAP entry (`properties`/`patternProperties`/`$defs`/
        // `definitions`'s value): its own keys are arbitrary names, never
        // schema keywords, however one of them happens to be spelled.
        if (mode === 'schema' && SCHEMA_MAP_KEYS.has(entryKey) && isPlainRecord(entryValue)) {
          return [entryKey, canonicalizeSchemaMap(entryValue)] as const;
        }
        const nextMode: CanonicalizeMode =
          mode === 'schema' && SCHEMA_DATA_ONLY_KEYS.has(entryKey) ? 'data' : mode;
        return [entryKey, canonicalizeAt(entryValue, entryKey, nextMode)] as const;
      });
    return Object.fromEntries(entries);
  }
  return value;
}

/**
 * A deterministic, durable fingerprint of the EXACT Coai contract one
 * operation negotiated.
 *
 * Built only from: the negotiated MCP protocol version, the server's own
 * identity strings (name/version — the caller is expected to have already run
 * these through the same identity-safety scan a completed round is held to;
 * this function does not scan them itself, since it has no display or
 * persistence policy of its own to enforce), and the canonicalized
 * `inputSchema` of only the tools `requiredToolNames` names — the LOCAL,
 * per-operation constants above, never a name the server sent that this
 * build does not itself already know to look for.
 *
 * This is what makes the fingerprint real evidence rather than a display
 * convenience: two probes of an unchanged, contract-compatible server always
 * hash identically (object-key order and the order the server listed its
 * tools in cannot move the hash), and a tool that quietly tightens or
 * loosens a property type, adds an enum constraint, or restructures a nested
 * object always hashes differently — even when the tool's NAME and the
 * server's reported VERSION did not change, which a fingerprint built only
 * from names and version strings cannot detect. A server tool this build
 * does not require for the operation never enters the hash at all, so a
 * server growing an unrelated capability never changes it either.
 */
export function computeCoaiContractFingerprint(input: {
  readonly protocolVersion: string;
  readonly serverName: string;
  readonly serverVersion: string;
  readonly tools: readonly CoaiFingerprintableTool[];
  readonly requiredToolNames: readonly string[];
}): string {
  const byName = new Map(input.tools.map((tool) => [tool.name, tool] as const));
  const relevant = [...input.requiredToolNames]
    .sort()
    .map((name) => {
      const tool = byName.get(name);
      if (tool === undefined) {
        // Every real caller validates the required subset is present before
        // ever reaching here (see stdio-mcp-client.ts's `validateToolSet`),
        // so this is a caller bug, not a runtime possibility to degrade for.
        throw new Error(`computeCoaiContractFingerprint: required tool "${name}" was not discovered.`);
      }
      return { name: tool.name, inputSchema: canonicalizeJson(tool.inputSchema) };
    });

  const payload = JSON.stringify({
    protocolVersion: input.protocolVersion,
    serverName: input.serverName,
    serverVersion: input.serverVersion,
    tools: relevant
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/** Independently, per operation: which of the four capabilities a discovered tool list satisfies. */
export interface CoaiDetectedCapabilities {
  readonly planReview: boolean;
  readonly humanEscalation: boolean;
  readonly codeReview: boolean;
  readonly reconciliation: boolean;
  /** How many tools beyond {@link COAI_KNOWN_TOOLS} the server also advertises. Never made callable regardless. */
  readonly unknownToolCount: number;
}

/**
 * Compute all four operation capabilities from one discovered tool list, in
 * one pass, entirely locally — no further request needed, and no operation's
 * answer depends on another's tools being present. This is the single source
 * both the runtime adapters (indirectly, via each one's own required-subset
 * config) and the Settings diagnostic (directly, from one probe) are built on.
 */
export function detectCoaiCapabilities(toolNames: readonly string[]): CoaiDetectedCapabilities {
  const present = new Set(toolNames);
  const has = (required: readonly string[]): boolean => required.every((name) => present.has(name));
  const known = new Set<string>(COAI_KNOWN_TOOLS);

  return {
    planReview: has(COAI_PLAN_REVIEW_TOOLS),
    humanEscalation: has(COAI_HUMAN_ESCALATION_TOOLS),
    codeReview: has(COAI_CODE_REVIEW_TOOLS),
    reconciliation: has(COAI_RECONCILIATION_TOOLS),
    unknownToolCount: toolNames.filter((name) => !known.has(name)).length
  };
}
