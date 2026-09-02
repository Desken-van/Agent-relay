/**
 * Claude Code tool-permission rules, and the matching they need.
 *
 * This lives in `shared/domain` because three places need the same answers and
 * none of them may depend on the others: the Claude adapter builds the CLI's
 * `--disallowedTools` list from it, the round policy classifies denials against
 * it, and the renderer may one day need to describe a rule. A copy in any of
 * those would be a second source of truth for a security decision — the kind
 * that stays correct only until someone edits one of them.
 *
 * Everything here is pure and dependency-free: no Node, no Electron, no I/O.
 *
 * Two kinds of matching live side by side, and they lean in opposite
 * directions on purpose:
 *
 * - **Verification matching is strict.** Saying "this call ran the tests" is a
 *   claim that later decides whether unverified work reaches a reviewer, so
 *   anything it cannot prove, it refuses: a compound command, a shell wrapper,
 *   an argument it cannot normalise.
 * - **Destructive-command detection is loose.** Saying "this looks dangerous"
 *   only ever costs a round its clean verdict, so it matches case-insensitively
 *   and inspects every segment of a compound command.
 */

/* -------------------------------------------------------------------------- */
/* Canonical security rules                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Commands Agent Relay refuses when a tool call names them directly, whatever
 * the project settings say. These are the operations the application reserves
 * for its own confirmation dialog, plus the Git commands that could move work
 * out of the worktree the task is isolated in.
 *
 * Direct invocation is the limit of what pattern matching can see; a script that
 * wraps one of these is not matched.
 */
export const DESTRUCTIVE_COMMANDS = [
  'git commit',
  'git push',
  'git reset',
  'git clean',
  'git checkout',
  'git switch',
  'git merge',
  'git rebase',
  'gh'
] as const;

/** Shell-ish tools the deny list has to cover; Windows agents reach for both. */
export const GUARDED_TOOLS = ['Bash', 'PowerShell'] as const;

export type GuardedTool = (typeof GUARDED_TOOLS)[number];

/**
 * Build the fixed deny list.
 *
 * Three spellings per command because Claude Code's rule matching is literal:
 * `Tool(cmd)` catches the bare command, and the two wildcard forms catch it with
 * arguments. Emitting all three costs nothing and avoids depending on which
 * spelling a given CLI version treats as a prefix.
 *
 * The order is part of the contract: it is the order the CLI receives on argv,
 * and a regression test pins it.
 */
export function destructiveToolDenyRules(): string[] {
  const rules: string[] = [];
  for (const tool of GUARDED_TOOLS) {
    for (const command of DESTRUCTIVE_COMMANDS) {
      rules.push(`${tool}(${command})`, `${tool}(${command}:*)`, `${tool}(${command} *)`);
    }
  }
  return rules;
}

/* -------------------------------------------------------------------------- */
/* Command analysis                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Characters that chain, background or pipe one command into another.
 *
 * A line break counts: a `tool_input.command` spanning lines is a script, and
 * nothing here is willing to reason about a script.
 *
 * Scanned without any awareness of quoting, so `--grep="a&b"` is treated as
 * compound too. That is the intended trade: refusing to call a real test run a
 * verification costs a round its clean verdict, while accepting `npm test; git
 * push` as one would let a push through under the name of a test.
 */
const SHELL_OPERATORS = [';', '|', '&', '\n', '\r'] as const;

/**
 * Executables that run *another* command rather than being one.
 *
 * A wrapper hides its payload behind quoting rules this module does not parse,
 * so `cmd /c "npm test"` is never a direct verification call even though the
 * words line up.
 */
const SHELL_WRAPPER_EXECUTABLES = new Set([
  'cmd',
  'command',
  'powershell',
  'pwsh',
  'bash',
  'sh',
  'zsh',
  'dash',
  'ksh',
  'wsl',
  'env',
  'start',
  'nohup',
  'xargs',
  'eval'
]);

/** Windows shim suffixes stripped from an executable so `npm.cmd` is `npm`. */
const EXECUTABLE_SHIM_SUFFIXES = ['.cmd', '.exe'] as const;

export interface CommandAnalysis {
  /** True when the text chains commands, or spans lines. */
  readonly compound: boolean;
  /**
   * Whitespace-normalised command, or null when it is compound or unusable.
   *
   * The executable is lower-cased with a Windows shim suffix removed; the rest
   * keeps its case, because an argument is not a filename and `--grep=Foo` is
   * not `--grep=foo`.
   */
  readonly canonical: string | null;
  /**
   * Each operator-separated part, normalised the same way. One entry for a
   * simple command; empty when there was nothing usable to read.
   */
  readonly segments: readonly string[];
}

const UNUSABLE_COMMAND: CommandAnalysis = { compound: false, canonical: null, segments: [] };

function normaliseExecutable(token: string): string {
  const lower = token.toLowerCase();
  for (const suffix of EXECUTABLE_SHIM_SUFFIXES) {
    if (lower.length > suffix.length && lower.endsWith(suffix)) {
      return lower.slice(0, lower.length - suffix.length);
    }
  }
  return lower;
}

/** Collapse whitespace and normalise the executable, or null when empty. */
function canonicaliseSegment(raw: string): string | null {
  const tokens = raw.trim().split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return null;

  const [executable, ...rest] = tokens;
  if (executable === undefined) return null;

  const head = normaliseExecutable(executable);
  return rest.length === 0 ? head : `${head} ${rest.join(' ')}`;
}

function splitOnOperators(raw: string): string[] {
  let parts = [raw];
  for (const operator of SHELL_OPERATORS) {
    parts = parts.flatMap((part) => part.split(operator));
  }
  return parts;
}

/**
 * Read a raw `tool_input.command` into the form the matchers compare against.
 *
 * Never throws and never guesses: an empty or unreadable command comes back
 * with `canonical: null`, which every caller here treats as "cannot tell".
 */
export function analyseCommand(raw: string | null): CommandAnalysis {
  if (raw === null) return UNUSABLE_COMMAND;

  const compound = SHELL_OPERATORS.some((operator) => raw.includes(operator));
  const segments = splitOnOperators(raw)
    .map((part) => canonicaliseSegment(part))
    .filter((part): part is string => part !== null);

  if (segments.length === 0) return UNUSABLE_COMMAND;
  if (compound) return { compound: true, canonical: null, segments };

  return { compound: false, canonical: segments[0] ?? null, segments };
}

/** True when the command's executable only exists to run another command. */
export function isShellWrapper(canonical: string): boolean {
  const [executable] = canonical.split(' ');
  return executable !== undefined && SHELL_WRAPPER_EXECUTABLES.has(executable);
}

/**
 * True when a canonical segment directly invokes something on the deny list.
 *
 * Case-insensitive on the whole segment, unlike verification matching: over-
 * reporting a command as dangerous only ever costs a clean verdict.
 */
export function namesDestructiveOperation(canonicalSegment: string): boolean {
  const lower = canonicalSegment.toLowerCase();
  return DESTRUCTIVE_COMMANDS.some(
    (command) => lower === command || lower.startsWith(`${command} `)
  );
}

/** True when any part of the command directly invokes a denied operation. */
export function commandTouchesDestructiveOperation(analysis: CommandAnalysis): boolean {
  return analysis.segments.some((segment) => namesDestructiveOperation(segment));
}

/* -------------------------------------------------------------------------- */
/* Rule grammar                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A parsed `Tool(command)` permission rule.
 *
 * The grammar is deliberately smaller than a glob: `Bash(npm test)` matches
 * exactly that command, and `Bash(npm test *)` matches it with any arguments.
 * There is no `*` anywhere but the end, and no character classes — a pattern
 * language rich enough to be surprising is not one to decide permissions with.
 */
export interface ShellToolRule {
  readonly tool: GuardedTool;
  /** Canonical command text the rule matches, with no wildcard. */
  readonly prefix: string;
  /** True when the rule ends in `*` and so accepts trailing arguments. */
  readonly wildcard: boolean;
  /** Normalised `Tool(prefix *)` text; two rules are the same iff these are. */
  readonly canonical: string;
}

const RULE_SHAPE = /^([A-Za-z][A-Za-z0-9_]*)\((.*)\)$/s;

function canonicalTool(name: string): GuardedTool | null {
  const lower = name.toLowerCase();
  return GUARDED_TOOLS.find((tool) => tool.toLowerCase() === lower) ?? null;
}

/**
 * Parse one permission rule, or return null when it is not one this module can
 * reason about.
 *
 * Null covers both "not a shell rule" — `Read(**)` is perfectly valid for the
 * CLI, just not something to verify against — and "malformed". Callers that
 * need to tell those apart check the tool name themselves.
 */
export function parseShellToolRule(rule: string): ShellToolRule | null {
  const text = rule.trim();
  const shape = RULE_SHAPE.exec(text);
  if (shape === null) return null;

  const [, rawTool = '', rawBody = ''] = shape;
  const tool = canonicalTool(rawTool);
  if (tool === null) return null;

  // A rule spanning lines cannot describe a command this module will match.
  if (rawBody.includes('\n') || rawBody.includes('\r')) return null;

  const wildcard = rawBody.endsWith('*');
  const body = wildcard ? rawBody.slice(0, rawBody.length - 1) : rawBody;

  // One trailing star and nothing else. A star in the middle would be a glob,
  // and a glob is a language, not a rule.
  if (body.includes('*')) return null;

  const analysis = analyseCommand(body);
  if (analysis.compound || analysis.canonical === null) return null;

  // A rule whose command is a shell wrapper could never match anything, since
  // the matcher refuses wrappers. Rejecting it here turns a rule that would
  // silently never fire into one the user is told about.
  if (isShellWrapper(analysis.canonical)) return null;

  const prefix = analysis.canonical;
  return {
    tool,
    prefix,
    wildcard,
    canonical: `${tool}(${prefix}${wildcard ? ' *' : ''})`
  };
}

/**
 * Why a rule is unusable, or null when it is fine.
 *
 * `parseShellToolRule` answers "can this be matched against"; this answers "and
 * if not, what should the user change". Kept separate so the parser stays a
 * simple predicate and every caller does not have to build its own diagnosis.
 */
export type RuleProblem =
  /** Not `Tool(command)` at all. */
  | 'syntax'
  /** A tool other than Bash or PowerShell. */
  | 'unsupported_tool'
  /** Nothing between the parentheses. */
  | 'empty_body'
  /** A `*` anywhere but as the single final character. */
  | 'wildcard'
  /** Chained, piped, backgrounded, or spanning lines. */
  | 'compound'
  /** Runs another command — `cmd /c`, `powershell -Command`, and friends. */
  | 'wrapper';

export function describeRuleProblem(rule: string): RuleProblem | null {
  const text = rule.trim();
  const shape = RULE_SHAPE.exec(text);
  if (shape === null) return 'syntax';

  const [, rawTool = '', rawBody = ''] = shape;
  if (canonicalTool(rawTool) === null) return 'unsupported_tool';
  if (rawBody.includes('\n') || rawBody.includes('\r')) return 'compound';

  const wildcard = rawBody.endsWith('*');
  const body = wildcard ? rawBody.slice(0, rawBody.length - 1) : rawBody;
  if (body.includes('*')) return 'wildcard';

  const analysis = analyseCommand(body);
  if (analysis.compound) return 'compound';
  if (analysis.canonical === null) return 'empty_body';
  if (isShellWrapper(analysis.canonical)) return 'wrapper';

  return null;
}

/** True when a tool name refers to the same tool as the rule, ignoring case. */
export function toolMatchesRule(rule: ShellToolRule, tool: string): boolean {
  return rule.tool.toLowerCase() === tool.trim().toLowerCase();
}

/**
 * True when `tool` running `analysis` is exactly what `rule` describes.
 *
 * Refuses anything it cannot read as one plain command: a compound command, a
 * shell wrapper, or text that normalised to nothing. Bash and PowerShell follow
 * identical rules but are never interchangeable — a `Bash(...)` rule does not
 * describe a PowerShell invocation, however alike the command text looks.
 */
export function ruleMatchesCommand(
  rule: ShellToolRule,
  tool: string,
  analysis: CommandAnalysis
): boolean {
  if (!toolMatchesRule(rule, tool)) return false;
  if (analysis.canonical === null) return false;
  if (isShellWrapper(analysis.canonical)) return false;

  if (!rule.wildcard) return analysis.canonical === rule.prefix;

  // A whole-token prefix, so `npm test` and `npm test -- --dot` both match
  // `npm test *`, while `npm testing` does not.
  return (
    analysis.canonical === rule.prefix || analysis.canonical.startsWith(`${rule.prefix} `)
  );
}

/** The first rule in `rules` that describes this call, or null. */
export function findMatchingRule(
  rules: readonly ShellToolRule[],
  tool: string,
  analysis: CommandAnalysis
): ShellToolRule | null {
  return rules.find((rule) => ruleMatchesCommand(rule, tool, analysis)) ?? null;
}

/* -------------------------------------------------------------------------- */
/* Verification configuration                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Verification rules used until Settings gains a field for them.
 *
 * Kept identical to the shipped `DEFAULT_CLAUDE_ALLOWED_TOOLS` by a test rather
 * than by importing it: the two lists mean different things — "may run" is not
 * "proves the work was checked" — and tying them together in code would erase
 * that distinction the first time either default changed.
 */
export const DEFAULT_CLAUDE_VERIFICATION_TOOLS: readonly string[] = [
  'Bash(npm test *)',
  'PowerShell(npm test *)'
];

export type VerificationConfigProblemCode =
  /** No verification rules at all: nothing could ever prove the work was checked. */
  | 'empty'
  /** Not a rule this module can match against. */
  | 'unparsable'
  /** A verification rule the run was never permitted to execute. */
  | 'not_allowed';

export interface VerificationConfigProblem {
  readonly code: VerificationConfigProblemCode;
  /** The offending rule, or null for a problem about the list as a whole. */
  readonly rule: string | null;
  /** For `unparsable`, what specifically is wrong with it. */
  readonly detail: RuleProblem | null;
}

export type VerificationConfig =
  | { readonly ok: true; readonly rules: readonly ShellToolRule[] }
  | { readonly ok: false; readonly problems: readonly VerificationConfigProblem[] };

/**
 * Validate the verification rules against what the run was actually allowed to do.
 *
 * Verification rules are *not* derived from the allowed list. Being permitted to
 * run a command says nothing about whether running it demonstrates the work is
 * correct — `Bash(git status *)` may be perfectly reasonable to allow and proves
 * nothing. But the reverse must hold: a rule that claims to prove something the
 * run was never permitted to do can only ever be denied, so requiring an exact
 * normalised match turns a misconfiguration into a configuration failure instead
 * of a round that can never pass and never says why.
 */
export function resolveVerificationConfig(
  allowedTools: readonly string[],
  verificationTools: readonly string[]
): VerificationConfig {
  const problems: VerificationConfigProblem[] = [];

  if (verificationTools.length === 0) {
    return { ok: false, problems: [{ code: 'empty', rule: null, detail: null }] };
  }

  const allowed = new Set(
    allowedTools
      .map((rule) => parseShellToolRule(rule))
      .filter((rule): rule is ShellToolRule => rule !== null)
      .map((rule) => rule.canonical)
  );

  const rules: ShellToolRule[] = [];
  for (const text of verificationTools) {
    const rule = parseShellToolRule(text);
    if (rule === null) {
      problems.push({ code: 'unparsable', rule: text, detail: describeRuleProblem(text) });
      continue;
    }
    if (!allowed.has(rule.canonical)) {
      problems.push({ code: 'not_allowed', rule: text, detail: null });
      continue;
    }
    rules.push(rule);
  }

  if (problems.length > 0) return { ok: false, problems };
  if (rules.length === 0) {
    return { ok: false, problems: [{ code: 'empty', rule: null, detail: null }] };
  }

  return { ok: true, rules };
}
