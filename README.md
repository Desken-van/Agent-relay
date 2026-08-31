# Agent Relay

A local Windows desktop application that relays one software task between two
coding agents:

> **Codex** writes the specification → you approve it → **Claude Code**
> implements it in an isolated Git worktree → **Codex** reviews the result in
> read-only mode → its feedback goes back to the *same* Claude session →
> repeat until Codex approves, you stop it, or the review-round budget runs out.

Nothing is committed, pushed, or published without an explicit confirmation
dialog owned by the main process.

<!-- Screenshot: the Projects screen with the tool-diagnostics rail. -->

---

## Table of contents

- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Install and run](#install-and-run)
- [Signing in to the three tools](#signing-in-to-the-three-tools)
- [Architecture](#architecture)
- [Security model](#security-model)
- [How sessions are stored and resumed](#how-sessions-are-stored-and-resumed)
- [How worktrees are managed](#how-worktrees-are-managed)
- [Development commands](#development-commands)
- [Verification status](#verification-status)
- [Known limitations](#known-limitations)
- [Manual end-to-end test](#manual-end-to-end-test)

---

## What it does

| Screen | Purpose |
|--------|---------|
| **Projects** | Register an existing Git repository, or create a new project folder. Shows live validation: branch, cleanliness, remote, commit identity. |
| **Tasks** | Describe a task in plain language and set its review-round budget. |
| **Run** | The workflow timeline — Codex on the left lane, Claude on the right, Agent Relay in the middle — plus live logs, the specification, review findings by severity, changed files, the diff, and the action buttons. |
| **Settings** | Diagnostics for Codex / Claude Code / Git / GitHub CLI, executable paths, roots, and limits. |

Every action button carries a **blast-radius marker**:
🔵 reads only · 🟡 writes local files · 🔴 reaches GitHub.

---

## Requirements

| | Needed for | Notes |
|---|---|---|
| **Node.js ≥ 22.13** | everything | Required for the built-in `node:sqlite` module |
| **Git** | everything | Plus `user.name` / `user.email` before any commit |
| **Codex** | specification + review | Ships with the app's dependencies; you only need to log in |
| **Claude Code CLI** | implementation | `winget install --id Anthropic.ClaudeCode -e` |
| **GitHub CLI (`gh`)** | publishing only | Optional — everything else works without it |

The app **starts and stays usable when any of these are missing**, and tells you
exactly what to install. It does not crash on a bare machine.

There is **no native module and no compile step** — no Visual Studio Build
Tools, no Python, no `node-gyp`.

---

## Install and run

```powershell
cd H:\Agent-relay
npm install

npm run dev      # development, with hot reload
# or
npm run build
npm start        # run the production build
```

> **If you launch Electron by hand from a VS Code terminal** and see
> *"The requested module 'electron' does not provide an export named
> 'BrowserWindow'"*, the cause is `ELECTRON_RUN_AS_NODE=1`, which VS Code's
> extension host sets and terminals inherit. It makes `electron.exe` run as
> plain Node. `npm run dev` and `npm start` strip it for you
> (`scripts/launch.mjs`); to do it manually:
> ```powershell
> Remove-Item Env:ELECTRON_RUN_AS_NODE
> ```

---

## Signing in to the three tools

Agent Relay **never asks you for a key, token, or password** and has nowhere to
put one. Each tool authenticates itself.

### Codex

The Codex CLI is installed as a dependency of `@openai/codex-sdk`, so you do not
need a separate install.

```powershell
npx codex login          # opens a browser; ChatGPT or API-key sign-in
npx codex login status   # → "Logged in using ChatGPT"
```

Credentials live in `~/.codex`. Threads are persisted there too, which is what
makes resuming a conversation possible.

### Claude Code

```powershell
winget install --id Anthropic.ClaudeCode -e
# open a new terminal: the installer appends to PATH
claude                   # run once and complete the login flow
claude auth status       # → "loggedIn": true
```

Credentials live in `~/.claude`. If `claude` is not discoverable, set an
explicit path in **Settings → Executables**; Agent Relay looks in your
configured path, then `PATH`, then the standard Windows install locations.

Two of those cover WinGet, because its `PATH` change only reaches processes
started *after* the install — so a window launched from an already-open shell
would otherwise report a freshly installed Claude as missing:

* `%LOCALAPPDATA%\Microsoft\WinGet\Links`, where WinGet puts a shim **when a
  package publishes one** — not every package does;
* direct children of `%LOCALAPPDATA%\Microsoft\WinGet\Packages` named
  `Anthropic.ClaudeCode_*`, checked for a `claude.exe` sitting directly inside.
  This is what finds the official Claude Code package, which ships no shim.

The scan does not recurse, matches no other package, and never reads VS Code
extension internals or another application's private files.

### Choosing models per task

Each task picks its own pair on the **New task** form:

| Picker | Used for |
|---|---|
| **Codex model** | the specification, every regeneration, and every review |
| **Claude model** | the implementation and every correction round |

The **Codex** list is read live from the CLI (`codex app-server` → `model/list`),
showing each picker-visible model's display name and marking the account
default; hidden models are excluded. If that list cannot be read the picker
still works — **Tool default** and **Custom model ID** remain, with a *Retry*
button and a note explaining why. **Claude** lists the documented aliases
`opus`, `sonnet`, `haiku`, `fable`.

Neither list is a validation allow-list: a model your account cannot use is
refused by the tool, not by Agent Relay, and the resulting error names the model
rather than quietly substituting another. The catalogue fallback is a *display*
fallback only — a task that stored a model always runs on that model or fails.

The pair is a **snapshot taken when the task is created** and cannot be changed
afterwards. That is deliberate: a task's Codex thread and Claude session are
resumed for reviews and corrections, and swapping the model underneath an
existing conversation is behaviour neither tool defines. The two fields under
*Settings → Locations* are only defaults for the form — changing them never
affects a task that already exists.

Reasoning effort is left to each model's own default and is not stored. Note
that it varies between models, so changing model can change effort as a side
effect.

### What Claude is allowed to run

Claude works unattended, so **Settings → Claude permissions** lists the shell
commands Agent Relay *pre-approves* — they run without a prompt. The default is
the narrowest thing that still lets Claude verify its own work, in either shell:

```
Bash(npm test *)
PowerShell(npm test *)
```

This is a pre-approval, not the whole picture. Under `acceptEdits` Claude also
edits files in its worktree, and some read-only commands run on their own.

Agent Relay passes `--setting-sources project`, so your personal Claude
settings, plugins and permission rules from other work are not inherited into a
task — but the **target repository's own project settings still load** and may
add permissions or hooks.

Commit, push, reset, clean, checkout, switch, merge, rebase and `gh` are refused
when a command names them directly, and Settings cannot re-enable them.
That is a command-pattern filter rather than a sandbox: a project script that
wraps one of them is not caught, so run Agent Relay on code you trust.
Publishing still requires the confirmation dialog.

If a tool call is refused, the round **fails** rather than quietly continuing —
otherwise an implementation whose tests never ran would reach the reviewer
looking healthy. See [docs/security.md](docs/security.md) §5.

### GitHub CLI

```powershell
winget install --id GitHub.cli
gh auth login
gh auth status
```

Agent Relay parses `gh auth status` for **account names only**. It never runs
`gh auth token` and never passes `--show-token`.

The default GitHub owner is `Desken-van`, changeable in Settings.

---

## Architecture

Full detail in **[docs/architecture.md](docs/architecture.md)**. In short:

```
Renderer (React)  →  preload bridge  →  Zod-validated IPC  →  services
                                                              ↓ (ports)
                                        adapters: Codex SDK · Claude CLI · Git · gh
                                                              ↓
                                                     SQLite repositories
```

Dependencies point one way. Everything external sits behind an interface in
[`src/main/ports.ts`](src/main/ports.ts) — `CodexAdapter`, `ClaudeAdapter`,
`GitAdapter`, `GitHubAdapter`, the four repositories, `ConfirmationService`,
`Clock`, `IdGenerator` — which is why the whole relay loop is tested without a
network.

The workflow is an explicit finite state machine in
[`src/shared/domain/workflow.ts`](src/shared/domain/workflow.ts) with thirteen
states and one transition table. **Invalid transitions throw**, terminal states
have no outgoing edges, and no code path assigns a status any other way.

---

## Security model

Full detail in **[docs/security.md](docs/security.md)**, including an honest
"what this does *not* protect you from" section. Highlights:

* **No credentials, anywhere.** Not in code, prompts, logs, SQLite,
  `localStorage`, fixtures, or `.env.example`.
* **Output redaction.** Everything persisted or displayed passes through a
  redactor for GitHub/OpenAI/Anthropic tokens, JWTs, `Authorization` headers,
  and credentials in URLs.
* **Environment compartmentalisation.** `git` cannot see your GitHub token;
  Codex cannot see your Anthropic key. Each adapter declares only the credential
  variables it owns.
* **Electron hardening.** `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`, strict CSP, navigation blocked, all permissions denied,
  single instance.
* **No command channel.** The renderer cannot name anything to execute. Every
  IPC payload is validated by a `.strict()` Zod schema in the main process.
* **No shell.** Child processes always receive an argument *array*;
  `shell: false` is unconditional.
* **Destructive Git commands are refused** by the adapter itself:
  `reset --hard`, `clean -f`, force push, branch deletion, `checkout --force`,
  `worktree remove --force`, `rebase`, `filter-branch`.
* **`--dangerously-skip-permissions` is never used.**
* **Publishing requires a native modal dialog** owned by the main process — a
  renderer cannot answer it — plus a granted `Approval` row and a publishable
  status.

---

## How sessions are stored and resumed

Both agents are conversational, and both expose a durable identifier. Agent
Relay stores them in SQLite on the `tasks` row rather than in memory, which is
the only reason a task survives a restart:

| Column | Holds | Used for |
|---|---|---|
| `codex_thread_id` | the Codex thread id, from the `thread.started` event | `codex.resumeThread(id)` for the review and for regenerating a spec |
| `claude_session_id` | the Claude session id, parsed from the `stream-json` output | `claude --resume <id>` for every correction round |

So a correction round continues the *same* Claude conversation — it still has
the context of what it built — and a review continues the same Codex thread that
wrote the specification.

Codex persists its threads in `~/.codex/sessions`; Claude Code persists its
sessions in `~/.claude`. Agent Relay stores only the identifiers.

Verified: resuming a Codex thread from a *new* client process (simulating an
application restart) returns the earlier conversation's content.

---

## How worktrees are managed

For each task, on the first *Send to Claude*:

1. The repository is inspected and the base branch is verified to exist.
2. A dirty working tree blocks the task unless you explicitly accept it.
3. A branch name is built from a strict allow-list:
   `agent-relay/<short-task-id>-<slug>`.
4. The worktree path is computed under the configured **worktrees root** and
   checked by `assertSafeWorktreePath()`: absolute, no control characters, truly
   inside the root, not equal to or inside the repository, not a filesystem root.
5. No other live task may own the same directory.
6. `git worktree add -b <branch> <path> <base>` creates both atomically.

Claude runs with its working directory set to that worktree and nowhere else.
Your checkout is only ever read.

Before a review, Agent Relay collects `git status --short`, the changed-file list
with per-file line counts, `git diff --stat`, and the full diff against the
merge-base with the base branch (truncated to a configurable budget), plus any
commits on the task branch.

Agent Relay **never commits the agent's work automatically**. To make untracked
files visible to `git diff` it runs `git add --intent-to-add --all` *inside the
task's own worktree* — this writes no object and creates no commit.

Removing a worktree deliberately omits `--force`: if there is uncommitted work,
Git refuses and you are told, rather than losing it.

---

## Development commands

| Command | What it does |
|---|---|
| `npm run dev` | Development with hot reload |
| `npm run build` | Production build into `out/` |
| `npm start` | Run the production build |
| `npm test` | Vitest, once |
| `npm run test:watch` | Vitest, watch mode |
| `npm run lint` | ESLint over everything |
| `npm run typecheck` | `tsc --noEmit` for both the Node and web projects |
| `npm run verify` | lint → typecheck → test → build |

---

## Verification status

Being precise about what was actually exercised, rather than merely written:

| Integration | Status |
|---|---|
| **Codex SDK** | ✅ **Genuinely verified end to end.** Streaming events, `thread.started` ids, `outputSchema`-constrained structured output validating against the Zod schema, and thread resume from a *new* client process. Its diagnostic reports green in the running app. |
| **Git** | ✅ **Genuinely verified.** 19 integration tests drive the real `git` binary against real temporary repositories: worktree creation and isolation, change collection, diff truncation, refusal to force-remove, commit, and the destructive-command guard. |
| **SQLite** | ✅ **Genuinely verified.** Migrations, cascades, ordering, and on-disk durability across close/reopen — and confirmed running inside Electron. |
| **Electron app** | ✅ **Genuinely verified.** Launches on Windows 11, creates its database in WAL mode, renders the UI, and completes a full renderer→main→adapter→renderer diagnostics round-trip. |
| **Claude Code CLI** | ⚠️ **Not verified against a live CLI** — it is not installed on this machine. The adapter is written against the documented `--print --output-format stream-json` contract, and its parser, argument construction, `--resume` handling, stdin prompt delivery, auth-failure detection, and timeout behaviour are covered by tests using an injected process runner. Treat the first real run as the acceptance test. |
| **GitHub CLI** | ⚠️ **Not verified against a live `gh`** — not installed. `gh auth status` parsing (both modern and legacy formats), URL extraction, and owner/repo validation are unit-tested. **No real GitHub mutation was performed at any point.** |

Test suite: **269 tests, 10 files, all passing.** No test contacts Codex,
Claude, or GitHub.

---

## Known limitations

* **Claude Code and GitHub CLI are unverified against live tools** on this
  machine — see the table above.
* **`node:sqlite` is marked experimental upstream.** It was chosen over a native
  binding because `better-sqlite3` publishes no prebuilt binary for Electron's
  current ABI, so installing it would require Visual Studio Build Tools and a
  Python with `distutils` (removed in Python 3.12+). Node emits an
  `ExperimentalWarning` under Node 22; the API used here is small and stable.
* **Agent Relay does not run your test suite.** It has no reliable way to know
  the command. Claude is instructed to run the tests and paste the output, and
  Agent Relay lifts fenced command output from that report to hand to the
  reviewer separately. If Claude does not run tests, the reviewer sees no test
  output.
* **Large diffs are truncated** before review, at the configured budget. The
  reviewer is told the diff was truncated, but a truncated review is a partial
  review.
* **"Do not commit" is an instruction to Claude, not an enforced sandbox.** The
  isolation that genuinely holds is the separate worktree and branch.
* **Stopping a task is terminal.** *Stop* moves it to `CANCELLED` — one of the
  three documented ways the relay loop ends. There is no resume-after-stop.
* **A publish step is not automatically retried**, and the sequence
  (commit → create repo → push → PR) is driven manually, one confirmation each.
* **Single window, single instance**, and no packaging/installer target is
  configured — this is a run-from-source MVP.
* **No project scaffolding.** Creating a "new project" makes exactly one empty
  folder; `git init` is a separate, confirmed action.

---

## Manual end-to-end test

Step-by-step instructions, including how to verify that cancelling a
confirmation genuinely changes nothing, are in
**[docs/manual-test.md](docs/manual-test.md)**.

---

## Layout

```
agent-relay/
├─ src/
│  ├─ main/            Electron main process
│  │  ├─ adapters/     codex · claude · git · github · process
│  │  ├─ db/           sqlite facade, migrations, repositories
│  │  ├─ ipc/          the single validated invoke channel
│  │  ├─ services/     orchestrator, publish, project, task, diagnostics
│  │  ├─ container.ts  composition root
│  │  └─ ports.ts      every external integration, as an interface
│  ├─ preload/         the entire renderer-facing surface (2 functions)
│  ├─ renderer/        React UI
│  └─ shared/          domain models, workflow FSM, Zod schemas, IPC contract
├─ tests/              269 tests; no network, no real agents
├─ docs/               architecture · security · manual-test
└─ scripts/launch.mjs  dev/start launcher (strips ELECTRON_RUN_AS_NODE)
```
