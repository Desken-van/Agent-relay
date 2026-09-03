# Manual end-to-end test

The automated suite covers the orchestration logic against fakes, and one suite
drives the Claude adapter through a **real child process** against a fake CLI —
argv, the prompt on stdin, split stdout chunks, the stdout/stderr boundary, exit
codes, denials, resume, and the fact that a timeout or a cancellation leaves no
process behind. This document covers what is left: the parts that can only be
checked by driving the real application against the real tools.

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

Below it, **expect** a second textarea, *Claude verification commands*,
pre-filled with the same two rules. This one decides which commands count as
having *checked the work*, and every rule in it must also appear above.

Try each of these and **expect** the *Save settings* button to be disabled with
an explanation naming the rule:

| Typed | Expected complaint |
| --- | --- |
| (empty) | at least one rule is required |
| `Bash(npm run docs *)` | missing from the pre-approved list above |
| `Bash(npm * test)` | `*` only allowed as the final character |
| `Bash(npm test; git status)` | chained commands are not accepted |
| `Bash(cmd /c npm test)` | a command that runs another cannot be verified |
| `Read(**)` | only `Bash(…)` and `PowerShell(…)` |
| `npm test` | not written as `Tool(command)` |

Press **Reset** and **expect** both textareas to return to:

```
Bash(npm test *)
PowerShell(npm test *)
```

Reset restores the shipped defaults, not the last saved values — otherwise a
saved rule list the validator now rejects would leave you stuck with the Save
button disabled and no way back.

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

### 5d. A blocked command is judged on the evidence

Claude runs with no one available to answer a permission prompt, so a command
that is neither pre-approved nor auto-approved is refused outright rather than
waiting. What that means for the round depends on *what* was refused.

**A blocked auxiliary command, tests still passing.** Leave the defaults in
place and run a task whose specification also asks for something not on the
list — a coverage report, say. **Expect** the round to end as *Ready for review*
with an **amber warning** on the timeline saying how many commands were denied
and naming the verification command that succeeded. Expand *N denied commands*
and **expect** each to show its tool, redacted command, category and reason.
**Expect** the run itself to stay green, and the wording *not* to claim the
tests may have been skipped.

**Blocked verification.** The permissions list can no longer be emptied — a
verification rule must always be runnable, so Settings refuses the save. To see
this case instead, point both lists at a command the project does not have
(`Bash(npm run check *)` in both), save, and run a task. **Expect** the round to
end **unsuccessfully**, not as *Ready for review*, with an error saying no
verification command ran.

**Failing tests.** Run a task against a project whose tests fail. **Expect**
*Ready for review* with an amber warning saying verification ran and failed, and
that publishing is blocked. **Expect** *Review with Codex* to be available, and
a later publish attempt to be refused with a message about verification.

**Unusable configuration.** Clear the **Claude verification commands** textarea
and save — **expect** the save to be refused both by the disabled button and, if
you reach it another way, by the main process. If a bad configuration does get
stored, **expect** *Send to Claude* to fail immediately with a message pointing
at Settings, **no** Claude node on the timeline, **no** new branch or worktree,
and the task still at *Ready for implementation*.

### 5e. Recovering from a refused publish

Run a task whose tests fail, let Codex **approve** it, press *Approve for
publishing*, then try to commit. **Expect** the publish to be refused with a
message about verification.

From that same state, **expect** the correction button to read **Retry
verification** and to be enabled. Press it. **Expect** a new Claude round on the
same session, with a prompt saying the change was reviewed and approved but its
checks did not pass. After it finishes, **expect** the task at *Ready for
review* — a new Codex review and a new *Approve for publishing* are both required
before the commit is allowed again.

For contrast, take a task that reached *Ready to publish* with a clean round.
**Expect** the same button to stay **disabled**: there is nothing to retry, and
offering another round on finished work would be busywork.

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

### 8b. Interrupted mid-round

Start a round — *Send to Claude*, or *Review with Codex* — and while the agent
node is still streaming, **close the window** without pressing *Stop*.

Start the application again and open the same task.

**Expect**:

* the task **not** stuck in *Implementing* or *Reviewing*: it is back at *Ready
  for implementation* (or *Changes requested* if it was a correction round), or
  *Ready for review* respectively;
* the interrupted run shown as **failed**, with the reason *"Agent Relay stopped
  before this run completed; recovered during startup."*;
* **no** agent running — nothing was relaunched on your behalf;
* the branch, worktree, Codex thread id, Claude session id, round counter,
  specification and previous rounds' evidence all unchanged;
* the buttons for the recovered state enabled, so the round can be started again
  by hand.

Close and start once more. **Expect** nothing further to change — the recovery
already happened, and repeating it is a no-op.

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
| Set *Process timeout* to 1 minute and start a long task | The run ends as *timed out* with advice to raise the timeout, and no `claude.exe` is left running (check Task Manager, or `Get-Process claude -ErrorAction SilentlyContinue`) |
| Press *Stop* while Claude is mid-round | The run ends as *cancelled*, the task returns to a retryable status, and again no `claude.exe` survives |
| Watch the timeline during a round where the CLI prints warnings | Diagnostics from the CLI never appear as session, tool-use, denial or result entries — stderr is not protocol |
| Delete the worktree folder from disk, then press *Send corrections* | A rejected-path or Git error rather than a crash |
| Set the worktrees root to a path, then edit a task's worktree to sit outside it | The operation is refused with an unsafe-path error |

✅ Pass if every failure produces an actionable message and the window survives.

---

## 11. Operational targets are read-only *(covered by automated tests)*

The registry, the probe adapter and the IPC contract are covered by automated
tests, and the screen by renderer tests that drive its real buttons. Nothing in
this section touches a production system.

What the automated suite already proves, so this document does not repeat it:
the database is opened read-only, the file is byte-identical afterwards, no
`-wal` or `-shm` appears beside it, no row is read, a probe id cannot be a
statement, and a timeout genuinely kills the child process.

If you want to satisfy yourself by hand before the UI arrives, point a target at
a **copy** of a database — never a live one — and confirm afterwards that the
copy's size and modification time are unchanged and that no sidecar files
appeared next to it.

✅ Pass if you can register a target, run both probes, and find the file exactly
as you left it.

---

## 12. Operations UI — live acceptance *(Phase 7C-C, not yet performed)*

The Operations screen has never been exercised against a real database in a
running window. This is the checklist for doing that, and it has not been run.

**Prepare, and do not skip this.** Point nothing at a database you care about.

```powershell
# An isolated profile, outside the repository.
$env:AGENT_RELAY_DATA_DIR = "$env:TEMP\agent-relay-7cc"

# A throwaway database, created for this test and nothing else.
$db = "$env:TEMP\agent-relay-7cc\fixture.sqlite"
New-Item -ItemType Directory -Force (Split-Path $db) | Out-Null
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);d.exec('CREATE TABLE invoices (id INTEGER PRIMARY KEY, customer TEXT NOT NULL, total REAL)');d.exec('CREATE TABLE payments (id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL)');d.exec(\"INSERT INTO invoices (customer,total) VALUES ('ACME Ltd',99.5)\");d.close()" $db

# Record what the file looks like before anything opens it.
Get-FileHash $db; (Get-Item $db).Length; (Get-Item $db).LastWriteTimeUtc
```

| Do this | Expect |
|---|---|
| Open the app with no project selected and click **Operations** | The section opens; no project name appears in the header |
| Register a target: a name, environment **local**, the fixture path | Save is disabled until the environment is chosen and the path is absolute; the target appears in the list |
| Try a relative path such as `fixture.sqlite` | Save stays disabled, with the reason shown |
| Select the target and read the run panel | Name, environment, path, probe and the read-only note are all shown *before* anything runs |
| Run **connection_health** | `opened`, `readOnly` and `queryOnly` all yes; a real SQLite version; the file size and modification time match what you recorded |
| Run **schema_summary** | `invoices` and `payments` with their columns and types; no row values anywhere — in particular no `ACME Ltd` and no `99.5` |
| Re-check the file | Hash, size and modification time **unchanged**; no `-wal` or `-shm` beside it |
| Press **Refresh** on History, and reopen the section | The recorded runs are still there; nothing ran again |
| Disable the target, then try to run | Run is disabled and says the target is disabled |
| Try to remove the registration | Refused, with the registry's reason and its suggestion to disable instead |
| Point a second target at a path that does not exist and run `connection_health` | `fileExists: no`, `opened: no`, and a warning — not a crash |
| Point a third target at a text file renamed `.sqlite` and run both probes | `connection_health` reports it could not be opened; `schema_summary` fails with a reason, and claims no schema |

✅ Pass if every probe reports what is actually there, the fixture file is
byte-identical afterwards, and nothing ran that you did not click.

```powershell
# Afterwards
Remove-Item -Recurse -Force "$env:TEMP\agent-relay-7cc"
Remove-Item Env:\AGENT_RELAY_DATA_DIR
```

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
