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

### Recovering from an abrupt exit

A run is written as `running` before an agent is spawned, and the task moves
into a busy status around the same moment. Nothing else ever closes those rows:
the orchestrator only finishes runs it started itself. A crash, a reboot or a
forced quit therefore leaves a task claiming work is in progress that is not,
with every button that matters disabled — permanently, because the next launch
has no reason to think otherwise.

[`startup-reconciliation.ts`](../src/main/services/startup-reconciliation.ts)
corrects that, and runs inside `buildApplication()` — before IPC is registered
and before a window exists, so no new work can race the repair.

It is two pieces. `planReconciliation()` is pure: rows in, changes out, no
clock and no database, so the judgement calls are testable on their own.
`applyReconciliation()` performs the plan through the repositories inside one
transaction, because a task returned to a usable status while its run still
claims to be running would invite a second agent against the same worktree.

| Left in | Recovered with | Ends at |
|---------|----------------|---------|
| `SPECIFYING` | `specification_aborted` | `DRAFT` |
| `IMPLEMENTING`, implementation round | `implementation_aborted` | `READY_FOR_IMPLEMENTATION` |
| `IMPLEMENTING`, correction round | `correction_aborted` | `CHANGES_REQUESTED` |
| `REVIEWING` | `review_aborted` | `READY_FOR_REVIEW` |
| `PUBLISHING` | `publish_aborted` | `READY_TO_PUBLISH` |

Every stale run is closed as **failed** with a neutral reason — *"Agent Relay
stopped before this run completed; recovered during startup."* Not `cancelled`,
which would put a decision in the user's mouth, and not a success, because there
is no result: that absence is the whole problem.

Two independent decisions, and the independence is the point. **Every** running
run is closed, whatever its task now claims — a specification run is written
before the task becomes `SPECIFYING`, and a review run can outlive `REVIEWING`,
so a stale run routinely belongs to a task that is already in a good state.
**Only** a busy task is moved, and only once however many stale runs it has;
rolling a settled task back because of a leftover run would undo work the user
can see.

Which kind of Claude round `IMPLEMENTING` was part-way through has exactly two
answers, in order:

1. **A run still marked `running` for the task's current round.** Runs are
   written with `round: task.currentRound`, so such a row is the work that was
   actually in flight. If more than one exists, the greatest round wins, then the
   latest start, then the greatest id — a total order, so the answer never
   depends on which row SQLite returned first.
2. **The round counter.** The first implementation sets `currentRound` to 1 and
   every `corrections_sent` increments it, so `IMPLEMENTING` at round 2 or above
   can only have been reached through a correction; at round 1 it is the first
   implementation.

A task's **finished** runs are deliberately not consulted. `sendCorrections`
moves the task and increments the round *before* the recorder writes the new run,
and in that window the newest Claude run is still the previous *implementation*.
Reading intent from it recovered a first correction as
`READY_FOR_IMPLEMENTATION`, discarding the review the user was acting on. A
finished round records what already happened; it says nothing about what the next
one was going to be.

Contradictory data falls to the counter — a running row whose round does not
match the task's is debris the state machine has already moved past, and the
counter is what the machine itself maintains.

Nothing is resumed. No agent starts, no Git command runs, no worktree or branch
is touched, no session or thread id changes, no round is counted, and no
approval is granted or revoked. The work is handed back for the user to restart
if they want to.

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

One narrow exception to "run once, collect output": `InteractiveProcessRunner`,
implemented by the same class, keeps stdin open so a line-oriented protocol can
be driven turn by turn. It exists because `codex app-server` starts shutting
down at stdin EOF and never answers, so `run({ input })` cannot talk to it. The
controller handed to callers exposes only `writeLine` and `closeInput`, input is
bounded by message count and bytes, embedded newlines are refused (framing is
one record per line), and every security flag comes from the same shared options
builder as the other two paths.

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
* `model` comes from the **task**, on the request, not from adapter
  configuration. Adapters are rebuilt from Settings on every call, so a
  constructor option would make an existing thread follow whatever Settings
  currently say. `startThread` and `resumeThread` receive the same options
  object, so both carry the task's model; `null` omits the key entirely.
* **Review also runs `read-only`, and that is not configurable** — a review that
  can edit the code it is judging is not a review.
* The same Zod schema that validates the response is projected to JSON Schema via
  `z.toJSONSchema()` and passed as `outputSchema`, so the model is constrained on
  the way out and checked on the way in. One definition, no drift.

### Claude Code — CLI, print mode

```
claude --print --output-format stream-json --verbose
       --setting-sources project
       --permission-mode acceptEdits --max-turns <n>
       [--model <task model>] [--resume <session-id>]
       [--allowedTools <rule> …] --disallowedTools <rule> …
```

* `--model` is the task's snapshot and is passed on a fresh run and alongside
  `--resume` alike, so a correction round never changes model mid-conversation.
  A task with no override omits the flag. An unusable model produces a
  `TOOL_FAILED` naming it — never a retry with something else.

* The prompt goes down **stdin**, never on the command line: a specification plus
  a review follow-up routinely exceeds the ~32 KB Windows command-line limit.
* `--dangerously-skip-permissions` is never used.
* `--setting-sources project` keeps the run reproducible by excluding the
  operator's personal Claude configuration; the target repository's own project
  settings still load. Both permission lists go last, because they are variadic;
  each rule is its own argv entry.
* `--allowedTools` **pre-approves** matching calls rather than restricting the
  set — unmatched calls fall through to the permission mode and project
  settings. It comes from Settings and defaults to running the project's tests
  through either shell. The deny list is fixed, not user-editable, and refuses
  directly-named Git/GitHub commands only. See [security.md](security.md) §5.
* The stream parser is deliberately permissive — an unrecognised event type is
  surfaced as generic progress, never thrown, so a CLI upgrade cannot break a
  running round. It **collects evidence and does not judge**: tool calls
  correlated by `tool_use.id` and numbered in invocation order, results with
  their `is_error` flag, denials with the command that was refused, and whether
  the stream was complete. `isError` on the result means only that the CLI
  reported a failure.

### Round policy

What a Claude round *proved* is decided by a pure function, separately from
parsing it:

```
shared/domain/claude-tool-rules.ts   grammar, command normalisation, the deny list
        ▲                    ▲
        │                    │
adapters/claude          services/claude-round-policy.ts   evidence → verdict
(--disallowedTools)              │
                                 ▼
                         services/claude-round-report.ts   verdict → record + text
                                 │
                                 ▼
                         shared/domain/claude-assessment.ts   versioned DTO
```

* **`claude-tool-rules`** is in `shared` because three places need the same
  answers: the adapter building `--disallowedTools`, the policy classifying
  denials, and the Settings form validating what the user typed. A second copy
  would be a second source of truth for a security decision.
* **`claude-round-policy`** is in `services` because it is defined over the
  evidence contract in `ports.ts`; a module in `shared` importing from `main`
  would invert the dependency direction.
* **`claude-assessment`** is the narrow, versioned thing that crosses into the
  renderer and into `runs.structured_result`. It carries redacted, bounded text
  and never raw tool output, and reading it never throws — an older run, a newer
  version and a hand-edited row each come back as a describable absence.

The orchestrator validates the verification configuration twice: once in
`sendToClaude`/`sendCorrections` before the worktree is created, so an unusable
configuration leaves no branch or directory behind, and once inside `runClaude`
against the snapshot the round will actually use. That snapshot is read
immediately before the process starts and supplies the permission rules, the
turn limit, the timeout, the log budget and the policy configuration — and it is
passed to the adapter through the request, so the adapter does not read Settings
a second time and reach a different answer.

`pass`/`warn` map to a succeeded run, `fail` to the existing recoverable state,
and a round worth a second look gets a `warning` event. `warning` is an event
type, not a run status: the run did succeed, and a fourth outcome would make
every consumer that switches on status wrong at once.

`READY_TO_PUBLISH` gains one transition, `corrections_sent → IMPLEMENTING`, so a
task the publish gate refused can run another round instead of being cancelled.
It is an edge, not a status: the round returns through `READY_FOR_REVIEW`, which
is what forces a new review and a new publish approval.

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

760 tests, none of which contact Codex, Claude, or GitHub.

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
