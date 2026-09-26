/**
 * How the Ornith instruction contract reads a specification's free text.
 *
 * A fixed, shallow grammar — not an understanding of the text. It separates three things:
 *   - file content: a fenced block introduced by a line naming the file it belongs to;
 *   - clauses: the rest, split at line breaks, list markers and sentence ends;
 *   - directives: the parts of a clause addressed to the implementer — a clause that starts
 *     with a verb, a verb after "you" / "Ornith" / "the implementer" (optionally with a modal),
 *     a verb after "by" ("by running"), or a verb joined by "and" / "then" to a directive.
 * Quoted text ("…", “…”, «…», `…`) never starts a directive but can be one's object. What follows a
 * reporting cue ("tells the operator to …", "describes …") is reported content, not a directive.
 * `ornith-instruction-contract.ts` decides which directives Ornith cannot carry out.
 */

export interface FileContentProblem {
  readonly excerpt: string;
  readonly reason: string;
}

export interface InstructionText {
  /** Clauses outside file-content blocks, in order. */
  readonly clauses: readonly string[];
  /** Fenced blocks that are not file content the contract can recognise. */
  readonly blockProblems: readonly FileContentProblem[];
}

export interface Directive {
  /** Base form of the verb, lower case ("run", "invoke"). */
  readonly verb: string;
  /** The text the verb governs, up to the next directive or reported content (quotes kept). */
  readonly object: string;
}

/** Which words are verbs worth reading as directives, by any of their forms, and which ones start an imperative clause. */
export interface VerbLexicon {
  /** A verb form (lower case) to its base form, for every verb the contract has a rule for or starts an imperative with. */
  readonly baseOf: ReadonlyMap<string, string>;
  /** Base forms whose clause-initial use makes the clause imperative, so verbs joined to it by "and" / "then" are directives too. */
  readonly imperative: ReadonlySet<string>;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** A path with a separator, or a file name with a common extension: what ties a fenced block to its file. */
const FILE_REFERENCE =
  /[\w.-]*\w[\\/][\w./\\-]*\w|\b[\w-][\w.-]*\.(?:md|mdx|txt|json|jsonc|ya?ml|toml|ts|tsx|js|jsx|mjs|cjs|css|scss|html?|sh|ps1|psm1|bat|cmd|py|cs|csproj|rs|go|java|kt|xml|csv|ini|cfg|conf|lock|svg|sql)\b|(?:^|[\s`"'(])\.(?:gitignore|gitattributes|editorconfig|npmrc|nvmrc|env)\b/;

export const EXCERPT_LIMIT = 160;

export function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= EXCERPT_LIMIT ? flat : `${flat.slice(0, EXCERPT_LIMIT - 1)}…`;
}

/** Split one field into clauses outside file-content blocks, and report fenced blocks that are not file content. */
export function readInstructionText(text: string): InstructionText {
  const lines = text.split(/\r?\n/);
  const outside: string[] = [];
  const blockProblems: FileContentProblem[] = [];
  let introduction: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const open = FENCE.exec(line);
    if (open === null) {
      outside.push(line);
      if (line.trim() !== '') introduction = line;
      continue;
    }
    const marker = open[1]!;
    const close = lines.findIndex((candidate, at) => at > index && closesFence(candidate, marker));
    if (close === -1) {
      // Everything after it would otherwise escape the check; read it as instructions instead.
      blockProblems.push({
        excerpt: excerpt(line),
        reason: 'This fenced block is never closed, so nothing marks where file content ends.'
      });
      outside.push(line);
      continue;
    }
    if (introduction === null || !FILE_REFERENCE.test(introduction)) {
      blockProblems.push({
        excerpt: excerpt(introduction ?? lines[index + 1] ?? line),
        reason:
          'A fenced block is file content only on the line after one naming its file (for example "Append to docs/manual-test.md:"); this one names none, so it may be instructions the contract cannot read.'
      });
    }
    outside.push('');
    introduction = null;
    index = close;
  }
  return { clauses: outside.flatMap(splitClauses), blockProblems };
}

function closesFence(line: string, marker: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= marker.length && [...trimmed].every((character) => character === marker[0]);
}

const LINE_MARKER = /^\s*(?:(?:[-*+•]|\d{1,3}[.)]|\(?[a-z][.)]|#{1,6}|>)\s+)+/i;
const ABBREVIATION_END = /\b(?:e\.g|i\.e|etc|vs|cf|approx|incl)\.$/i;

function splitClauses(line: string): string[] {
  const body = line.replace(LINE_MARKER, '');
  const masked = maskQuoted(body);
  const clauses: string[] = [];
  let start = 0;
  for (let index = 0; index < masked.length; index += 1) {
    const character = masked[index]!;
    if (!'.!?;'.includes(character)) continue;
    if (index + 1 < masked.length && !/\s/.test(masked[index + 1]!)) continue;
    if (character === '.' && ABBREVIATION_END.test(masked.slice(0, index + 1))) continue;
    clauses.push(body.slice(start, index + 1));
    start = index + 1;
  }
  clauses.push(body.slice(start));
  return clauses.map((clause) => clause.trim()).filter((clause) => clause !== '');
}

const CLOSER: Readonly<Record<string, string>> = { '`': '`', '"': '"', '“': '”', '«': '»' };

/** A letter in a script other than Latin, outside quotes: instruction text the English grammar cannot read. */
const NON_LATIN_LETTER = /(?!\p{Script=Latin})\p{L}/u;

export function hasUnreadableLetters(clause: string): boolean {
  return NON_LATIN_LETTER.test(maskQuoted(clause));
}

/** The text with the inside of every closed quoted span blanked, same length: quoted words never read as directives. */
export function maskQuoted(text: string): string {
  let masked = '';
  let closer: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (closer !== null) {
      if (character === closer) {
        closer = null;
        masked += character;
      } else {
        masked += ' ';
      }
      continue;
    }
    const expected = CLOSER[character];
    if (expected !== undefined && text.indexOf(expected, index + 1) !== -1) closer = expected;
    masked += character;
  }
  return masked;
}

const LEADING_ADVERBS =
  /^(?:(?:first(?:ly)?|second(?:ly)?|next|then|finally|lastly|also|now|afterwards?|additionally|optionally|please|and|or)\b[,:]?\s+)*/i;
/** A leading subordinate phrase ("After the edit, …", "To verify, …"): the imperative follows its comma. */
const SUBORDINATE = /^(?:after|once|when|whenever|if|before|until|as soon as|in order to|to)\b[^,]{0,120},\s*/i;
const NEGATED_START = /^(?:do\s+not|don['’]t|never|avoid|no\s+need\s+to|not|without)\b/i;
/** Commentary rather than an action ("Note that …"). */
const COMMENTARY = /^(?:note|notice|remember|recall)\s+(?:that|how|whether)\b/i;
const SUBJECT =
  /\b(?:you|ornith|the implementer|the implementing agent|the agent|the model)\s+((?:must|should|shall|will|can|may|needs?\s+to|has\s+to|have\s+to|is\s+to|are\s+to|(?:is|are)\s+(?:expected|required|allowed)\s+to)\s+)?((?:not|never)\s+)?(?:(?:also|then|first|now|still|always|additionally|simply|just)\s+)?([a-z][a-z-]*)/gi;
const BY_GERUND = /\bby\s+([a-z]+ing)\b/gi;
const COORDINATED = /(?:,\s*|\s)(?:and\s+then|and|then|or|before|after\s+that|afterwards|finally|also)\s+([a-z][a-z-]*)\b/gi;
/**
 * From here on, the clause reports what someone else is told, or what a document says: content,
 * not a directive to the implementer.
 */
const REPORTING_CUE =
  /\b(?:tells?|telling|told|instructs?|instructing|instructed|asks?|asking|explains?|explaining|describes?|describing|documents?|documenting|says|saying|states|stating|mentions?|mentioning|reminds?|reminding|guides?|guiding|walks?\s+\S+\s+through|lists|listing|contains?|containing|includes|including)\b|\b(?:the\s+|an?\s+)?(?:operators?|users?|readers?|maintainers?|humans?|reviewers?|testers?|developers?|person|people|someone)\b/gi;

/**
 * Narrower than {@link REPORTING_CUE}, for acceptance criteria: where the words start being
 * addressed to someone else — a step telling the operator, a section explaining how. "Includes",
 * "contains" or "mentions" do not start it: "the handoff includes the run ID" says what the
 * implementer must produce, not what a reader is told.
 */
const ADDRESSED_CUE =
  /\b(?:tells?|telling|told|instructs?|instructing|instructed|asks?|asking|reminds?|reminding|guides?|guiding|walks?\s+\S+\s+through)\b|\b(?:explains?|explaining|describes?|describing|documents?|documenting|shows?|showing)\s+(?:how|where|when|what|why|which)\b|\b(?:steps?|sections?|instructions?|paragraphs?|headings?|items?|bullets?)\s+(?:for|about|on|to|explaining|describing|telling|instructing|asking|reminding)\b|\b(?:the\s+|an?\s+)?(?:operators?|users?|readers?|maintainers?|humans?|reviewers?|testers?|developers?)\b/i;

/** A criterion up to where its words are addressed to someone else (see {@link ADDRESSED_CUE}). */
export function beforeAddressedContent(clause: string): string {
  const cue = ADDRESSED_CUE.exec(maskQuoted(clause));
  return cue === null ? clause : clause.slice(0, cue.index);
}

/** Nouns that start like verbs: "Run IDs are …", "Build output …", "Commit messages …". */
const NOUN_AFTER: Readonly<Record<string, RegExp>> = {
  run: /^\s+(?:ids?|identifiers?|records?|rows?|screen|history|logs?|times?|types?|status|button|number|count)\b/i,
  build: /^\s+(?:output|outputs|steps?|scripts?|artifacts?|system|times?|errors?|logs?|config(?:uration)?)\b/i,
  commit: /^\s+(?:messages?|hash(?:es)?|shas?|ids?|history)\b/i,
  test: /^\s+(?:files?|cases?|suites?|names?|doubles?|helpers?|fixtures?|data|ids?)\b/i,
  check: /^\s+(?:lists?|boxe?s?|marks?)\b/i,
  record: /^\s+(?:types?|shapes?|schemas?|fields?)\b/i,
  log: /^\s+(?:lines?|entries|messages?|files?|levels?)\b/i
};

interface Candidate {
  readonly index: number;
  readonly end: number;
  readonly verb: string;
}

/** The directives in one clause (see the module comment), each with the text it governs. */
export function directivesOf(clause: string, lexicon: VerbLexicon): Directive[] {
  const masked = maskQuoted(clause);
  const candidates: Candidate[] = [];
  const start = clauseStartVerb(masked, lexicon);
  if (start !== null) candidates.push(start);

  for (const match of masked.matchAll(SUBJECT)) {
    const [, modal, negation, word] = match;
    // "You must not run …"; "you do not run" / "cannot run" never parse, as "do" / "cannot" are not verbs here.
    if (negation !== undefined) continue;
    const verb = lexicon.baseOf.get(word!.toLowerCase());
    // After a modal only the base form is a verb ("must run"); without one, "Ornith runs".
    if (verb === undefined || (modal !== undefined && verb !== word!.toLowerCase())) continue;
    const index = match.index + match[0].length - word!.length;
    candidates.push({ index, end: index + word!.length, verb });
  }
  for (const match of masked.matchAll(BY_GERUND)) {
    const verb = lexicon.baseOf.get(match[1]!.toLowerCase());
    if (verb === undefined) continue;
    const index = match.index + match[0].length - match[1]!.length;
    candidates.push({ index, end: index + match[1]!.length, verb });
  }
  const imperative = start !== null || lexicon.imperative.has(firstWord(masked));
  if (imperative || candidates.length > 0) {
    const first = Math.min(...candidates.map((candidate) => candidate.index), start?.index ?? 0);
    for (const match of masked.matchAll(COORDINATED)) {
      const word = match[1]!.toLowerCase();
      const verb = lexicon.baseOf.get(word);
      const index = match.index + match[0].length - match[1]!.length;
      // Only the base form continues an imperative ("… and run"); "and runs" describes something else.
      if (verb === undefined || verb !== word || index <= first) continue;
      candidates.push({ index, end: index + word.length, verb });
    }
  }

  candidates.sort((left, right) => left.index - right.index);
  const cues = [...masked.matchAll(REPORTING_CUE)].map((match) => match.index);
  const directives: Directive[] = [];
  let contentFrom = Number.POSITIVE_INFINITY;
  for (const [position, candidate] of candidates.entries()) {
    if (candidate.index >= contentFrom) break;
    if (position > 0 && candidates[position - 1]!.index === candidate.index) continue;
    const next = candidates[position + 1]?.index ?? masked.length;
    const cue = cues.find((index) => index >= candidate.end && index < next);
    if (cue !== undefined) contentFrom = cue;
    directives.push({ verb: candidate.verb, object: clause.slice(candidate.end, cue ?? next) });
  }
  return directives;
}

function clauseStartVerb(masked: string, lexicon: VerbLexicon): Candidate | null {
  const index = mainClauseStart(masked);
  const rest = masked.slice(index);
  if (NEGATED_START.test(rest) || COMMENTARY.test(rest)) return null;
  const word = /^([A-Za-z][A-Za-z-]*)/.exec(rest)?.[1];
  if (word === undefined) return null;
  const lower = word.toLowerCase();
  const verb = lexicon.baseOf.get(lower);
  // Clause-initial imperatives are base forms; "Runs …" or "Running …" start a description.
  if (verb === undefined || verb !== lower) return null;
  if (NOUN_AFTER[verb]?.test(rest.slice(word.length)) === true) return null;
  return { index, end: index + word.length, verb };
}

function firstWord(masked: string): string {
  return /^([A-Za-z][A-Za-z-]*)/.exec(masked.slice(mainClauseStart(masked)))?.[1]?.toLowerCase() ?? '';
}

function mainClauseStart(masked: string): number {
  const subordinate = SUBORDINATE.exec(masked);
  const afterSubordinate = subordinate?.[0].length ?? 0;
  return afterSubordinate + (LEADING_ADVERBS.exec(masked.slice(afterSubordinate))?.[0].length ?? 0);
}

/** The clause without a leading subordinate phrase or adverb: "After editing, then git add x" → "git add x". */
export function mainClause(clause: string): string {
  return clause.slice(mainClauseStart(maskQuoted(clause)));
}
