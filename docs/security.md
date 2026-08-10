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

### Claude is told not to publish

The implementation prompt explicitly forbids `git commit`, `git push`,
`git reset --hard`, `git clean`, creating a pull request, touching a remote, and
editing anything outside the worktree. This is instruction, not enforcement —
see "What this does not protect you from" below.

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

* **Claude Code can modify any file inside its worktree, and runs commands.**
  It is given `--permission-mode acceptEdits` so it can work unattended. Agent
  Relay does not sandbox it beyond the worktree, and *"do not commit"* is an
  instruction in a prompt, not an enforced boundary. A determined or confused
  agent could still run `git` itself. The isolation that genuinely holds is that
  the worktree is a separate directory on a separate branch — your checkout and
  your other branches are not touched.
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
