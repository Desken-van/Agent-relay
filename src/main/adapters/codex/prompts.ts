/**
 * Prompt construction for the two Codex roles and the Claude implementer.
 *
 * These are plain string builders with no I/O so they can be unit tested, and
 * so the exact text sent to a model is reviewable in one place rather than
 * scattered through the orchestrator.
 */

import type { GitChangeSet } from '../../../shared/domain/git';
import type { CodexReviewResult, TaskSpecification } from '../../../shared/schemas/codex';

/* -------------------------------------------------------------------------- */
/* Codex: specification                                                        */
/* -------------------------------------------------------------------------- */

export interface SpecificationPromptInput {
  readonly projectPath: string;
  readonly taskTitle: string;
  readonly originalRequest: string;
}

export function buildSpecificationPrompt(input: SpecificationPromptInput): string {
  return `You are the SPECIFIER in a two-agent relay. You do not write the code; a separate
coding agent (Claude Code) will implement whatever you specify, working alone, in an
isolated Git worktree, with no ability to ask you follow-up questions.

Repository under discussion: ${input.projectPath}
You have read-only access. Inspect the repository before specifying anything: read the
build files, the existing tests, and the code the task touches, so your specification
matches how this project is actually written rather than how a generic project is.

TASK TITLE
${input.taskTitle}

USER'S REQUEST (verbatim)
${input.originalRequest}

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

Scope discipline: specify the change the user asked for. Do not add refactors, upgrades,
or "while we're here" improvements.

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
  readonly round: number;
  readonly maxRounds: number;
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

  return `You are the REVIEWER in a two-agent relay. You are in READ-ONLY mode: you must not
modify, create, or delete any file, and you must not run commands that change state.
Your entire output is a single JSON object matching the required schema.

This is review round ${input.round} of at most ${input.maxRounds}.

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
}

export function buildImplementationPrompt(input: ImplementationPromptInput): string {
  const { specification } = input;

  return `You are implementing a task in an isolated Git worktree created for you by Agent Relay.

WORKTREE (this is your working directory, and the only place you may edit)
  ${input.worktreePath}

BRANCH (already checked out for you)
  ${input.branchName}

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
}): string {
  return `Your implementation was reviewed and approved, but it cannot be published yet.

This is round ${input.round} of at most ${input.maxRounds}.

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
