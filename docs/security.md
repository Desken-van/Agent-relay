# Security model

Agent Relay runs two autonomous coding agents against your source code and can
push to GitHub. This document states what it does to make that safe, and — just
as importantly — what it does **not** protect you from.

---

## 1. Credentials: Agent Relay never has any

There is no credential store, no key field, no token setting, and no
`.env` entry that holds a secret. Authentication is delegated entirely:

| Tool | Authenticates via | Credentials live in |
|------|-------------------|---------------------|
| Codex | `codex login` | `~/.codex` |
| Claude Code | `claude` login flow | `~/.claude` |
| GitHub | `gh auth login` | `gh`'s own store / OS keychain |

Agent Relay never reads those files, never runs `gh auth token`, and never
passes `--show-token`. Diagnostics report **account names and versions only**.

### Defence in depth: output redaction

Every string that is persisted to SQLite or shown in the UI passes through
[`redactSecrets()`](../src/shared/util/redact.ts) first. It masks GitHub tokens
(`ghp_`/`gho_`/`ghs_`/`ghu_`/`ghr_`/`github_pat_`), OpenAI- and Anthropic-style
keys, JWTs, `Authorization:` headers, credentials embedded in URLs, and the
values of any `*TOKEN*`/`*SECRET*`/`*PASSWORD*`/`*API_KEY*` environment
variable that appears in text.

This is deliberately aggressive. A false positive costs a few unreadable
characters; a false negative writes a live token into a database that outlives
the session.

### Defence in depth: environment compartmentalisation

Child processes do **not** inherit Agent Relay's token-shaped environment
variables. Each adapter declares only the credential variables it owns:

| Adapter | Allowed through |
|---------|-----------------|
| Claude Code | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` |
| `gh` | `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` |
| `git` | *(none)* |
| Codex | inherits normally — see note below |

So `git` cannot see your GitHub token, and Codex cannot see your Anthropic key.
Codex is the exception: the SDK spawns the Codex binary itself, and Codex owns
`~/.codex/auth.json` and `OPENAI_API_KEY`, so its environment is left intact.

---

## 2. Electron hardening

| Setting | Value | Why |
|---------|-------|-----|
| `contextIsolation` | `true` | Renderer JS and preload JS run in separate contexts |
| `nodeIntegration` | `false` | No `require`, `process` or `fs` in the page |
| `sandbox` | `true` | The renderer runs in an OS sandbox |
| `webSecurity` | `true` | Same-origin policy enforced |
| `nodeIntegrationInWorker` / `InSubFrames` | `false` | No escape via workers or iframes |

Because `sandbox: true` is incompatible with an ESM preload, the preload is
emitted as CommonJS (`out/preload/index.cjs`) while the main process is ESM.

Additionally:

* A strict **Content-Security-Policy** is injected for the packaged app
  (`default-src 'self'`, `object-src 'none'`, `frame-src 'none'`,
  `base-uri 'none'`, `form-action 'none'`).
* **All permission requests are denied** — no camera, microphone, geolocation,
  notifications, or clipboard.
* **Navigation is blocked.** `will-navigate` is prevented, `window.open` is
  denied, and `will-attach-webview` is prevented.
* Only **one instance** may run, so two orchestrators can never share a database
  or a worktree.

---

## 3. The IPC boundary

The renderer's entire view of the outside world is two functions:

```ts
window.agentRelay.invoke(channel, input)   // one of a fixed set of operations
window.agentRelay.onEvent(listener)        // read-only push subscription
```

* **There is no channel that runs a command.** The renderer cannot name an
  executable, a shell string, a script, or a path to run. A test enumerates
  every channel's input schema and fails if any of them grows a
  command-shaped field (`command`, `cmd`, `args`, `script`, `executable`, …).
* **Every payload is validated with Zod in the main process** before the handler
  body runs. Every schema is `.strict()`, so unknown properties are rejected —
  also enforced by a test that projects each schema to JSON Schema and asserts
  `additionalProperties: false`.
* **Handlers never reject.** Errors are normalised into a redacted
  `SerializedError`, so a stack trace or filesystem layout cannot leak into the
  renderer.
* `shell:openExternal` accepts **https only**, and only for an allow-list of
  hosts (github.com, cli.github.com, docs.anthropic.com, …).
* `shell:revealPath` accepts only paths inside a registered project, the
  worktrees root, or the projects root.

---

## 4. Process execution

Every child process is created in one place, `ExecaProcessRunner`:

* **`shell: false`, always.** Arguments are passed as an array. A prompt
  containing `&& rm -rf /` is a single argv entry, not a second command. This is
  asserted by a test that spawns a process with shell metacharacters in an
  argument and verifies they arrive as literal text.
* Non-string arguments are rejected rather than coerced.
* Every run has a timeout and an `AbortSignal`.
* Retained output is bounded, so a runaway agent cannot exhaust the disk.

Executables are resolved explicitly (configured path → `PATH` → well-known
Windows locations) rather than by attempting a spawn, because on Windows a
missing command surfaces as `exit code 1` from `cmd.exe`, not `ENOENT`.

The well-known list includes two WinGet locations, since its `PATH` change only
reaches processes started after the install: the `WinGet\Links` shim directory,
used by packages that publish a shim, and — for `claude` only — direct children
of `WinGet\Packages` whose name begins `Anthropic.ClaudeCode_`, checked for a
`claude.exe` directly inside. The official Claude Code package publishes no
shim, so without the second check a stale process reports it as missing.

That scan is deliberately bounded: one directory level, an exact name prefix, no
recursion, no other package, and nothing outside WinGet's own tree. It reads
directory names only, and an absent or unreadable `Packages` directory yields no
candidate rather than an error.

---

## 5. Filesystem and Git safety

### Isolation

Agent work never happens in your checkout. Each task gets:

* a dedicated branch, `agent-relay/<short-id>-<slug>`, built from a strict
  `[a-z0-9-]` allow-list rather than by escaping a free-form title;
* a dedicated `git worktree` under the application-managed worktrees root.

Before anything is created, the path must satisfy `assertSafeWorktreePath()`:
absolute, free of control characters, **inside** the worktrees root (by real
containment, so `…/worktrees-evil` is not inside `…/worktrees`), not equal to or
inside the repository, and not a filesystem root. Two live tasks can never share
a worktree directory.

### Destructive Git commands are refused

`CliGitAdapter` rejects these outright, checked against the argv array:

`reset --hard` · `clean -f…` · `push --force` / `-f` / `--force-with-lease` ·
`branch -d` / `-D` / `--delete` · `checkout --force` ·
`worktree remove --force` · `rebase` · `filter-branch`

`removeWorktree` deliberately omits `--force`: if the worktree still has
uncommitted work, Git refuses and Agent Relay surfaces that rather than
destroying it.

### Claude is told not to publish, and directly-named attempts are refused

The implementation prompt explicitly forbids `git commit`, `git push`,
`git reset --hard`, `git clean`, creating a pull request, touching a remote, and
editing anything outside the worktree.

The prompt is only instruction. What backs it is the deny list below, which
refuses those commands when a tool call names them directly — so the promise no
longer rests solely on the model choosing to comply. It is not the same thing as
making the operations impossible; see the limits at the end of this section.

### What Claude Code is allowed to do

Claude runs headless, with nobody available to answer a permission prompt. Four
flags shape what it can reach, and each does something narrower than its name
suggests.

**`--permission-mode acceptEdits`** lets it write files without asking. That is
the point of the isolated worktree: edits land on a dedicated branch in a
directory that is not your checkout. It also means some worktree-scoped
filesystem operations and read-only commands proceed on their own.

**`--setting-sources project`** excludes the operator's *user* and *local*
configuration — personal permission rules, plugins, hooks and MCP servers
belonging to unrelated work. Without it, what an unattended agent may do depends
on whatever else that person has been doing, the same task behaves differently
on two machines, and a rule written months ago for another project silently
applies here. **Verified**, by running one command that a personal rule allows:
it ran without the flag and was refused with it.

The **target repository's own project settings still load**, and may add
permissions or hooks of their own. That is deliberate — a project's `CLAUDE.md`
and configuration are context the implementation needs — but it means a
repository you do not trust can widen what is pre-approved inside its own task.

**`--allowedTools`** carries the rules from *Settings → Claude permissions*, one
per line, as separate argv entries. It **pre-approves** matching tool calls so
they run without a prompt. It is *not* an exclusive allowlist: a call matching
nothing here is not thereby refused — it falls through to the permission mode
and the project's settings, as described above. The default pre-approves running
the tests, through either shell:

```
Bash(npm test *)
PowerShell(npm test *)
```

Both spellings are present because Claude picks the shell itself; in the live
probe it reached for PowerShell. Rules are trimmed, length-limited, rejected if
they contain control characters, and capped at 50. An empty list pre-approves no
commands at all — Claude can still edit files, and anything needing approval is
denied rather than waiting.

**`--disallowedTools`** carries a fixed list that Settings cannot reach and
project configuration cannot loosen, covering both `Bash(…)` and `PowerShell(…)`
forms of:

`git commit` · `git push` · `git reset` · `git clean` · `git checkout` ·
`git switch` · `git merge` · `git rebase` · `gh`

Each appears in three spellings — bare, `:*` and ` *` — so the bare command and
its argument forms all match. These are the operations Agent Relay reserves for
its own confirmation dialog, plus the Git commands that could move work out of
the worktree the task is isolated in.

**What this is not.** The deny list is a command-pattern filter over what a tool
call literally says. It refuses a direct `git commit`; it does not see the same
operation reached indirectly through a project script, a task runner, an alias,
or a program that calls Git as a library. Treat it as closing the obvious path,
not as a boundary that holds against a determined or confused agent. The
isolation that genuinely holds remains the separate worktree and branch.

`--dangerously-skip-permissions` is never used, and neither is `--bare`: it
would also discard `CLAUDE.md` and the project context the implementation needs.

### Listing Codex models exposes four fields and nothing else

The catalogue speaks JSON-RPC to `codex app-server` — `initialize`,
`initialized`, `model/list` — and never opens a thread or a turn, so listing
models cannot cost anything or touch a conversation. The handshake replies with
`codexHome`, `userAgent` and platform details; none of it is retained. What
reaches the renderer is `model`, `displayName`, `description`, `isDefault`, plus
a short `detail` string when the list is unavailable. Raw stdout, stderr and the
catalogue's internal `id` never cross the boundary.

Anything unexpected — non-JSON output, a JSON-RPC error, a missing result, an
unsolicited or repeated response id, a repeated page cursor, more than ten
pages, a timeout, a non-zero exit — produces `available: false` with an empty
list. A partial catalogue is never returned, and no exception reaches the
renderer.

### Model selection is a task snapshot, and never silently substituted

Each task stores the Codex and Claude models it was created with. Runtime reads
them from the task, not from current Settings, so editing Settings cannot change
what an in-flight task runs, and resuming a Codex thread or a Claude session
always uses the model that conversation started with.

Neither picker validates against a closed list — a model your account cannot use
is rejected by the tool. When that happens the run fails with an error naming the
model. Agent Relay never falls back to a different model and never retries: a
result quietly produced by a model the user did not choose would be worse than a
visible failure.

### A denied tool call is judged on the evidence

In `--print` mode a refused tool call is not an error from the CLI's side. It
reports the denial, the model carries on — often working around it — and the
process still exits `0` with a result envelope that says `success`.

Taken at face value, a round where the tests were blocked is indistinguishable
from one where they passed. Agent Relay therefore reconstructs what actually
happened from the stream and decides from that.

**What is collected.** Every tool call and its result, correlated strictly by
`tool_use.id` and numbered in invocation order; every denial, from both
`permission_denied` events and the `permission_denials` array, deduplicated by
`tool_use_id`; and whether the stream was complete — a final envelope, no
unreadable lines, no calls left unanswered. Commands and reasons are redacted
before truncation, so a secret on the boundary cannot survive as a fragment.

**How a denial is classified.** From the command alone, never from the reason
text — prose changes between CLI versions, and a wording change must not be able
to reclassify a blocked push:

| Category | Meaning |
| --- | --- |
| **security** | Names something on the deny list, in any segment of a chained command. |
| **verification** | Matches a configured verification rule. |
| **auxiliary** | A readable, ordinary command that proves nothing and threatens nothing. |
| **unknown** | Anything that cannot be read: no command, a truncated preview, no link to an invocation, or a chained command with nothing forbidden visible. |

**What fails the round.** A security denial; a denial that cannot be classified;
a verification denial that was never re-run; no verification attempt at all;
ambiguous verification telemetry; a missing, contradicted or failing final
envelope; an error the CLI raised, even when the envelope then claimed success;
an unreadable line anywhere in the stream; and any gap in the record of what ran
— a call with no result, a result belonging to no call, or two results that
disagreed. Each returns the task to a retryable state with an error naming what
the evidence showed.

An incomplete record is failed rather than warned about on purpose. "We noticed
the account of this round is missing a piece" and "we acted on it" are different
things, and only the second one keeps unverifiable work from being published.

**What does not.** An auxiliary denial in a round whose verification ran and
passed. That is now a warning on a successful round, because claiming the tests
"may have been skipped" when the same stream shows them passing is simply false,
and a warning that is routinely false is one people learn to ignore.

**A verification denial can be resolved.** If the blocked command is later run
again — same tool, same rule, higher invocation number, and a definitive result
— the denial no longer stands. A higher invocation number alone is not enough,
and a later *different* command resolves nothing. Invocation numbers restart
with every Claude process, so they are only ever compared within one round.

**Failing tests are a warning, not a failure.** The round reaches the reviewer;
publishing is blocked until a later round passes.

### Publishing requires evidence, not just approval

Codex approving a diff means somebody read the change. It does not mean the
change was ever run. Before any commit, push or pull request, the publish gate
also requires that the most recent Claude round recorded a version-1 assessment
with no publish block — in addition to the Codex approval and the confirmation
dialog, neither of which it replaces.

Absence is a refusal. A task from before this existed, a record that cannot be
parsed, and a record written by a newer version are all blocked, and the verdict
is never reconstructed from a run's final message: what the model said about
itself is not evidence.

A block is not permanent, and a refused publish is not a dead end. A task in
*Ready to publish* whose round the gate refused can start another Claude round
directly — the reviewer was satisfied, so there are no findings to act on, and
the round gets a prompt saying the change was approved but its checks did not
pass. That round goes back through *Ready for review*, so a **new** Codex review
and a **new** publish approval are both required before the gate is asked again.
The earlier denial stays in the run history; nothing is rewritten.

### Verification rules are configuration, and are re-checked

*Settings → Claude verification commands* is validated in three places, and only
the last two of them count.

The renderer disables Save and explains what is wrong, which is a convenience.
The **settings repository** re-runs the same validator inside `update()`, so a
configuration no round could satisfy cannot be written by any path that reaches
the table — not the form, not IPC, not a future caller. The **orchestrator**
checks once more before each round, because a row can still arrive from a hand
edit or an older build.

That check runs *before* the branch and worktree are created, so a round that
cannot legally start leaves nothing behind: no branch, no directory, no run row
that could be mistaken for an attempt, and no change of task status.

One consequence worth stating plainly: the pre-approved list can no longer be
emptied. Every verification rule must also be pre-approved, so granting nothing
would leave a configuration that could only ever be denied.

**One reading of Settings per round.** The rules the CLI is given and the rules
the round is judged against come from a single snapshot taken immediately before
the process starts, and that snapshot is passed to the adapter rather than read
again by it. Preparing a worktree takes long enough for Settings to be saved
underneath it, and a round argued against rules the process never had would be
worse than either version alone.

### Codex reviews are read-only

`reviewImplementation()` hard-codes `sandboxMode: 'read-only'` with
`networkAccessEnabled: false`, and does not accept an override.

---

## 6. The publishing gate

No commit, push, repository creation, or pull request can happen without a
**native modal dialog owned by the main process**.

A React modal would be the wrong gate: the renderer is the least trusted part of
the application, so anything that could call the IPC bridge could also "click
yes". A main-process dialog cannot be dismissed by renderer code at all.

The sequence, in order:

1. The task must be in `READY_TO_PUBLISH` — meaning Codex approved **and** the
   user then pressed "Approve for publishing".
2. An `Approval` row is written as `pending` **before** the user is asked, so a
   crash mid-dialog leaves evidence rather than nothing.
3. `ConfirmationService.confirm()` must return true. The dialog shows the
   account/owner, repository, visibility, branch, the exact action, and whether
   it reaches the network. Cancel is the default button and the Escape action.
4. `assertPublishable()` re-checks the status and the approval in the domain
   layer.
5. Only then is the adapter called.

Step 5 is unreachable without step 3. Tests assert this for all four actions,
and assert that a denied confirmation leaves the repository and GitHub untouched
while recording the refusal.

---

## 7. What this does **not** protect you from

Being honest about the boundary matters more than the list above.

* **Claude Code can modify any file inside its worktree, and can run commands.**
  It is given `--permission-mode acceptEdits` so it can work unattended; what is
  listed in *Settings → Claude permissions* runs without a prompt, and that list
  is a pre-approval rather than the full extent of what is possible — read-only
  commands and the repository's own project settings can permit more. Agent
  Relay does not sandbox it beyond the worktree. The deny list closes the
  directly-named commands that would commit, publish, or move work out of the
  worktree, but it is a command-pattern filter: an indirect invocation — a
  script that shells out, a task runner wrapping `git` — is not something
  pattern matching can catch. Grant narrowly, and run Agent Relay on code you
  trust. The isolation that genuinely holds is that the worktree is a separate
  directory on a separate branch — your checkout and your other branches are not
  touched.
* **Prompt injection is not solved.** Content in the repository being worked on
  is fed to both models. A hostile repository could attempt to steer either
  agent. Only run Agent Relay on code you trust.
* **Codex's review is advisory.** An "approved" verdict is a model's opinion,
  not a guarantee of correctness. The publishing confirmation exists precisely
  because a human should look before anything ships.
* **The diff sent for review may be truncated** at the configured budget. A
  review of a truncated diff is a review of part of the change; the prompt tells
  the model to say so, but it may not.
* **Redaction is heuristic.** It catches the token formats listed above. A
  credential in an unusual format could pass through into the database.
* **Local data is not encrypted.** `agent-relay.sqlite` holds task history,
  prompts, agent output, and session identifiers in plain text under your user
  profile. Session identifiers are not credentials, but they do reference
  conversations stored by Codex and Claude.
* **Third-party agents receive your code.** Codex and Claude Code are remote
  services. Their own data handling applies.

---

## 8. Reporting

This is an MVP built for a single local user. If you find a way to make it
commit, push, or reach GitHub without the confirmation dialog, that is the bug
class most worth reporting — the whole design is arranged around that gate.
