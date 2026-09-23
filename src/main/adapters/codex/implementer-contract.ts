/**
 * What a specification may assume about its target and its implementer.
 *
 * Handed to the specifier, the reviser and the external plan reviewer alike, so the
 * one who writes the plan and the ones who judge it work from the same facts: which
 * tree it describes, which observations about that tree it may state, and exactly
 * what the implementer can and cannot do. Plain strings, no I/O.
 */

import type { ImplementationProvider } from '../../../shared/domain/execution-providers';
import { ORNITH_ACTION_KINDS } from '../../../shared/domain/ornith';
import { shortCommit, type SpecificationGrounding } from '../../../shared/domain/specification-grounding';

/**
 * Which tree the specification describes, and what it is not — told to the one who
 * reads that tree to write the specification, or to the one who reviews it.
 */
export function specificationTargetSection(
  target: SpecificationGrounding,
  reader: 'specifier' | 'reviewer' = 'specifier'
): string {
  const where =
    target.checkout === 'task_worktree'
      ? `the task's own worktree, on branch ${target.branch ?? '(unknown)'}, at commit ${target.commit}${
          target.clean ? ' (no uncommitted changes)' : ', WITH uncommitted changes from earlier implementation rounds'
        }`
      : `a clean, detached checkout of base branch ${target.baseBranch} at commit ${target.commit}; the task's branch is created from exactly this commit`;
  const opening =
    reader === 'specifier'
      ? `You are reading ${where}. The implementer starts from exactly this tree.`
      : `The specification was written by reading ${where}. The task branch under review starts from exactly this commit.`;
  return `=== TARGET CHECKOUT (the tree this specification describes) ===
${opening}
The project's own folder is NOT the target: it can be on another branch or commit and hold
uncommitted edits. The rule evidence records the revision and clean state of the checkout its
rule files were read from when they were captured; that describes neither this target nor the
task's worktree.`;
}

/** Observations that change with the checkout, and the one way they may appear. */
export function transientFactsRule(target: SpecificationGrounding): string {
  const observed = target.clean
    ? `State one only if you observed it in this checkout, and then name the commit with it (for
  example "at ${shortCommit(target.commit)}, docs/example.md is 1,234 bytes"). Never state one you did not observe here.`
    : 'This checkout has uncommitted changes, so state none of them.';
  return `- File facts that change with the checkout — exact file sizes, byte counts, line counts,
  line-ending counts, trailing bytes, and claims that a file or checkout is clean or dirty.
  ${observed} Otherwise leave them out and tell the implementer to inspect the file when it starts.`;
}

const NO_RELAY_UI = `- It cannot use Agent Relay's user interface or its IPC channels. Never instruct it to press or
  invoke an Agent Relay action (for example "Run verification" / workflow:verify), to capture,
  poll or wait for an Agent Relay run ID, or to read an Agent Relay record, timeline or database.
- After it stops, Agent Relay verifies the result itself, as a separate stage the operator sees.
  That stage is not the implementer's to start, wait for or read.`;

const CAPABILITIES: Record<ImplementationProvider, string> = {
  ornith: `The implementer is Ornith, a local model working through Agent Relay in a bounded tool loop.
It has exactly these actions and nothing else: ${ORNITH_ACTION_KINDS.join(', ')}.
- It has no shell, terminal or command execution, no network, and no git commit, push, checkout
  or reset. Never instruct it to run a command (npm, node, git, a script) itself.
- It edits files only through create_file, replace_text (exact text, with the file's current
  sha256 from its own read) and delete_file. There are no file handles: never instruct it to
  open, seek, append through a handle, flush or close a file, or to write raw bytes.
- Its own "run_verification" action runs the project's verification inside its loop and returns
  the outcome, exit code and a short sanitized summary; it may use it once the work is complete.
${NO_RELAY_UI}`,
  claude: `The implementer is Claude Code, working alone in the task worktree. It can read and edit files
and run the commands Agent Relay's settings permit, including the configured verification
commands. It cannot commit, push or touch a remote.
${NO_RELAY_UI}`,
  codex: `The implementer is Codex, working alone in the task worktree with write access to it and no
network. It can read and edit files and run commands inside the worktree. It cannot commit, push
or touch a remote.
${NO_RELAY_UI}`
};

/** Exactly what the selected implementer can do, for everyone who writes or judges its instructions. */
export function implementerCapabilitiesSection(
  provider: ImplementationProvider,
  reader: 'specifier' | 'reviewer' = 'specifier'
): string {
  const duty =
    reader === 'specifier'
      ? `Write every instruction in "implementationPrompt", "suggestedTests" and "acceptanceCriteria" so this
implementer can carry it out with exactly these capabilities.`
      : `Judge every instruction in the specification against exactly these capabilities: one this
implementer cannot carry out is a defect of the plan.`;
  return `=== WHO IMPLEMENTS THIS, AND WHAT IT CAN DO ===
${CAPABILITIES[provider]}
${duty}`;
}

/**
 * What a specification may ask for as verification evidence. Agent Relay verifies the finished
 * change itself and persists a bounded record of it — never the command's raw output
 * (docs/security.md). That stage is the operator's and Relay's, never the implementer's.
 */
export const VERIFICATION_EVIDENCE_RULE = `- Verification evidence: Agent Relay verifies the finished change itself, as a separate stage after
  the implementer stops (it runs \`npm run verify\` in the task worktree), and persists a record of
  that run: its exit code and classified outcome (passed, failed, timed_out or cancelled) and, for a
  failed run, its failure kind and a bounded, sanitized output summary. Acceptance criteria may require
  that Agent Relay's verification of the finished change passes. The "implementationPrompt" must never
  ask the implementer to start, wait for, poll or read that stage or its record. Agent Relay never
  stores a command's raw stdout/stderr or a complete log, so nothing may require the actual, full or
  raw command output to be stored in, attached to, or shown by Agent Relay.`;
