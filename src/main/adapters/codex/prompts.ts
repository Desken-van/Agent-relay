/**
 * Prompt construction for the two Codex roles and the Claude implementer.
 *
 * These are plain string builders with no I/O so they can be unit tested, and
 * so the exact text sent to a model is reviewable in one place rather than
 * scattered through the orchestrator.
 */

import type { GitChangeSet } from '../../../shared/domain/git';
import type { AcceptedPlanFinding } from '../../../shared/domain/plan-correction';
import type { VerificationRecord } from '../../../shared/domain/verification';
import type { CodexReviewResult, TaskSpecification, TriageRefKind } from '../../../shared/schemas/codex';
import type { TriageableDecision, TriageableFinding } from '../../ports';

/* -------------------------------------------------------------------------- */
/* Codex: specification                                                        */
/* -------------------------------------------------------------------------- */

/**
 * What a specification may ask for as verification evidence. Agent Relay persists a bounded record of its
 * own verification and never the command's raw output (docs/security.md), so a specification demanding that
 * the "actual" or full output be stored in Relay could never be satisfied. Shared by generation and revision.
 */
const VERIFICATION_EVIDENCE_RULE = `- Verification evidence: where the specification asks for proof that the project's checks pass
  (in "acceptanceCriteria", "suggestedTests" or "implementationPrompt"), require Agent Relay's own
  verification — its "Run verification" action, which runs \`npm run verify\` in the task worktree —
  and the record Agent Relay persists for that run: its exit code and classified outcome (passed,
  failed, timed_out or cancelled) and, for a failed run, its failure kind and the bounded, sanitized
  output summary where one is available. Agent Relay deliberately never stores a command's raw
  stdout/stderr or a complete log, so no acceptance criterion, constraint, suggested test or
  instruction may require the actual, full or raw command output to be stored in, attached to, or
  shown by Agent Relay.`;

export interface SpecificationPromptInput {
  readonly projectPath: string;
  readonly taskTitle: string;
  readonly originalRequest: string;
  readonly ruleEvidence?: string;
}

export function buildSpecificationPrompt(input: SpecificationPromptInput): string {
  return `You are the SPECIFIER in a two-agent relay. You do not write the code; a separate
coding agent will implement whatever you specify, working alone, in an
isolated Git worktree, with no ability to ask you follow-up questions.

Repository under discussion: ${input.projectPath}
You have read-only access. Inspect the repository before specifying anything: read the
build files, the existing tests, and the code the task touches, so your specification
matches how this project is actually written rather than how a generic project is.

TASK TITLE
${input.taskTitle}

USER'S REQUEST (verbatim)
${input.originalRequest}

${input.ruleEvidence ? `=== IMMUTABLE PROJECT RULE EVIDENCE ===\n${input.ruleEvidence}\n` : ''}

Produce a single JSON object matching the required schema, with these rules:

- "acceptanceCriteria" must be objectively checkable. "Works correctly" is not a
  criterion; "GET /health returns 200 with {status:'ok'}" is.
- "assumptions" must list every place the request was ambiguous and you chose an
  interpretation. If you assumed nothing, use an empty array — do not invent filler.
- "constraints" must name what the implementer must NOT change, including any public
  API, file, or behaviour that existing tests depend on.
- "suggestedTests" must name concrete tests, with the file they belong in where you can
  tell, and must fit the test framework this repository already uses.
- "implementationPrompt" is the single most important field. It is handed verbatim to
  the coding agent. Make it complete and self-contained: what to change, which files are
  involved, the expected end state, and how to verify it. Do not address the user in it;
  address the implementer.
- "scopedFilePaths" must always be present. When you are confident the ENTIRE implementation
  stays within a small, explicit list of existing repository-relative file paths (for example,
  a documentation-only edit to one named file), provide every one of them, using forward
  slashes relative to the repository root. This is a discovery hint for the implementing
  agent, not an access restriction — it lets the agent read the named file(s) directly
  instead of first scanning the whole repository to find them. Otherwise return an empty
  array ([]) — whenever more than a few files might be touched, a new file might need to be
  created, or you are not fully certain of the exact set of paths. Never omit the field.
${VERIFICATION_EVIDENCE_RULE}

Scope discipline: specify the change the user asked for. Do not add refactors, upgrades,
or "while we're here" improvements.

Return only the JSON object.`;
}

/* -------------------------------------------------------------------------- */
/* Codex: specification revision from accepted plan-review findings           */
/* -------------------------------------------------------------------------- */

export interface SpecificationRevisionPromptInput {
  readonly projectPath: string;
  readonly taskTitle: string;
  readonly originalRequest: string;
  readonly currentSpecification: TaskSpecification;
  readonly acceptedFindings: readonly AcceptedPlanFinding[];
  readonly ruleEvidence?: string;
  readonly round: number;
  readonly maxRounds: number;
}

function renderAcceptedFinding(finding: AcceptedPlanFinding): string {
  const location = finding.file
    ? `${finding.file}${finding.line > 0 ? `:${finding.line}` : ''}`
    : '(no specific location)';
  // Named by the round's own number, which is what the answer must use to say
  // where each one was addressed.
  return `Finding ${finding.finding}. [${finding.severity} · ${finding.category}] ${finding.title}
   Location: ${location}
   Why it matters: ${finding.why}
   Required correction: ${finding.fix}${
     finding.operatorNote.trim().length > 0 ? `\n   Operator note: ${finding.operatorNote.trim()}` : ''
   }`;
}

/**
 * The revision prompt. Everything the model may use is in it: the original
 * request, the specification being revised, the immutable rule evidence and the
 * ACCEPTED findings. Rejected findings are never included, and the model is told
 * so, because "revise the plan" must not become "rewrite the plan".
 */
export function buildSpecificationRevisionPrompt(input: SpecificationRevisionPromptInput): string {
  return `You are the SPECIFIER in a two-agent relay, revising a specification you wrote earlier.
An independent external reviewer read it and raised findings. The operator ACCEPTED the
findings listed below as valid correction requirements. You are in READ-ONLY mode: you
must not modify, create, or delete any file, and you must not run a command that changes
state. You may read the repository to make the revision accurate.

Repository under discussion: ${input.projectPath}
This is correction round ${input.round} of at most ${input.maxRounds}.

TASK TITLE
${input.taskTitle}

USER'S ORIGINAL REQUEST (verbatim) — the revision must stay faithful to this
${input.originalRequest}

${input.ruleEvidence ? `=== IMMUTABLE PROJECT RULE EVIDENCE ===\n${input.ruleEvidence}\n` : ''}

=== THE CURRENT SPECIFICATION (revise this; do not start over) ===
${JSON.stringify(input.currentSpecification, null, 2)}

=== ACCEPTED FINDINGS — the ONLY corrections you are asked to make ===
${input.acceptedFindings.map(renderAcceptedFinding).join('\n\n')}

Produce a single JSON object matching the required schema, with two parts:
- "specification": the COMPLETE revised specification, every field present.
- "addressed": one entry for every (accepted finding, changed field) PAIR. Each entry gives the
  finding's number exactly as listed ("Finding N" is N), ONE specification field you changed
  for it, and one or two sentences saying what you changed in that field for that finding.
  - A finding that required changes to several fields gets one entry per field, repeating the
    same finding number: a finding addressed in "constraints" and in "implementationPrompt" is
    two entries, both with its number.
  - A field changed for several findings gets one entry per finding. The field itself still
    appears once in "specification"; one edit may serve several findings, and each entry's
    change says what that edit does for its finding.
  - Every accepted finding appears in at least one entry, and every field whose value differs
    from the current specification appears in at least one entry. Name only fields that really
    differ.
  Before answering, compare each field of your revised specification with the current one and
  check both rules. The whole revision is refused, and nothing is stored, when an accepted
  finding has no entry, when an entry names a field that did not change or a finding that was
  not accepted, or when a field changed without an entry tying it to an accepted finding — that
  is an unrequested change.

Rules for the revision:

- Address every accepted finding in the specification itself — in the summary, the
  acceptance criteria, the constraints, the suggested tests and, above all, the
  "implementationPrompt", which is handed verbatim to the coding agent. A finding that is
  only mentioned but not reflected in what the implementer will be told is not addressed.
- Change only what the accepted findings require. Keep every other part of the
  specification, including its wording, unless a finding makes it wrong. Do not add
  refactors, upgrades or "while we're here" improvements, and do not act on findings that
  are not listed above — other findings were rejected on purpose.
- Preserve the user's original intent and every project rule above. A correction must never
  relax a constraint, widen the scope beyond the original request, or remove an acceptance
  criterion the user's request depends on.
- Acceptance criteria stay objectively checkable.
- "scopedFilePaths" must always be present, following the same rule as before: a small
  explicit list only when the whole implementation is confidently confined to it, else [].
${VERIFICATION_EVIDENCE_RULE}
  This holds for the accepted findings too: a finding that asks for such output is addressed
  by requiring that persisted record instead.

Return only the JSON object.`;
}

/* -------------------------------------------------------------------------- */
/* Codex: review                                                               */
/* -------------------------------------------------------------------------- */

export interface ReviewPromptInput {
  readonly specification: TaskSpecification;
  readonly changes: GitChangeSet;
  readonly claudeReport: string;
  readonly testOutput: string;
  readonly relayVerification?: VerificationRecord;
  readonly round: number;
  readonly maxRounds: number;
  readonly ruleEvidence?: string;
}

export function buildReviewPrompt(input: ReviewPromptInput): string {
  const { specification, changes } = input;

  const fileList =
    changes.changedFiles.length > 0
      ? changes.changedFiles
          .map(
            (file) =>
              `  ${file.status.padEnd(4)} ${file.path}${
                file.binary ? ' (binary)' : ` (+${file.insertions ?? 0}/-${file.deletions ?? 0})`
              }`
          )
          .join('\n')
      : '  (no files changed)';

  const commits =
    changes.recentCommits.length > 0
      ? changes.recentCommits.map((line) => `  ${line}`).join('\n')
      : '  (no commits — changes are uncommitted in the worktree, which is expected)';

  const relayVerification = input.relayVerification
    ? `=== AGENT RELAY VERIFICATION OF THE CURRENT CODE SNAPSHOT ===
Agent Relay itself ran: ${input.relayVerification.command}
Result: PASSED
Exit code: ${input.relayVerification.exitCode}
Duration: ${input.relayVerification.durationMs} ms
Snapshot identity: ${input.relayVerification.identity}

Agent Relay confirmed immediately before this review that this successful record still
matches the current task inputs and files. This evidence is authoritative for whether
the configured verification command passed. If the historical implementer report below
describes an earlier failed, blocked, or unavailable verification attempt, treat that
statement as historical: do not raise a failed-or-missing-verification finding solely
from the older report. You may still report concrete defects in the code or inadequacy
of the configured verification coverage.
`
    : '';

  return `You are the REVIEWER in a two-agent relay. You are in READ-ONLY mode: you must not
modify, create, or delete any file, and you must not run commands that change state.
Your entire output is a single JSON object matching the required schema.

This is review round ${input.round} of at most ${input.maxRounds}.

${input.ruleEvidence ? `=== IMMUTABLE PROJECT RULE EVIDENCE ===\n${input.ruleEvidence}\n` : ''}

=== THE ACCEPTED SPECIFICATION ===
Title: ${specification.title}

Summary:
${specification.summary}

Acceptance criteria:
${specification.acceptanceCriteria.map((c, i) => `  ${i + 1}. ${c}`).join('\n')}

Constraints:
${specification.constraints.length > 0 ? specification.constraints.map((c) => `  - ${c}`).join('\n') : '  (none stated)'}

Assumptions the specification made:
${specification.assumptions.length > 0 ? specification.assumptions.map((a) => `  - ${a}`).join('\n') : '  (none stated)'}

Tests the specification suggested:
${specification.suggestedTests.length > 0 ? specification.suggestedTests.map((t) => `  - ${t}`).join('\n') : '  (none suggested)'}

${relayVerification}
=== WHAT THE IMPLEMENTER REPORTED ===
${input.claudeReport.trim() || '(the implementer returned no final report)'}

=== TEST / COMMAND OUTPUT COLLECTED ===
${input.testOutput.trim() || '(no test output was captured)'}

=== CHANGED FILES ===
${fileList}

=== WORKING TREE STATUS (git status --short) ===
${changes.statusShort.trim() || '(clean)'}

=== DIFF STAT ===
${changes.diffStat.trim() || '(empty)'}

=== COMMITS ON THE TASK BRANCH ===
${commits}

=== FULL DIFF ===
${changes.diff.trim() || '(empty)'}
${changes.diffTruncated ? '\n[NOTE] The diff above was truncated. Judge only what you can see, and say so in your summary if that limits your confidence.' : ''}

=== HOW TO DECIDE ===
Judge the implementation against the specification above, and against the real code in
the worktree, which you may read.

verdict = "approved"
  Every acceptance criterion is met, no constraint is violated, and you found no
  correctness, security, or data-loss problem. Cosmetic nits alone do not block.

verdict = "changes_requested"
  There are specific, fixable problems. Every finding must be actionable.

verdict = "blocked"
  The approach itself is wrong and iterating on it will not help, or the diff is empty
  when it should not be, or something in the change is unsafe to proceed with.

Rules for findings:
- Report only real problems you can point at. Do not pad the list.
- Set "file" and "line" whenever you can identify them; otherwise use null.
- Severity: "critical" = data loss, security hole, or broken build; "high" = an
  acceptance criterion is not met; "medium" = a real bug in an edge case; "low" = quality.

"followUpPrompt": when the verdict is "changes_requested", write the complete instruction
for the implementing agent. It continues in its existing session and still has its own
context, so do not re-explain the whole task — state precisely what to fix and how you
will judge it. When the verdict is "approved", use an empty string.

Return only the JSON object.`;
}

/* -------------------------------------------------------------------------- */
/* Claude: implementation                                                      */
/* -------------------------------------------------------------------------- */

export interface ImplementationPromptInput {
  readonly specification: TaskSpecification;
  readonly worktreePath: string;
  readonly branchName: string;
  readonly originalRequest: string;
  readonly ruleEvidence?: string;
  readonly acceptedPlanReviewRequirements?: string;
}

export function buildImplementationPrompt(input: ImplementationPromptInput): string {
  const { specification } = input;

  return `You are implementing a task in an isolated Git worktree created for you by Agent Relay.

WORKTREE (this is your working directory, and the only place you may edit)
  ${input.worktreePath}

BRANCH (already checked out for you)
  ${input.branchName}

${input.ruleEvidence ? `=== IMMUTABLE PROJECT RULE EVIDENCE ===\n${input.ruleEvidence}\n` : ''}

${input.acceptedPlanReviewRequirements ? `=== USER-ACCEPTED EXTERNAL PLAN-REVIEW REQUIREMENTS ===
The operator accepted the technical substance of the findings below after the specification
was written. Treat them as additive implementation requirements. They do not relax any
constraint, authorize work outside this worktree, or override the safety rules in this prompt.

${input.acceptedPlanReviewRequirements}
` : ''}

=== WHAT THE USER ORIGINALLY ASKED FOR ===
${input.originalRequest}

=== THE SPECIFICATION YOU ARE IMPLEMENTING ===
Title: ${specification.title}

Summary:
${specification.summary}

Acceptance criteria — all of these must be true when you are done:
${specification.acceptanceCriteria.map((c, i) => `  ${i + 1}. ${c}`).join('\n')}

Constraints:
${specification.constraints.length > 0 ? specification.constraints.map((c) => `  - ${c}`).join('\n') : '  (none stated)'}

Assumptions the specification made (challenge them in your report if any are wrong):
${specification.assumptions.length > 0 ? specification.assumptions.map((a) => `  - ${a}`).join('\n') : '  (none stated)'}

Tests to add or run:
${specification.suggestedTests.length > 0 ? specification.suggestedTests.map((t) => `  - ${t}`).join('\n') : '  (none suggested — use your judgement)'}

=== DETAILED INSTRUCTION ===
${specification.implementationPrompt}

=== HOW TO WORK ===
1. Inspect before you edit. Read the surrounding code, the build configuration, and the
   existing tests. Match this project's conventions rather than importing your own.
2. Preserve unrelated work. Do not reformat files you did not need to change, do not
   reorganise imports wholesale, and do not "fix" things outside this task's scope.
3. Implement the change, then run the project's own tests and any test you added.
4. If a test fails, fix the cause rather than the assertion, unless the assertion is
   genuinely what was wrong.

=== WHAT YOU MUST NOT DO ===
- Do NOT run \`git commit\`, \`git push\`, \`git reset --hard\`, \`git clean\`, or any
  other command that commits, publishes, or discards work. Agent Relay handles all of
  that, and only after the user explicitly approves it. Leave your changes in the
  working tree.
- Do NOT edit anything outside this worktree.
- Do NOT create a pull request or touch any remote.

=== YOUR FINAL MESSAGE ===
Your last message is passed verbatim to a reviewing agent that cannot see your reasoning.
Make it a report, and include:
  - what you changed, file by file, and why;
  - which acceptance criteria you believe are met, and how you verified each;
  - the exact test commands you ran and their results (paste the meaningful output);
  - anything you could not do, deliberately deferred, or are unsure about;
  - any assumption in the specification that turned out to be wrong.
Be accurate rather than reassuring. If something does not work, say so plainly.`;
}

/* -------------------------------------------------------------------------- */
/* Claude: correction round                                                    */
/* -------------------------------------------------------------------------- */

export interface CorrectionPromptInput {
  readonly review: CodexReviewResult;
  readonly round: number;
  readonly maxRounds: number;
  readonly ruleEvidence?: string;
}

/**
 * The prompt for a round whose only job is to make the verification pass.
 *
 * Distinct from a correction prompt because there is no review to act on: the
 * reviewer was satisfied, and it was the evidence that fell short. Telling
 * Claude to "address the findings" when there are none would invite it to
 * invent some.
 */
export function buildVerificationRetryPrompt(input: {
  readonly reason: string;
  readonly round: number;
  readonly maxRounds: number;
  readonly ruleEvidence?: string;
}): string {
  return `Your implementation was reviewed and approved, but it cannot be published yet.

This is round ${input.round} of at most ${input.maxRounds}.

${input.ruleEvidence ? `=== IMMUTABLE PROJECT RULE EVIDENCE ===\n${input.ruleEvidence}\n` : ''}

=== WHY ===
${input.reason}

=== WHAT TO DO ===
Make the project's verification command pass, and run it. Do not change the
behaviour that was already approved beyond what is needed for the checks to
succeed. If the checks reveal a real defect, fix the defect rather than the
check.

Keep working in the same worktree on the same branch. The same rules still apply:
do not commit, do not push, do not touch any remote, do not modify anything
outside this worktree, and do not discard or revert unrelated work already there.

End your reply with a short summary of what you changed, the exact verification
command you ran, and its result.`;
}

/** Continue an implementation using the output from Relay's own failed check. */
export function buildVerificationFailurePrompt(input: {
  readonly command: string;
  readonly reason: string;
  readonly output: string;
}): string {
  return `Agent Relay independently verified the saved files and the verification failed.

Continue the existing implementation in the same worktree. Do not restart the task or
rewrite working code. Diagnose and fix the failures shown below, then run the project's
verification command again.

=== RELAY VERIFICATION COMMAND ===
${input.command}

=== RELAY VERIFICATION RESULT ===
${input.reason}

=== STORED COMMAND OUTPUT ===
${input.output || '(No command output was stored.)'}

The original specification and all earlier safety rules still apply. Do not commit, push,
touch a remote, edit outside the worktree, or discard unrelated work. If the output reveals
a real product defect, fix the defect rather than weakening its test.

End with a concise report of the files changed and the exact verification result.`;
}

export function buildCorrectionPrompt(input: CorrectionPromptInput): string {
  const { review } = input;

  const bySeverity = (['critical', 'high', 'medium', 'low'] as const)
    .map((severity) => {
      const items = review.findings.filter((finding) => finding.severity === severity);
      if (items.length === 0) return null;
      const lines = items
        .map((finding) => {
          const location = finding.file
            ? ` [${finding.file}${finding.line != null ? `:${finding.line}` : ''}]`
            : '';
          return `  - ${finding.title}${location}\n    ${finding.description}`;
        })
        .join('\n');
      return `${severity.toUpperCase()}\n${lines}`;
    })
    .filter((section): section is string => section !== null)
    .join('\n\n');

  return `A reviewing agent examined your implementation and requested changes.
This is correction round ${input.round} of at most ${input.maxRounds}.

${input.ruleEvidence ? `=== IMMUTABLE PROJECT RULE EVIDENCE ===\n${input.ruleEvidence}\n` : ''}

=== REVIEW SUMMARY ===
${review.summary}

=== FINDINGS ===
${bySeverity || '(no itemised findings were returned)'}

=== WHAT TO DO ===
${review.followUpPrompt.trim() || 'Address every finding above.'}

${
  review.suggestedTests.length > 0
    ? `=== TESTS THE REVIEWER WANTS ===\n${review.suggestedTests.map((t) => `  - ${t}`).join('\n')}\n`
    : ''
}
Keep working in the same worktree on the same branch. The same rules still apply:
do not commit, do not push, do not touch any remote, and do not change anything
outside the scope of these findings.

If you believe a finding is wrong, you may push back — but say so explicitly in your
final message and explain why, rather than silently ignoring it.

End with an updated report: what you changed in this round, which findings you consider
resolved, which you disputed and why, and the test results after your changes.`;
}

/* -------------------------------------------------------------------------- */
/* Codex: automatic finding triage                                             */
/* -------------------------------------------------------------------------- */

export interface TriagePromptInput {
  /** The one kind of reference every finding below is named by. */
  readonly refKind: TriageRefKind;
  readonly specification: TaskSpecification;
  readonly ruleEvidence?: string;
  readonly findings: readonly TriageableFinding[];
  readonly priorDecisions: readonly TriageableDecision[];
}

function renderTriageFinding(finding: TriageableFinding): string {
  const location = finding.file ? `${finding.file}${finding.line !== null ? `:${finding.line}` : ''}` : '(no specific location)';
  return `--- Finding ref=${JSON.stringify(finding.ref)} ---
Severity: ${finding.severity}
Category: ${finding.category}
Location: ${location}
Title: ${finding.title}
Body: ${finding.body}
Suggested fix: ${finding.fix ?? '(none suggested)'}`;
}

function renderTriageDecision(decision: TriageableDecision): string {
  return `  - ref=${JSON.stringify(decision.findingRef)}: ${decision.action}${decision.reason ? ` — ${decision.reason}` : ''}`;
}

/** The type a "findingRef" must have, stated to the model as well as enforced by the schema. */
const TRIAGE_REF_INSTRUCTION: Record<TriageRefKind, string> = {
  index:
    'Every "findingRef" is a JSON NUMBER: the integer after "ref=" (for example 0), written without quotes — never a string such as "0".',
  id: 'Every "findingRef" is a JSON STRING: the quoted id after "ref=", copied exactly as written and never as a number.'
};

export function buildTriagePrompt(input: TriagePromptInput): string {
  const { specification } = input;
  return `You are an independent TRIAGE analyst in a multi-agent relay. You are in READ-ONLY
mode: you must not modify, create, or delete any file, and you must not run any command
that changes state. Your entire output is a single JSON object matching the required
schema, with exactly one recommendation for every finding listed below — no more, no
fewer, and every "findingRef" must be copied EXACTLY from a "Finding ref=" line below.
${TRIAGE_REF_INSTRUCTION[input.refKind]}

You are not the original reviewer and did not produce these findings. Your job is to
independently judge, for each one, whether it should be accepted, rejected, or left for
a human to decide — never to re-review the change from scratch, and never to invent a
finding that is not listed below.

${input.ruleEvidence ? `=== IMMUTABLE PROJECT RULE EVIDENCE ===\n${input.ruleEvidence}\n` : ''}

=== THE SPECIFICATION UNDER DISCUSSION ===
Title: ${specification.title}

Summary:
${specification.summary}

Acceptance criteria:
${specification.acceptanceCriteria.map((c, i) => `  ${i + 1}. ${c}`).join('\n')}

Constraints:
${specification.constraints.length > 0 ? specification.constraints.map((c) => `  - ${c}`).join('\n') : '  (none stated)'}

Assumptions the specification made:
${specification.assumptions.length > 0 ? specification.assumptions.map((a) => `  - ${a}`).join('\n') : '  (none stated)'}

=== PRIOR DECISIONS ALREADY RECORDED (context only — these findings are not yours to re-triage) ===
${input.priorDecisions.length > 0 ? input.priorDecisions.map(renderTriageDecision).join('\n') : '  (none)'}

=== UNDECIDED FINDINGS TO TRIAGE (exactly these, exactly once each) ===
${input.findings.map(renderTriageFinding).join('\n\n')}

=== HOW TO DECIDE, FOR EACH FINDING ===
recommendation = "accept"
  The finding is valid, actionable, and within the specification's scope.

recommendation = "reject"
  The finding rests on a false premise, duplicates another finding or an already-recorded
  decision, falls outside the specification's scope, is contradicted by evidence above, or
  describes something already satisfied.

recommendation = "needs_user"
  Deciding requires a product or architecture choice, the evidence here is insufficient,
  or you are genuinely uncertain.

For every finding, also give:
- "reason": one concise sentence explaining the recommendation.
- "evidenceRef": a concrete reference into the material above that supports it (e.g. an
  acceptance criterion number, a constraint, or a quoted phrase from the finding itself).
- "confidence": "high", "medium", "low", or "uncertain".

Return only the JSON object, with a "results" array containing exactly one entry per
finding listed above.`;
}
