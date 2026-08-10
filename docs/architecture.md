# Architecture

Agent Relay is an Electron desktop application that relays one software task
between two agents: **Codex** specifies and reviews, **Claude Code** implements.
All the work happens inside a dedicated Git worktree, and nothing leaves the
machine without an explicit confirmation.

---

## 1. The relay loop

```
                    ┌──────────────────────────────────────────────┐
                    │                  USER                        │
                    └───┬──────────────────────────────────────┬───┘
      describes a task  │                                      │  approves / stops
                        ▼                                      │
              ┌───────────────────┐                            │
              │  CODEX            │  read-only sandbox         │
              │  specification    │  ~/.codex thread stored    │
              └─────────┬─────────┘                            │
                        │  TaskSpecification (Zod-validated)   │
                        ▼                                      │
              ┌───────────────────┐                            │
              │  USER APPROVES    │◄───────────────────────────┘
              └─────────┬─────────┘
                        ▼
              ┌───────────────────┐
              │  GIT              │  branch  agent-relay/<id>-<slug>
              │  worktree created │  worktree under worktreesRoot
              └─────────┬─────────┘
                        ▼
              ┌───────────────────┐
              │  CLAUDE CODE      │  cwd = worktree, --permission-mode acceptEdits
              │  implementation   │  session id stored, resumed via --resume
              └─────────┬─────────┘
                        │  final report + git diff + changed files + test output
                        ▼
              ┌───────────────────┐
              │  CODEX            │  sandboxMode: 'read-only'  ← cannot edit
              │  review           │  CodexReviewResult (Zod-validated)
              └─────────┬─────────┘
                        │
        ┌───────────────┼────────────────┬─────────────────────┐
        ▼               ▼                ▼                     ▼
   approved      changes_requested    blocked          round budget spent
        │          │                    │                     │
        │          │ followUpPrompt     │                     │
        │          ▼                    │                     │
        │   ┌─────────────┐             │                     │
        │   │ CLAUDE      │ same session│                     │
        │   │ correction  │ (--resume)  │                     │
        │   └──────┬──────┘             │                     │
        │          └──────► back to review                    │
        ▼                               ▼                     ▼
    APPROVED                         FAILED                FAILED
        │
        ▼  user presses "Approve for publishing"
  READY_TO_PUBLISH ──► native confirm dialog ──► commit / repo / push / PR
```

The loop is guaranteed to terminate. `decideReviewOutcome()` in
[`src/shared/domain/workflow.ts`](../src/shared/domain/workflow.ts) refuses to
allow another correction round once `currentRound >= maxRounds`, and
`sendCorrections()` re-checks the same budget at its own entry point.

---

## 2. Layers

Dependencies point downwards only. Nothing below layer 3 knows Electron exists.

| # | Layer | Location | Knows about |
|---|-------|----------|-------------|
| 1 | Renderer / UI | `src/renderer` | `window.agentRelay` and shared **types** only |
| 2 | Preload bridge | `src/preload` | `contextBridge`, `ipcRenderer`, two channel names |
| 3 | IPC + validation | `src/main/ipc` | Zod schemas, the handler table |
| 4 | Application services | `src/main/services` | Ports (interfaces) only |
| 5 | Adapters | `src/main/adapters` | Codex SDK, CLIs, child processes |
| 6 | Repositories | `src/main/db` | SQLite |
| 7 | Domain | `src/shared/domain` | Nothing — pure data and pure functions |

### Why the ports layer exists

[`src/main/ports.ts`](../src/main/ports.ts) declares an interface for every
external integration:

`CodexAdapter`, `ClaudeAdapter`, `GitAdapter`, `GitHubAdapter`,
`ProjectRepository`, `TaskRepository`, `RunRepository`, `RunEventRepository`,
`ApprovalRepository`, `SettingsRepository`, `ConfirmationService`, `Clock`,
`IdGenerator`, `EventPublisher`.

The orchestrator depends only on these. That is what makes the whole relay loop
testable without a network: the tests substitute fakes at the composition root
rather than mocking modules, so the code under test is the *real* orchestrator,
the *real* state machine, and the *real* SQLite repositories.

### Composition root

[`src/main/container.ts`](../src/main/container.ts) is the only file that picks
concrete implementations. Adapters are constructed **lazily per call** from the
current settings, so changing an executable path or a timeout in the Settings
screen takes effect on the next operation without restarting the application.

---

## 3. Data model

SQLite, WAL mode, foreign keys on, forward-only migrations
([`src/main/db/migrations.ts`](../src/main/db/migrations.ts)).

```
projects ──┬─< tasks ──┬─< runs ──< run_events
           │           └─< approvals
           settings (key/value)
```

| Table | Purpose |
|-------|---------|
| `projects` | Registered repositories: path, base branch, GitHub target |
| `tasks` | One unit of work: status, round counters, **`codex_thread_id`**, **`claude_session_id`**, branch, worktree, specification and last review as JSON |
| `runs` | One agent invocation: agent, type, status, round, timings, final message, structured result |
| `run_events` | Append-only stream of everything an agent emitted |
| `approvals` | Audit trail for `commit` / `push` / `create_repository` / `create_pull_request` |
| `settings` | Key/value; never holds a credential |

Session identifiers live in the database rather than in memory. That is the only
reason the application can resume a Codex thread or a Claude session after a
restart — verified in `tests/db/repositories.test.ts`.

`run_events` are ordered by SQLite's implicit `rowid`, not by timestamp: agents
routinely emit several events inside the same millisecond, and insertion order is
the only ordering that is actually true.

---

## 4. The state machine

Thirteen states, one transition table, one function that applies it.

```
DRAFT → SPECIFYING → READY_FOR_IMPLEMENTATION → IMPLEMENTING
      → READY_FOR_REVIEW → REVIEWING → { APPROVED | CHANGES_REQUESTED | FAILED }
CHANGES_REQUESTED → IMPLEMENTING (correction round)
APPROVED → READY_TO_PUBLISH → PUBLISHING → COMPLETED
any non-terminal → CANCELLED
```

Rules enforced by [`workflow.ts`](../src/shared/domain/workflow.ts):

* **Invalid transitions throw.** `transition(status, event)` consults
  `TRANSITIONS` and raises `InvalidTransitionError` for anything not listed.
  Nothing in the codebase assigns a status any other way.
* **Terminal states are terminal.** `COMPLETED`, `FAILED` and `CANCELLED` have
  no outgoing edges at all.
* **Recoverable failures rewind rather than kill.** A Codex outage or an
  unparseable response moves `SPECIFYING → DRAFT`, not `SPECIFYING → FAILED`,
  so the user can simply retry — with the Codex thread id preserved, so the
  retry continues the same conversation.
* **Publishing has its own gate.** `assertPublishable()` requires both a granted
  approval *and* a publishable status.

---

## 5. Process execution

Every child process in the application is created in exactly one place:
[`ExecaProcessRunner`](../src/main/adapters/process/process-runner.ts).

* `shell: false`, always. Arguments are passed as an **array**, so a prompt
  containing `&& rm -rf /` is one argv entry, not two commands.
* Output is redacted (`redactSecrets`) before it is returned, because callers
  persist it to SQLite and render it in the UI.
* Retained output is bounded; a runaway agent cannot fill the disk.
* Cancellation is an `AbortSignal`; timeouts are enforced per run.

Executable discovery is explicit
([`executable-locator.ts`](../src/main/adapters/process/executable-locator.ts)):
configured path → `PATH` (honouring `PATHEXT`) → well-known Windows locations.
This matters because on Windows a missing command surfaces as `exit code 1` from
`cmd.exe` rather than `ENOENT`, so "is it installed?" cannot be answered by
trying to spawn it.

---

## 6. Adapters

### Codex — `@openai/codex-sdk` v0.147.0

Implemented against the installed package's own type declarations:

```ts
new Codex({ codexPathOverride?, apiKey?, baseUrl?, config?, env? })
codex.startThread(threadOptions)   // → Thread
codex.resumeThread(id, options)    // → Thread   (threads persist in ~/.codex/sessions)
thread.id                          // string | null
thread.runStreamed(input, { outputSchema, signal })
```

* Specification runs with `sandboxMode: 'read-only'`.
* **Review also runs `read-only`, and that is not configurable** — a review that
  can edit the code it is judging is not a review.
* The same Zod schema that validates the response is projected to JSON Schema via
  `z.toJSONSchema()` and passed as `outputSchema`, so the model is constrained on
  the way out and checked on the way in. One definition, no drift.

### Claude Code — CLI, print mode

```
claude --print --output-format stream-json --verbose
       --permission-mode acceptEdits --max-turns <n> [--resume <session-id>]
```

* The prompt goes down **stdin**, never on the command line: a specification plus
  a review follow-up routinely exceeds the ~32 KB Windows command-line limit.
* `--dangerously-skip-permissions` is never used.
* The stream parser is deliberately permissive — an unrecognised event type is
  surfaced as generic progress, never thrown, so a CLI upgrade cannot break a
  running round.

### Git

All repository access goes through `CliGitAdapter`, which **refuses destructive
subcommands outright**: `reset --hard`, `clean -f`, force push, branch deletion,
`checkout --force`, `worktree remove --force`, `rebase`, `filter-branch`. The
check runs against the argv array, so there is no string to obfuscate through.

### GitHub — `gh` CLI

No token ever passes through Agent Relay. `gh auth status` is parsed for account
names only; `--show-token` is never used.

---

## 7. Renderer

* React 19, no UI framework, no runtime CSS-in-JS.
* State is a single context with a hand-rolled reducer — small enough to read in
  one file, and every mutation originates from either an IPC response or a push
  event.
* Live agent output arrives on the push channel and is buffered in memory (capped
  per run); durable history is re-read from SQLite whenever a task is opened, so
  a dropped push event costs nothing.
* The workflow timeline is the central element: Codex work occupies the left
  lane, Claude's the right, system steps the middle, so a glance shows who holds
  the baton and how many times it has changed hands.
* Every action button carries a **blast-radius marker**: blue = reads only,
  amber = writes local files, red = reaches GitHub.

---

## 8. Testing strategy

248 tests, none of which contact Codex, Claude, or GitHub.

| Suite | What it proves |
|-------|----------------|
| `domain/workflow` | Every transition, terminal states, the round-budget terminator, the publish gate |
| `domain/codex-schemas` | Tolerant JSON extraction, Zod validation, and that the JSON Schema sent to Codex agrees with the validator |
| `services/orchestrator` | The full relay loop against fakes: thread/session reuse, worktree isolation, dirty-tree refusal, round limit, cancellation, restart durability |
| `services/publish-approval` | Publishing cannot occur without approval — for all four actions |
| `services/path-safety` | Invalid worktree paths are rejected, including prefix-collision and traversal |
| `db/repositories` | Round-trips, cascades, ordering, settings validation, on-disk durability |
| `adapters/git-adapter` | **Real `git` against real temporary repositories** |
| `adapters/adapters` | Claude stream parsing, `gh auth status` parsing, prompt construction, executable discovery |
| `security/redaction-and-process` | Credential redaction, environment compartmentalisation, argv-not-shell execution |
