/**
 * The Ornith instruction contract: what a specification written for Ornith may tell it to do.
 *
 * Ornith works only through its protocol actions (ORNITH_ACTION_KINDS). A specification is
 * handed to it verbatim, so one that tells it to run a command, use Git beyond git_status /
 * git_diff, operate Agent Relay's UI or IPC, read an Agent Relay run ID or record, start or wait
 * for Agent Relay's own verification, or use file handles, raw bytes, permissions or links asks
 * for something it cannot do. This module decides that, before approval and before every round.
 *
 * WHAT IT GUARANTEES — lexically, not semantically. For "implementationPrompt" and every
 * "acceptanceCriteria" and "suggestedTests" entry, outside file-content blocks:
 *   1. no directive (as `ornith-instruction-text.ts` defines one) pairs an operative verb with a
 *      forbidden object from the tables below, and no directive uses an always-forbidden verb.
 *      That includes bringing about or waiting for Agent Relay's own verification when Agent
 *      Relay is named as the one acting ("Ensure Agent Relay runs its own verification", "Wait
 *      until Agent Relay has verified it");
 *   2. no clause is a bare command line (a command with no outcome stated after it);
 *   3. no acceptance criterion requires an Agent Relay run ID (one tied to Agent Relay or its
 *      verification by the words around it), unless the words are addressed to a reader ("a step
 *      telling the operator to note …"); "includes", "contains" and "mentions" do not exempt it;
 *   4. every fenced block is closed and introduced by a line naming its file;
 *   5. instruction text is in Latin script: the grammar reads English, so a clause in another
 *      script is refused rather than passed unread (quoted words and file content are exempt).
 * WHAT IT DOES NOT: understand meaning. It matches fixed verb and object lists in fixed sentence
 * positions, so an impossible instruction worded outside them passes ("Make sure the change is
 * saved in version control"); so do text inside a file-content block, text after a reporting cue
 * in a directive ("… a handoff that includes the run ID"), and a negated instruction ("do not run
 * …"). It can also refuse a legitimate code instruction that uses the same words ("Read the run ID
 * from the row object"). Outcome statements are never refused: "Agent Relay's verification of the
 * finished change passes" and "`npm run verify` passes" state what must be true afterwards, not
 * something Ornith must do. The runtime protocol stays the hard boundary: whatever a
 * specification says, Ornith cannot run a command or reach Agent Relay.
 */

import type { ImplementationProvider } from './execution-providers';
import {
  beforeAddressedContent,
  directivesOf,
  excerpt,
  hasUnreadableLetters,
  mainClause,
  readInstructionText,
  type VerbLexicon
} from './ornith-instruction-text';
import { ORNITH_ACTION_KINDS } from './ornith';

export type OrnithInstructionField = 'implementationPrompt' | 'acceptanceCriteria' | 'suggestedTests';

export type OrnithInstructionCategory =
  | 'command'
  | 'git'
  | 'relay_ui'
  | 'relay_stage'
  | 'relay_record'
  | 'file_operation'
  | 'network'
  | 'content_block'
  | 'language';

export interface OrnithInstructionViolation {
  readonly field: OrnithInstructionField;
  /** The entry's position for the list fields; null for the implementation prompt. */
  readonly index: number | null;
  readonly category: OrnithInstructionCategory;
  /** The clause that breaks the contract, whitespace-collapsed and bounded. */
  readonly excerpt: string;
  readonly reason: string;
}

/** The fields the contract reads: what Ornith is told to do and to satisfy. */
export interface OrnithInstructions {
  readonly implementationPrompt: string;
  readonly acceptanceCriteria: readonly string[];
  readonly suggestedTests: readonly string[];
}

const REASONS: Readonly<Record<OrnithInstructionCategory, string>> = {
  command:
    'Ornith cannot run commands, scripts, test runners, builds or the app; the only execution it has is its run_verification action.',
  git: 'Ornith has no Git operation except git_status and git_diff: it never commits, stages, switches, resets or publishes.',
  relay_ui:
    "Ornith cannot press, click or invoke anything in Agent Relay's user interface or call its IPC channels; those are the operator's.",
  relay_stage:
    "Agent Relay's own verification is a separate stage after Ornith stops; Ornith never starts, waits for or reads it (it may use its run_verification action).",
  relay_record: "Ornith never sees Agent Relay's run IDs or records, so it cannot capture, read or report them.",
  file_operation:
    'Ornith changes files only through create_file, replace_text and delete_file: no file handles, raw bytes, permissions or links.',
  network: 'Ornith has no network: it cannot download, install, deploy or publish anything.',
  content_block: 'Text Ornith must write into a file goes in a closed fenced block on the line after one naming that file.',
  language:
    'Agent Relay can check instructions to Ornith only in English; quote words in another language, or give such text in a file-content block.'
};

/** Every IPC namespace in `src/shared/ipc.ts` (a test keeps the two in step); a channel is `<namespace>:<name>`. */
export const IPC_NAMESPACES = [
  'settings', 'localInference', 'diagnostics', 'coai', 'codex', 'dialog', 'projects', 'tasks', 'runs',
  'dependencies', 'workflow', 'planReview', 'codeReview', 'git', 'publish', 'shell', 'operations'
] as const;

/** The Run screen's action labels (a test keeps them in step with run guidance). */
export const RELAY_ACTION_LABELS = [
  'Approve for publishing', 'Approve specification', 'Capture and bind rules', 'Continue correction',
  'Continue in a new run', 'Generate specification', 'Prepare isolated review branch', 'Reconcile external state',
  'Regenerate specification', 'Retry in a fresh review session', 'Run external plan review', 'Run verification again',
  'Run verification to diagnose', 'Run verification', 'Send corrections'
] as const;

const words = (...list: string[]): RegExp => new RegExp(`\\b(?:${list.join('|')})\\b`, 'i');
const any = (...patterns: RegExp[]): readonly RegExp[] => patterns;

/* ------------------------------------------------------------------ */
/* Objects                                                             */
/* ------------------------------------------------------------------ */

/** A command line: a known executable with an argument that makes it one. */
const COMMAND_LINE = new RegExp(
  [
    String.raw`\bgit\s+(?:-{1,2}[\w-]+|(?:add|am|apply|bisect|blame|branch|checkout|cherry-pick|clean|clone|commit|config|fetch|gc|grep|init|log|merge|mv|pull|push|rebase|reflog|remote|reset|restore|revert|rm|show|stash|switch|tag|worktree)\b)`,
    String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|ci|add|remove|rm|uninstall|update|up|upgrade|run|run-script|test|t|start|build|exec|x|dlx|publish|pack|link|audit|init|create)\b`,
    String.raw`\b(?:npx|pnpx|bunx)\s+[\w@./-]+`,
    String.raw`\bnode\s+(?:-{1,2}[\w-]+|[\w./\\-]+\.(?:m?js|cjs|ts)\b)`,
    String.raw`\b(?:tsc|eslint|prettier|vitest|jest|mocha|playwright|electron-vite|electron-builder|vite|webpack|tsx|ts-node)\s+(?:run\b|watch\b|-{1,2}[\w-]+|\.(?=\s|$)|[\w./\\-]*\/[\w./\\-]*|[\w-]+\.[\w.]+)`,
    String.raw`\b(?:python3?|py)\s+(?:-[mc]\b|[\w./\\-]+\.py\b)`,
    String.raw`\bpip3?\s+(?:install|uninstall)\b`,
    String.raw`\b(?:bash|sh|zsh|pwsh|powershell|cmd)(?:\.exe)?\s+(?:-c\b|-command\b|-file\b|\/c\b|[\w./\\-]+\.(?:sh|ps1|bat|cmd)\b)`,
    String.raw`\b(?:dotnet|cargo)\s+(?:build|test|run|restore|publish|tool|check|install|new)\b`,
    String.raw`\b(?:curl|wget)\s+\S`,
    String.raw`\b(?:docker|kubectl)\s+[a-z]`,
    String.raw`(?:^|\s)\$\s+\S`
  ].join('|'),
  'i'
);
/** What only running something could satisfy: a test runner or tool named alone, a script file, or a runnable target. */
const RUN_TARGET = any(
  COMMAND_LINE,
  words('tsc', 'eslint', 'prettier', 'vitest', 'jest', 'mocha', 'playwright', 'electron-vite', 'npm', 'npx', 'pnpm', 'yarn', 'node', 'git'),
  /[\w./\\-]+\.(?:sh|bash|ps1|psm1|bat|cmd|py|m?js|cjs)\b/i,
  /^\s*(?:it\b|(?:the|a|all|every|each|any)?\s*(?:(?:full|whole|unit|e2e|end-to-end|integration|new|relevant|existing|affected|focused|targeted|updated|project['’]s|repository['’]s)\s+)*(?:test\s+suites?|tests?|specs?|build|linter|lint|type\s?-?check(?:er|s)?|dev\s+server|server|app|application|electron\s+app|script|scripts|command|commands|benchmarks?|migrations?|formatter)\b)/i
);
const TERMINAL = words('terminal', 'shell', 'command prompt', 'command line', 'console window', 'bash session', 'powershell window');
const BUILDABLE =
  /^\s*(?:it\b|(?:the|a|this|that)?\s*(?:whole\s+)?(?:project|app|application|solution|package|bundle|code\s?base|repo(?:sitory)?|workspace|everything)\b)/i;
const PACKAGE = /\b(?:packages?|dependenc(?:y|ies)|devDependenc(?:y|ies)|modules?|librar(?:y|ies)|SDKs?|tools?|extensions?|plugins?|browsers?)\b|@[\w-]+\/[\w-]+/i;
const RELEASE = words('packages?', 'releases?', 'app', 'application', 'site', 'builds?', 'npm', 'production', 'registry', 'store', 'artifacts?');

const GIT_TARGET = words('branch(?:es)?', 'remote', 'origin', 'upstream', 'HEAD', 'pull request', 'commits?', '--hard', 'main branch', 'master branch', 'into main', 'into master', 'to main', 'to master');
const GIT_ARTIFACT = /\b(?:pull request|git branch|git tag|commits?)\b|\b(?:a|the|new)\s+(?:new\s+)?(?:git\s+)?branch(?=\s*(?:$|[.,;:)]|\s+(?:named|called|for|from|off|to|and|with)\b))/i;
const CHECK_OUT = /^\s*out\s+(?:the\s+|a\s+)?(?:new\s+)?(?:branch|commit|main|master|HEAD|tag|origin|remote)\b/i;

const IPC_CHANNEL = new RegExp(`\\b(?:${IPC_NAMESPACES.join('|')}):[A-Za-z][\\w-]*`);
const RELAY = String.raw`(?:Agent\s+Relay|\bRelay)(?:['’]s)?`;
const LABEL = `(?:${RELAY_ACTION_LABELS.join('|')})`;
const RELAY_UI = any(
  IPC_CHANNEL,
  /\bwindow\.agentRelay\b|\bagentRelay\.\w|\bipc(?:Renderer|Main)\b|\bcontextBridge\b|\bpreload bridge\b/,
  new RegExp(String.raw`${RELAY}(?:\s+[\w"“”'’-]+){0,3}?\s+(?:UI|user interface|interface|app|application|window|screen|buttons?|actions?|menu|panel|dialog|IPC|channels?)\b`),
  /\bRun screen\b/,
  /\b(?:UI|workflow)\s+(?:action|button)s?\b/i,
  new RegExp(String.raw`["“'\`*]*\b${LABEL}\b["”'\`*]*\s+(?:actions?|buttons?)\b`, 'i')
);
/** A label alone, as the object of pressing or clicking: `Press "Run verification"`. */
const RELAY_LABEL = new RegExp(String.raw`["“'\`*]*\b${LABEL}\b`, 'i');
const UI_TARGET = any(...RELAY_UI, RELAY_LABEL, words('buttons?', 'menu', 'menu item', 'options?', 'tabs?', 'checkbox', 'dropdown'));

const RELAY_STAGE = any(
  new RegExp(String.raw`${RELAY}\s+(?:(?:own|separate|later|final|subsequent|post-implementation|operator)\s+)*(?:verification|verify)\b`),
  /\b(?:the|a)\s+(?:separate|later|subsequent|post-implementation|operator['’]s|operator)\s+verification(?:\s+(?:stage|run|step))?\b/i,
  /\bverification\s+(?:stage|workflow)\b/i
);
/** Agent Relay itself acting: "Agent Relay runs its own verification", "Agent Relay to verify". */
const RELAY_ACTS = new RegExp(
  String.raw`(?:Agent\s+Relay|\bRelay)\s+(?:(?:has|have|had|will|would|should|must|can|to|actually|first|then|also|itself)\s+)*(?:re-?runs?|ran|running|runs?|starts?|started|starting|performs?|performed|executes?|executed|triggers?|triggered|launch(?:es|ed)?|completes?|completed|finish(?:es|ed)?|verif(?:y|ies|ied)|checks?|checked|validates?|validated)\b`
);
/** Agent Relay's verification having happened ("… has run", "… is started"). Its passing is an outcome, never matched here. */
const RELAY_STAGE_HAPPENED = new RegExp(
  String.raw`${RELAY}\s+(?:own\s+)?(?:verification|verify)(?:\s+(?:stage|run|step))?\s+(?:has\s+|have\s+|is\s+|was\s+|to\s+)?(?:been\s+)?(?:re-?run|runs?|ran|starts?|started|completes?|completed|finish(?:es|ed)?|executed|triggered|performed|done)\b`
);
/**
 * What a causative verb asks the implementer to bring about, when Agent Relay's own verification
 * is its immediate object: "Ensure Agent Relay runs its own verification", "Make sure Agent Relay
 * has verified …", "Have Agent Relay run …". A subject in between ("Ensure the new button makes
 * Agent Relay run …") describes code, and is not matched.
 */
const CAUSED_RELAY_STAGE = new RegExp(
  String.raw`^\s*(?:sure\s+|certain\s+)?(?:that\s+)?(?:${RELAY_ACTS.source}|${RELAY_STAGE_HAPPENED.source})`
);

const RUN_ID = String.raw`(?:run\s+IDs?|run\s+ids?|runIds?|run_ids?|run\s+identifiers?)`;
/** A run ID that is Agent Relay's by what the text says about it: something only Agent Relay knows. */
const RELAY_RUN_ID = any(
  new RegExp(String.raw`${RELAY}(?:\s+[\w-]+){0,3}?\s+${RUN_ID}\b`),
  new RegExp(String.raw`\b${RUN_ID}\b(?:\s+\S+){0,4}?\s+(?:verification|Relay|action)\b|\b(?:verification|Relay|action)(?:['’]s)?(?:\s+\S+){0,4}?\s+${RUN_ID}\b`, 'i')
);
/** A run ID or record that belongs to Agent Relay by what the text says about it. */
const TIED_RECORD = any(
  ...RELAY_RUN_ID,
  new RegExp(String.raw`${RELAY}(?:\s+[\w-]+){0,3}?\s+(?:records?|timeline|database|DB|history|logs?|runs?|persisted\s+\w+)\b`),
  /\bpersisted\s+(?:results?|records?|outcomes?|runs?)\b/i,
  /\b(?:UI|verification)\s+action(?:['’]s)?\s+(?:results?|records?|outcomes?|output)\b/i,
  /\bverification\s+(?:run\s+)?records?\b/i
);
const BARE_RUN_ID = new RegExp(String.raw`\b${RUN_ID}\b`, 'i');

const FILE_MECHANISM =
  /\b(?:file\s+)?handles?\b|\bfile\s+descriptors?\b|\braw\s+bytes\b|\bbyte\s+stream\b|\bbinary\s+(?:data|content|bytes)\b|\b(?:file|unix|posix|execute|executable|write|read)\s+permissions?\b|\bmode\s+bits\b|\bexecutable(?:\s+bit)?\b|\bsymlinks?\b|\bsymbolic\s+links?\b|\bhard\s+links?\b|\bjunctions?\b|\bfile\s+locks?\b/i;

/* ------------------------------------------------------------------ */
/* Rules: an operative verb, and the object that makes it impossible   */
/* ------------------------------------------------------------------ */

interface Rule {
  readonly category: OrnithInstructionCategory;
  readonly verbs: readonly string[];
  /** Absent: the verb alone is impossible for Ornith, whatever it governs. */
  readonly objects?: readonly RegExp[];
}

const RUN = ['run', 'rerun', 'execute', 'exec', 'launch', 'start', 'spawn'];
const INVOKE = ['invoke', 'call', 'trigger', 'type', 'enter', 'paste', 'use', 'try', 'send', 'emit', 'dispatch', 'request'];
const CHECK = ['verify', 'check', 'test', 'confirm', 'validate'];
/** Taking something in from outside: what Ornith cannot do to Agent Relay's records. */
const OBSERVE = [
  'capture', 'record', 'note', 'copy', 'read', 'fetch', 'query', 'poll', 'wait', 'watch', 'monitor', 'inspect', 'look',
  'observe', 'obtain', 'retrieve', 'report', 'grab', 'collect', 'await'
];
/** Also said of code keeping its own data ("store the run ID in the row"), so these need the record tied to Agent Relay. */
const READ = [...OBSERVE, 'get', 'find', 'locate', 'open', 'save', 'store', 'log'];
/** Bringing something about: here, Agent Relay's own verification, which only the operator and Agent Relay start. */
const CAUSE = ['ensure', 'make', 'have', 'get', 'let', 'cause', 'arrange', 'request', 'ask', 'require', 'force'];
const WAIT = ['wait', 'await', 'poll', 'watch', 'monitor'];

const RULES: readonly Rule[] = [
  { category: 'git', verbs: ['commit', 'stage', 'unstage', 'stash', 'rebase', 'cherry-pick', 'amend', 'squash'] },
  { category: 'git', verbs: ['push', 'pull', 'fetch', 'merge', 'checkout', 'switch', 'reset', 'revert', 'clone'], objects: [GIT_TARGET] },
  { category: 'git', verbs: ['create', 'open', 'make', 'delete'], objects: [GIT_ARTIFACT] },
  { category: 'git', verbs: ['check'], objects: [CHECK_OUT] },
  { category: 'relay_ui', verbs: ['press', 'click', 'tap', 'hit'] },
  { category: 'relay_ui', verbs: ['select', 'choose'], objects: UI_TARGET },
  { category: 'relay_record', verbs: READ, objects: TIED_RECORD },
  { category: 'relay_record', verbs: OBSERVE, objects: [BARE_RUN_ID] },
  { category: 'relay_stage', verbs: [...RUN, ...INVOKE, ...CHECK, ...READ], objects: RELAY_STAGE },
  { category: 'relay_stage', verbs: CAUSE, objects: [CAUSED_RELAY_STAGE] },
  { category: 'relay_stage', verbs: WAIT, objects: [RELAY_ACTS, RELAY_STAGE_HAPPENED] },
  { category: 'relay_ui', verbs: [...RUN, ...INVOKE, 'open'], objects: RELAY_UI },
  { category: 'command', verbs: RUN, objects: RUN_TARGET },
  { category: 'command', verbs: [...INVOKE, ...CHECK], objects: [COMMAND_LINE] },
  { category: 'command', verbs: ['open', 'use', 'launch', 'start'], objects: [TERMINAL] },
  { category: 'command', verbs: ['build', 'compile', 'lint', 'typecheck'], objects: [BUILDABLE] },
  { category: 'file_operation', verbs: ['seek', 'flush', 'chmod', 'chown', 'symlink', 'truncate', 'mount', 'unmount'] },
  {
    category: 'file_operation',
    verbs: ['open', 'close', 'append', 'write', 'read', 'lock', 'unlock', 'set', 'make', 'create', 'add', 'use', 'keep', 'change'],
    objects: [FILE_MECHANISM]
  },
  { category: 'network', verbs: ['download', 'upload'] },
  { category: 'network', verbs: ['install', 'uninstall', 'reinstall'], objects: [PACKAGE] },
  { category: 'network', verbs: ['deploy', 'publish', 'release'], objects: [RELEASE] }
];

/** Verbs that begin an imperative clause without a rule of their own, so "Update X and run Y" is read as instructions. */
const IMPERATIVE_STARTERS = [
  'add', 'append', 'insert', 'prepend', 'create', 'write', 'replace', 'change', 'update', 'edit', 'modify', 'rename', 'move',
  'delete', 'remove', 'fix', 'implement', 'refactor', 'extend', 'keep', 'preserve', 'leave', 'read', 'inspect', 'review',
  'search', 'find', 'list', 'locate', 'look', 'open', 'document', 'describe', 'mention', 'explain', 'set', 'make', 'ensure',
  'adjust', 'define', 'declare', 'export', 'import', 'return', 'handle', 'wire', 'register', 'reuse', 'follow', 'match'
];

const DOUBLED = new Set(['run', 'rerun', 'commit', 'tap', 'get', 'set', 'hit', 'grab', 'emit', 'log', 'submit']);

function formsOf(base: string): string[] {
  if (base.includes('-')) return [base];
  const third = /(?:s|sh|ch|x|z|o)$/.test(base) ? `${base}es` : /[^aeiou]y$/.test(base) ? `${base.slice(0, -1)}ies` : `${base}s`;
  const gerund = DOUBLED.has(base)
    ? `${base}${base.at(-1)!}ing`
    : /[^e]e$/.test(base)
      ? `${base.slice(0, -1)}ing`
      : `${base}ing`;
  return [base, third, gerund];
}

const LEXICON: VerbLexicon = (() => {
  const bases = new Set([...RULES.flatMap((rule) => rule.verbs), ...IMPERATIVE_STARTERS]);
  const baseOf = new Map<string, string>();
  for (const base of bases) for (const form of formsOf(base)) if (!baseOf.has(form)) baseOf.set(form, base);
  return { baseOf, imperative: new Set(bases) };
})();

/** Ornith's own actions, and the Git reads it has, never count against it. */
const ORNITH_ACTIONS = new RegExp(`\\b(?:${ORNITH_ACTION_KINDS.join('|')})\\b|\\bgit[\\s_]+(?:status|diff)\\b`, 'gi');

function breaksRule(verb: string, object: string): OrnithInstructionCategory | null {
  const allowed = object.replace(ORNITH_ACTIONS, 'ornith-action');
  for (const rule of RULES) {
    if (!rule.verbs.includes(verb)) continue;
    if (rule.objects === undefined || rule.objects.some((pattern) => pattern.test(allowed))) return rule.category;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Clauses that are not directives                                      */
/* ------------------------------------------------------------------ */

/** Something stated about a command, not the command alone: "`npm run verify` passes". */
const STATEMENT =
  /\b(?:is|are|was|were|has|have|had|must|should|will|would|stays?|remains?|returns?|exits?|pass(?:es)?|succeeds?|fails?|reports?|shows?|prints?|produces?|completes?|works?|finds?)\b/i;
const LEADING_CODE_SPAN = /^[`"“]([^`"”]+)[`"”](.*)$/s;

/** A command given on its own — a code span or a `$ ` prompt, or a line that starts with one — with nothing stated about it. */
function isBareCommandLine(clause: string): boolean {
  const text = mainClause(clause).replace(/[.;:!?]+$/, '').trim();
  if (/^\$\s+\S/.test(text)) return true;
  const span = LEADING_CODE_SPAN.exec(text);
  const command = span?.[1] ?? text;
  const rest = span?.[2] ?? '';
  if (!COMMAND_LINE.test(command) || command.search(COMMAND_LINE) > 0) return false;
  if (span === null) {
    // Unquoted: a line that is only the command and its arguments.
    return !STATEMENT.test(text.slice(text.search(COMMAND_LINE)));
  }
  return !STATEMENT.test(rest);
}

/* ------------------------------------------------------------------ */
/* The check                                                           */
/* ------------------------------------------------------------------ */

function checkField(
  field: OrnithInstructionField,
  index: number | null,
  text: string
): OrnithInstructionViolation[] {
  const violation = (category: OrnithInstructionCategory, clause: string, reason = REASONS[category]): OrnithInstructionViolation => ({
    field,
    index,
    category,
    excerpt: excerpt(clause),
    reason
  });
  const { clauses, blockProblems } = readInstructionText(text);
  const found = blockProblems.map((problem) => violation('content_block', problem.excerpt, problem.reason));
  // Refused, not passed unread: the grammar below reads English only. Once per field is enough.
  const unreadable = clauses.find(hasUnreadableLetters);
  if (unreadable !== undefined) found.push(violation('language', unreadable));
  for (const clause of clauses) {
    const category =
      directivesOf(clause, LEXICON)
        .map((directive) => breaksRule(directive.verb, directive.object))
        .find((result) => result !== null) ?? null;
    if (category !== null) {
      found.push(violation(category, clause));
    } else if (isBareCommandLine(clause)) {
      found.push(
        violation(
          'command',
          clause,
          'A command on its own is an instruction to run it, which Ornith cannot do; state the outcome instead, for example that Agent Relay\'s verification of the finished change passes.'
        )
      );
    } else if (field === 'acceptanceCriteria' && RELAY_RUN_ID.some((pattern) => pattern.test(beforeAddressedContent(clause)))) {
      // An outcome Agent Relay records ("its verification record shows passed") is fine: Ornith
      // need not see it. A run ID it would have to produce is not: only Agent Relay knows it —
      // "the handoff includes the run ID of Agent Relay's verification". Words addressed to a
      // reader ("a step telling the operator to note the run ID") are content, and pass.
      found.push(
        violation(
          'relay_record',
          clause,
          "An acceptance criterion cannot require an Agent Relay run ID, which only Agent Relay knows; require that Agent Relay's verification of the finished change passes instead."
        )
      );
    }
  }
  return found;
}

/** Every place the specification tells Ornith to do something its protocol cannot, in field order. */
export function ornithInstructionViolations(instructions: OrnithInstructions): OrnithInstructionViolation[] {
  return [
    ...checkField('implementationPrompt', null, instructions.implementationPrompt),
    ...instructions.acceptanceCriteria.flatMap((entry, index) => checkField('acceptanceCriteria', index, entry)),
    ...instructions.suggestedTests.flatMap((entry, index) => checkField('suggestedTests', index, entry))
  ];
}

const FIELD_NAMES: Readonly<Record<OrnithInstructionField, string>> = {
  implementationPrompt: 'Implementation prompt',
  acceptanceCriteria: 'Acceptance criterion',
  suggestedTests: 'Suggested test'
};

export function describeOrnithInstructionViolation(violation: OrnithInstructionViolation): string {
  const where = violation.index === null ? FIELD_NAMES[violation.field] : `${FIELD_NAMES[violation.field]} ${violation.index + 1}`;
  return `${where}: "${violation.excerpt}" — ${violation.reason}`;
}

/** One paragraph naming the first few violations. */
export function describeOrnithInstructionViolations(violations: readonly OrnithInstructionViolation[]): string {
  const shown = violations.slice(0, 3).map(describeOrnithInstructionViolation).join(' ');
  const more = violations.length > 3 ? ` (and ${violations.length - 3} more)` : '';
  return `The specification tells Ornith to do something its protocol cannot. ${shown}${more}`;
}

function readInstructions(specificationJson: string): OrnithInstructions | null {
  try {
    const value: unknown = JSON.parse(specificationJson);
    if (typeof value !== 'object' || value === null) return null;
    const { implementationPrompt, acceptanceCriteria, suggestedTests } = value as Record<string, unknown>;
    const strings = (list: unknown): list is string[] => Array.isArray(list) && list.every((entry) => typeof entry === 'string');
    if (typeof implementationPrompt !== 'string' || !strings(acceptanceCriteria) || !strings(suggestedTests)) return null;
    return { implementationPrompt, acceptanceCriteria, suggestedTests };
  } catch {
    return null;
  }
}

/**
 * Why a task's stored specification cannot be handed to its implementer as it stands, or null.
 * Only Ornith has the contract; an unreadable specification is another check's to refuse.
 */
export function ornithInstructionProblem(task: {
  readonly specificationJson: string | null;
  readonly implementationProvider: ImplementationProvider;
}): string | null {
  if (task.implementationProvider !== 'ornith' || task.specificationJson === null) return null;
  const instructions = readInstructions(task.specificationJson);
  if (instructions === null) return null;
  const violations = ornithInstructionViolations(instructions);
  return violations.length === 0 ? null : describeOrnithInstructionViolations(violations);
}

/** The contract as the specifier, the reviser and the plan reviewer are told it. */
export const ORNITH_INSTRUCTION_CONTRACT = `- Agent Relay checks the finished text before approval and before every round, and refuses a
  specification that breaks these rules. Tell Ornith only what to read, search, create, replace or
  delete; to have the project's verification run inside its loop, name its run_verification action.
- Never tell it to run a command, script, test runner, build or the app; to use Git beyond
  git_status and git_diff; to press, click or invoke anything in Agent Relay or call an IPC channel;
  to capture, read or report an Agent Relay run ID or record; to start, wait for or read Agent
  Relay's own verification; or to use file handles, raw bytes, permissions or links.
- Text Ornith must write into a file verbatim — above all, steps for the operator that mention
  commands or Agent Relay's UI — goes in a fenced block on the line right after one naming the
  file (for example "Append to docs/manual-test.md:"). Outside such blocks, describe it as what
  the file tells the operator ("a step telling the operator to press Run verification").
- Acceptance criteria state outcomes: they may require that Agent Relay's verification of the
  finished change passes, never an Agent Relay run ID, which only Agent Relay knows.
- Write "implementationPrompt", "acceptanceCriteria" and "suggestedTests" in English, whatever the
  request's language: Agent Relay can check only English. Put a word in another language in quotes
  («…» or "…"), and longer text Ornith must write in a file-content block.`;
