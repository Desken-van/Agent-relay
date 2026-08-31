# Manual end-to-end test

The automated suite covers the orchestration logic against fakes. This document
covers the parts that can only be checked by driving the real application
against real tools.

**Nothing here pushes to GitHub.** Sections 1–8 are entirely local. Section 9
is the only one that touches a remote, and it is clearly marked.

---

## Prerequisites

| Requirement | Check | If missing |
|---|---|---|
| Node ≥ 22.13 | `node --version` | https://nodejs.org |
| Git | `git --version` | https://git-scm.com/download/win |
| Git identity | `git config --global user.name` and `user.email` | `git config --global user.name "You"` |
| Codex, logged in | `codex login status` | Ships with the app's dependencies; run `npx codex login` |
| Claude Code, logged in | `claude --version` and `claude auth status` | `winget install --id Anthropic.ClaudeCode -e`, then run `claude` once. A shell that was already open will not see the new PATH entry, so open a new terminal — or rely on Agent Relay's own discovery, which checks both WinGet's `Links` shim directory and the `Anthropic.ClaudeCode_*` package directory |
| GitHub CLI *(section 9 only)* | `gh auth status` | `winget install --id GitHub.cli`, then `gh auth login` |

```powershell
cd H:\Agent-relay
npm install
npm run dev
```

> **VS Code terminals:** `npm run dev` and `npm start` go through
> `scripts/launch.mjs`, which strips `ELECTRON_RUN_AS_NODE` before spawning
> Electron. If you launch `electron .` by hand from a VS Code terminal and get
> *"The requested module 'electron' does not provide an export named
> 'BrowserWindow'"*, that variable is why — unset it and try again.

---

## 1. The application starts

1. Run `npm run dev`.
2. **Expect:** a dark window titled *Agent Relay*, on the Projects screen, with
   an empty project list.
3. **Expect:** *Tasks* and *Run* in the left rail are greyed out and unclickable.

✅ Pass if the window appears and nothing is on fire.

---

## 2. Diagnostics are honest

1. Open **Settings**.
2. **Expect** one card per tool with a coloured dot:
   * green = installed and authenticated,
   * amber = installed but logged out,
   * grey = not found,
   * red = found but the probe failed.
3. **Expect** each card to show a version and a resolved executable path, and
   every non-green card to show a concrete remediation command.
4. **Expect no token anywhere** on this screen. For GitHub, only account names.
5. Press **Re-check** and confirm the values refresh.

Deliberately break one: put nonsense in *Claude Code path* and save.
**Expect** the card to flip to grey/`missing` with *"the configured path does
not exist"* — not a crash. Clear the field and save again.

✅ Pass if missing tools are reported clearly and the app stays usable.

### 2b. Claude permissions

Scroll to **Claude permissions**. **Expect** a textarea pre-filled with:

```
Bash(npm test *)
PowerShell(npm test *)
```

These are the shell commands Agent Relay pre-approves, so they run without a
prompt. They are not the full extent of what Claude can do — it also edits files
in its worktree, and the target repository's own project settings still load.
**Expect** a note that commit, push, reset, clean, checkout, switch, merge,
rebase and `gh` are refused when named directly and cannot be granted here, and
that this is a pattern filter rather than a sandbox.

Leave the default alone for the rest of this document unless a step says
otherwise. If the project you are testing uses a different test command, add a
matching rule — narrowly, e.g. `Bash(pnpm test *)`, not `Bash(*)`.

---

## 3. Register an existing project

1. Go to **Projects → Existing repository**.
2. **Browse…** to any local Git repository you do not mind being read.
3. **Expect** validation to appear: current branch, branch list, clean/dirty
   state, remote, and commit identity.
4. Click **Add project**, then select it.

Try a folder that is *not* a Git repository. **Expect** a red notice saying so,
and **Add project** to refuse.

✅ Pass if a valid repo is accepted and a non-repo is rejected with a reason.

---

## 4. Create a task and generate a specification

1. **Tasks → New task.** Give it a title and a real request, e.g.
   *"Add a CONTRIBUTING.md describing how to run the tests."*
2. Set **Maximum review rounds** to 2.
2b. Pick the two models. **Codex model** covers the specification and every
   review; **Claude model** covers the implementation and every correction.
   Both default to whatever *Settings* holds, and both offer *Tool default* and
   *Custom model ID…*; Claude also lists `opus`, `sonnet`, `haiku`, `fable`.
   **Expect** the Codex dropdown to list real models read from the CLI, with
   the account default marked, plus a *Refresh models* button. If the list
   cannot be read, expect a notice with *Retry* and the picker still usable.
   **Expect** the chosen pair to appear on the task row and in the Run screen's
   Task panel, and to be **unchangeable** after the task exists — editing the
   Settings defaults afterwards must not alter it.
3. **Create task** — you land on the **Run** screen with status *Draft*.
4. Press **Generate specification** (marked read-only, blue).
5. **Expect:** a Codex node appears on the left lane of the timeline and streams
   events live; status becomes *Specifying*, then *Ready for implementation*.
6. **Expect:** a Specification panel with title, summary, acceptance criteria,
   constraints, assumptions, suggested tests, and a collapsible
   implementation prompt.
7. **Expect:** the Codex thread id is populated in the Task panel.

**Confirm nothing was written:** run `git status` in the project — it must be
unchanged, and no branch or worktree should exist yet.

✅ Pass if a structured specification appears and the repository is untouched.

### 4b. Retry path

Press **Regenerate specification**. **Expect** it to continue the *same* Codex
thread (the thread id does not change) and the prior approval to be cleared.

---

## 5. Approve, then isolate

1. Read the specification, press **Approve specification**.
2. **Expect** the button to change to *Specification approved ✓*.
3. Press **Send to Claude**.

**Expect**, in order:
* a *Git* node on the timeline: "Creating branch agent-relay/… from <base>";
* the Task panel to fill in **Branch**, **Base branch**, and **Worktree**;
* status *Implementing*, then a Claude node in the right lane streaming tool
  calls and messages;
* status *Ready for review* when it finishes.

**Verify the isolation yourself:**

```powershell
git -C <your-repo> worktree list      # the agent-relay worktree is listed
git -C <your-repo> status             # your checkout is still clean
git -C <your-repo> branch --show-current   # still your original branch
```

✅ Pass if all agent edits live in the worktree and your checkout is untouched.

### 5b. Dirty working tree

Before pressing *Send to Claude* on a second task, make an uncommitted edit in
the project. **Expect** the send to be refused with a *"has uncommitted
changes"* notice offering **Continue anyway**. Choosing it proceeds; cancelling
leaves the task retryable.

### 5c. Guard rails

**Expect** *Send to Claude* to be disabled until the specification is approved.

### 5d. A blocked command fails the round

Claude runs with no one available to answer a permission prompt, so a command
that is neither pre-approved nor auto-approved is refused outright rather than
waiting.

To see the handling, temporarily clear the **Claude permissions** textarea, save,
and run a task whose specification asks for tests to be run. **Expect** red
*Permission denied* entries on the timeline naming the tool, and the round to end
**unsuccessfully** — not as *Ready for review* — with the denial recorded as the
task's last error. A round in which the tests were silently skipped must never
look like a clean one.

Restore the default rules afterwards.

---

## 6. Collect changes and review

1. On the Run screen, look at **Changed files** (refresh if needed).
2. **Expect** the file list with per-file +/− counts, and a colourised diff.
3. **Expect** *Commits on the task branch* to be empty — Agent Relay does not
   commit the agent's work.
4. Press **Review with Codex** (read-only, blue).
5. **Expect** a Codex node in the left lane, then a **Codex review** panel with a
   verdict badge, a summary, and findings grouped critical → low with file:line.

✅ Pass if the review returns a structured verdict and the worktree is unchanged
by the review itself (`git -C <worktree> status` before and after should match).

---

## 7. The correction loop, and that it stops

Do this on a task where Codex returned **changes_requested**.

1. Press **Send corrections**.
2. **Expect** the round counter to advance (the pips next to the status fill in)
   and Claude to resume the **same session** — the Claude session id in the Task
   panel must not change.
3. Press **Review with Codex** again.

Repeat until the round budget is spent. With *Maximum review rounds = 2*:

* after the round-2 review still requesting changes, **expect** status **Failed**
  with the message *"Review round limit reached (2/2)…"*;
* **expect** *Send corrections* to be disabled;
* **expect** no further Claude run to start.

✅ Pass if the loop halts by itself at the configured limit.

### 7b. Stop

On a different task, press **Stop task** while an agent is running.
**Expect** the run to end, the run row to show *cancelled*, and the task to
become *Cancelled*.

---

## 8. Restart durability

1. With at least one task past the review stage, **close the application**.
2. Start it again.
3. Open the same project and task.

**Expect** all of these to survive:
* the project and every task, with the same statuses;
* the Codex thread id and the Claude session id;
* the branch and worktree paths;
* the specification, the last review with its findings, and the full timeline
  with each run's stored events.

Then press **Send corrections** (if the task is in *Changes requested*).
**Expect** Claude to resume the stored session rather than starting fresh.

✅ Pass if nothing was lost and both agent conversations resume.

---

## 9. Publishing — **the only section that touches GitHub**

> Do this against a scratch repository you are happy to publish, or skip it.
> Every step below opens a confirmation dialog. **Press Cancel** on any of them
> and verify that nothing happened; that is the more important test.

Prerequisite: `gh auth status` shows an account, and the task reached
**Approved**.

1. Press **Approve for publishing** → status *Ready to publish*, and a
   **Publish** panel appears.

2. **Test the gate first.** Choose action **Commit changes**, read the inline
   summary, press **Confirm and run…**, and press **Cancel** in the native
   dialog.
   **Expect:** a *Cancelled* toast, no commit (`git -C <worktree> log` unchanged),
   and an *Approval trail* row showing **denied**.

3. Now accept it. **Expect** a commit in the worktree only, an approval row
   showing **granted**, and the status back at *Ready to publish*.

4. **Create GitHub repository** — check the dialog names the exact
   **owner**, **repository**, **visibility**, **branch**, and action before you
   accept. **Expect** the repository to be created and `origin` to be set, with
   **no code pushed**.

5. **Push branch** → confirm. **Expect** only the task branch to be pushed.

6. **Open pull request** → confirm. **Expect** the PR to open in your browser and
   the task to become *Completed*.

✅ Pass if every action required the dialog, cancelling changed nothing, and
each approval was recorded.

---

## 10. Failure handling

| Do this | Expect |
|---|---|
| Log out of Codex (`codex logout`) and press *Generate specification* | A clear "Codex is not authenticated" error with `codex login` as the remediation; the task returns to *Draft* and can be retried |
| Point *Claude Code path* at a nonexistent file and press *Send to Claude* | "The Claude Code path configured in Settings does not point at an existing file"; the task stays retryable |
| Set *Process timeout* to 1 minute and start a long task | The run ends as *timed out* with advice to raise the timeout |
| Delete the worktree folder from disk, then press *Send corrections* | A rejected-path or Git error rather than a crash |
| Set the worktrees root to a path, then edit a task's worktree to sit outside it | The operation is refused with an unsafe-path error |

✅ Pass if every failure produces an actionable message and the window survives.

---

## Cleanup

```powershell
# List and remove the worktrees Agent Relay created
git -C <your-repo> worktree list
git -C <your-repo> worktree remove <worktree-path>     # refuses if work is uncommitted
git -C <your-repo> branch -d agent-relay/<...>         # your call, not the app's

# Application data (database, worktrees root, Electron profile)
%APPDATA%\agent-relay
```

Removing a project inside the app only unregisters it — the folder on disk is
never touched.

> **Testing against a throwaway profile.** Set `AGENT_RELAY_DATA_DIR` to an
> empty directory before launching and the whole run is redirected there —
> `agent-relay.sqlite`, the worktrees root, *and* Electron's Chromium profile
> (`Preferences`, storage, the single-instance lock). Your real profile under
> `%APPDATA%\agent-relay` is left alone; nothing is migrated or deleted. Set it
> only for the child process, so it does not leak into later sessions:
>
> ```powershell
> $env:AGENT_RELAY_DATA_DIR = 'H:\some-throwaway-dir'; npm run dev
> ```
