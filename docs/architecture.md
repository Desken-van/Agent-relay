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
  persist it to SQLite and render it in the UI. Redaction happens **per line, as
  the line arrives** — before the bound below can cut it — so a secret straddling
  the truncation point cannot survive as an unrecognisable fragment.
* Retained output is bounded; a runaway agent cannot fill the disk. The bound is
  counted in **UTF-8 bytes**, a cut never lands inside a character, and what is
  kept is always a contiguous prefix — the buffer seals itself on its first
  dropped byte, so nothing after an omission can reappear before it.
* Cancellation is an `AbortSignal`; timeouts are enforced per run. A throw from
  the caller's own line callback is a third way to end a run: the child is killed
  first and the caller's error is reported as the cause, rather than letting the
  process live on until the timeout and be reported as one.
* **stdout and stderr are never merged.** A caller that streams (`onLine`) is
  parsing a protocol, and stderr is where a CLI puts warnings and crash traces.
  Both are drained concurrently — an unread stderr pipe eventually blocks the
  child — but stderr reaches only `onStderrLine` and `ProcessResult.stderr`.
* **`run` is one-shot, and its child's stdin always ends.** With `input`, the
  text is written in full and stdin is then closed. Without it, stdin is
  `/dev/null` — never the parent's — so a child that reads before it works sees
  EOF at once. Left inheriting, such a child waits on a handle nobody will ever
  write to, and the run ends as a timeout with no output and nothing to explain
  it. `runInteractive` is the only API that may keep stdin open.

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

What is found is not always a program. `launchFor()` turns a located path into
something spawnable without a shell: a native binary is spawned directly, while a
`.js` / `.mjs` / `.cjs` entry point — what an npm install of Claude Code leaves
behind, next to a shim this application will not run — goes through the runtime
the app is already using, with `ELECTRON_RUN_AS_NODE` set so a packaged build
starts Node rather than a second copy of Agent Relay. The tool's own arguments
follow unchanged either way.

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

## 7b. The Operations workflow — read-only

A second workflow, deliberately kept apart from the development one. The
development workflow changes a repository; this one only looks at something.
Phase 7C-A built its backend; 7C-B added the screen. Live acceptance against a
synthetic database in a running Windows application (7C-C) passed on 2026-09-04.

```
OperationsRegistry ──selects by enum──> OperationProbeAdapter
        │                                      │
        │                              LocalSqliteProbeAdapter
        │                                      │
OperationsDiagnosticsService            ExecaProcessRunner
        │                                      │
operation_diagnostic_runs               sqlite-probe.mjs (child process)
```

### The target

`OperationTarget` names an environment, an adapter kind, and that adapter's
**versioned** configuration. Three rules carry most of the weight:

* `adapterType` is an **enum**, and the implementation is chosen from a
  `Record` keyed on it. No stored value, IPC payload or model output can name a
  module, a path or a command to load.
* Configuration is validated **per adapter type and per version**. A row written
  by a newer build fails to parse rather than being half-understood by an older
  one, and the same is true of a stored probe result.
* `credentialRef` is a **reference**, never a value. A string shaped like a
  credential — the same shapes `redactSecrets` knows — is refused, and a
  `local_sqlite` target accepts no reference at all, in the domain schema *and*
  in a table `CHECK`.

`id` and `adapterType` are identity and are not patchable: a diagnostic run
refers to a target by id and was produced by one kind of adapter, so moving
either would leave an audit row describing something that no longer exists.
The environment is stated by the operator and never inferred from a name or a
path.

### Probes

Two, both registered in code: `connection_health` and `schema_summary`. A probe
is *named*; the statements it runs are written into the probe script and are
not assembled from anything. Neither probe reads a row **of a user table**, and
neither counts one; every `FROM` in the vocabulary names `sqlite_schema` or
`pragma_table_info`, and a test checks that. Counting schema entries is allowed
and is what keeps the omission numbers honest. Neither returns a default value,
a `CREATE` statement, an index or a trigger — every one of which can carry a
literal out of the data.

**The two listing statements are bounded by SQLite, not by a slice afterwards.**
Both carry `LIMIT ?`, with the limit bound as a parameter. A bound applied in
JavaScript still lets SQLite materialise the whole schema first, so a file with
a hundred thousand tables would be fully loaded into the probe process before a
single row was discarded. Alongside each listing sits a fixed `COUNT(*)` over
the same metadata, which is how the result reports `omittedTables` and
`omittedColumns` exactly without ever holding the rows it is counting. A table
whose columns the budget cannot afford issues no listing query at all, and
still reports how many it declared.

Every bound has a default, a floor and a ceiling: timeout, retained output
bytes, tables, columns per table, total columns, string length. A caller may
choose a value inside the range and nothing outside it, and there is no value
meaning "no limit".

Out of range is a **refusal, not a clamp**, and `resolveDiagnosticLimits` is the
one place that decides — it parses its input through the same schema the IPC
layer uses, so there is a single answer whichever door a request came through.
Clamping would be the more dangerous half: an operator who asked for a million
tables and silently received five hundred reads the result as complete. The
service turns the parse failure into `VALIDATION_FAILED` before it looks up the
target, writes a run, chooses an adapter or spawns anything.

### Why the probe runs in a child process

`node:sqlite` is synchronous. A query against a large or damaged file blocks the
thread that issued it, and no `Promise.race`, `AbortSignal` or timer can take
that thread back — a timeout would only be noticed once the query had already
finished. So the work runs in `sqlite-probe.mjs`, a separate process driven
through the same boundary the Claude adapter uses: no shell, scrubbed
environment, request on stdin, one versioned envelope on stdout, stderr as
diagnostics only, and a kill that the operating system enforces.

The protocol out of that process is **exactly one non-empty line on stdout**.
Not "the last line that looks like JSON": with that rule a probe that printed a
warning first, emitted two envelopes, or appended anything after its answer
still produced a result, so a process that had partly gone wrong could still be
believed. Anything other than one line is `malformed`, and stderr is never a
result.

The script is not bundled — it is the entry point of another process — so
`electron.vite.config.ts` copies it beside the built main bundle. The adapter
looks for it next to its own module, which is the source directory in
development and `out/main` in a build, so one lookup is correct in both with no
environment check anywhere.

### Running one

The order is the contract: validate the target and the probe, refuse a disabled
target, refuse a second concurrent diagnostic, **write the run as `running`
before anything is spawned**, run the adapter, then — before anything is
stored — check the answer, redact it, re-check the bounds, close the run, and
return what was persisted. Nothing retries, nothing falls back to another
target, and no approval is involved: there is no mutation to approve.

Three checks stand between an adapter's answer and the database.

**It must answer the question that was asked.** The probe echoes the target id,
its environment, its adapter type and the probe id back verbatim, and all four
must match the request exactly, along with the result version. An adapter is
trusted to *run* a probe, not to say which probe it ran — a result about
something else, filed against this run, would read as though it described it.
Because these are compared exactly, they are the one kind of string the probe
never shortens: `maxStringLength` governs foreign text — table names, declared
types, warnings — and a truncated identity would fail the comparison while
looking healthy.

**Redaction happens before measurement**, because the object that is measured
has to be the object that is stored, and redaction can change a string's length
(`PASSWORD=x` becomes `PASSWORD=[redacted]`).

**The bounds are re-checked here**, against the limits *this run* resolved:
tables, columns per table, columns in total, the length of every piece of
foreign text, and the byte size of the finished object. The child process
applies them too, but it is the thing being bounded, and a limit enforced only
by the code it constrains is not a limit. A breach is not trimmed to fit —
storing a smaller copy would record a partial answer as a whole one, with
counts inside it that no longer described anything.

A failure is recorded as one, with the kind that produced it (`error`,
`timeout`, `cancelled`, `malformed`) and **no result**. A run that proved
nothing must stay visibly empty.

The environment is part of a successful result because it is evidence about
what that probe actually inspected. Version 1 does not duplicate it in the run
row. Consequently a failed run, which must have no result, also has no historical
environment snapshot and the screen says `environment not recorded`. Reading
the target's environment *now* would be a tempting shortcut and an audit error:
the target may have been edited since the run.

### Three shapes, and no others

A stored diagnostic run may take exactly three forms, and every column is
pinned in each:

| status | `finished_at` | `structured_result` | `failure_kind` | `error_message` |
|---|---|---|---|---|
| `running` | NULL | NULL | NULL | NULL |
| `succeeded` | set | set | NULL | NULL |
| `failed` | set | NULL | set | set |

Stated as one table `CHECK` rather than several narrow ones, because the wrong
combinations are the ones nobody thinks to forbid: a failure still carrying the
result of an earlier attempt, a success with an error message beside it, a
running row with a verdict already filled in. The same three shapes are a
discriminated union in `DiagnosticOutcome`, re-checked at runtime by the
repository — a union is a promise to the compiler, and a caller can reach for
`as never` — and re-checked once more by the row mapper on the way out, which
also requires a stored result to name the same target and probe as the run
holding it. A row that fails any of it is refused rather than half-read.

### Once, and only once

A run is closed by an `UPDATE` that matches only a row still marked `running`,
and a zero-row update is reported rather than passed off as success. A second
`finish` — a retry, a race, a caller that lost track — cannot turn a recorded
success into a failure or overwrite the evidence of one. The repository also
refuses to store a result whose target or probe disagrees with the run it would
be attached to, so the service's check has a floor underneath it.

At most one diagnostic per target is in flight, and that is a **database**
invariant: a partial `UNIQUE` index over `target_id WHERE status = 'running'`.
The service checks first because it can explain itself; the index is what holds
when two writers race or when a row arrives by some other route.

### Fail-closed versions

This build reads and writes exactly version 1 of both shapes, and says so in
three places: the table `CHECK`s pin `config_version` and `version` to 1 rather
than accepting anything at or above it; the row mappers refuse a version they do
not know, refuse a row whose typed `config_version` or `adapter_type` column
disagrees with the JSON beside it, and check every enum-valued column instead of
casting it. A cast is a claim the compiler cannot verify and the data may not
honour.

### Deleting a target

Refused while a diagnostic is running, and refused while any history exists. The
foreign key is `ON DELETE RESTRICT`, so a diagnostic run — an audit record of
what was inspected and when — cannot be erased by tidying up. Disable the target
instead.

### The screen

`OperationsView` is a section of its own, ungated by any project or task: a
target is not owned by a repository, and requiring one to be selected would
imply a relationship that does not exist. The header shows no project name for
the same reason.

It is also ungated by the development store's own start-up. `App` checks for the
Operations section *before* the bootstrap gate, because the store clears that
gate only once `projects:list` and `settings:get` have both settled. An ordinary
error settles them and the gate opens; a request that never answers does not, and
that used to hold the one screen an operator would open to look at a database
while the rest of the application was unwell.

Its state lives in `OperationsProvider`, a second context deliberately separate
from the main store. Two properties come out of that choice.

**Isolation.** Nothing here writes into the development workflow's state, so a
failed target load or a probe that never answers cannot leave Projects, Tasks,
Run or Settings in a bad way. Errors are narrower still: each panel keeps its
own, because a shared slot put a refused delete under the registration form,
where it read as a reason the *new* target could not be saved.

**Survival.** The provider is mounted above the router, so a diagnostic that is
in flight is still in flight after the user visits another section and returns.
Had it lived inside the screen, navigating away would have forgotten the request
and let a second one start on top of the first.

Everything that can arrive late is keyed by **target id** rather than by "the
current screen", so an answer for target A writes A's slot and can never be
painted under target B. A double click is stopped by a ref rather than by the
disabled attribute: two clicks in one tick see the same React state, and "the
button looked disabled" is a rendering fact, not a guarantee.

Seven rules govern the asynchronous state, and each of them replaced something
that looked right and was not.

**A load has a phase, not a pair of booleans.** `idle → loading → loaded |
error`, where `error` is a resting state. "No data and not loading" is true both
before the first attempt and after a failed one, so an effect keyed on it fires
again on the render its own failure caused — hammering a backend that has just
said no, and clearing the error the operator was meant to read. Only `idle`
starts a request; only an explicit Retry or Refresh leaves `error`. The target
list and each target's history have their own phase, so one target's failure
says nothing about another's.

**A read is stale if a write finished while it was in the air.** Sequence numbers
alone are not enough: a `listTargets` that started before a Disable was confirmed
carries an older truth, and it is still the newest *list* request there is.
A write epoch, compared across the call, is what stops a slow Refresh putting
`Enabled` back after a confirmed Disable. A response overtaken by a newer read is
discarded silently — never by handing the phase back to `idle`, which the mount
effect would read as a fresh screen and answer with a third request.

**A list is complete, or it is known not to be.** A first response discarded
because a write overtook it leaves only what that write added; announcing that as
the registry hides every existing registration behind a list that looks whole.
Completeness is tracked separately from the phase, and registration waits for the
registry to have been read once — which is also what makes the race unreachable,
since a create is the only write that can overtake the very first read.

**One action per target, claimed synchronously.** A probe and a registry write may
not touch the same target at once, in either order: a probe reading a target that
is being re-pointed would report on something other than what the finished run
claims it looked at. The claim lives in a ref, and it lives in the provider, so it
survives the panel being unmounted and remounted by navigation.

Because a guard is a ref and the screen is a store, the two can disagree, and a
reducer cannot reach a ref. So **nothing clears a guard from inside the reducer**:
every change goes through a setter that writes both halves in the same turn. The
failure this prevents is worse than a stuck button — the store cleared, the ref
kept, and an *enabled* Run that silently reached no channel at all.

**A read decides nothing once it has been overtaken.** The deep search for a run
that has scrolled off the page is slow enough for a later refresh to answer the
same question first, so it re-checks that it is still the current read — after its
await, before it writes anything — and otherwise stops with no conclusion. A
superseded search re-blocking a target that newer evidence has just released is
worse than never having searched.

**Local request lifetime is not backend execution state.** A run the backend
reports as `running` blocks its target although nothing is in flight here — the
schema permits one running run per target, so that row is authoritative. It is
tracked by run id: a later page still calling an already-finished run `running` is
stale, and a bounded page that has simply scrolled past it proves nothing at all.
Omission triggers one search to the channel's ceiling; if that cannot account for
the run either, the block stands and the operator is given an explicit way to stop
tracking it, because a target locked for the life of the window is its own defect.

**A request, the wait for it, and the read that follows are three things.** The
renderer's patience expiring is a fact about the screen, not about the request:
nothing cancels a probe, so an expired wait leaves it outstanding and its answer
still to come. That answer is applied exactly once, by whichever path reaches it
first, and independently of whatever the history read is doing — using the
in-flight flag as evidence that the wait had not expired threw away replies that
arrived while the history was still loading. Nothing a read says can release an
outstanding request either: an empty history is as consistent with "still
running" as with "finished", so only the request's own answer ends it, whether
that answer is a result, a refusal or a transport failure.

**An unknown outcome holds its claim until something confirms it.** The claim used
to be released on the way into the very read meant to confirm it, which let a
second write start against a target whose state nobody knew. Reads never take the
claim, so holding it across reconciliation costs nothing. The bridge has no
timeout, so the read has one: on expiry the target stays blocked — nothing was
confirmed — but the block becomes a stated uncertainty with a re-read attached,
rather than a spinner with no end.

**A registry write is waited for, not waited on for ever.** The write has the
same bound as a probe, and for the same reason: the bridge cannot be cancelled,
so a request that never settles used to hold the claim — and the `finally` that
releases it — for the life of the window. Expiry is this screen's patience
running out and nothing else. The target stays blocked, the write is never sent
again, and the answer, when it comes, is applied exactly once by whichever path
reaches it first. An answer that arrives after the caller has been handed an
uncertain outcome has nowhere to be returned to, so a late refusal is recorded
against the target and shown there rather than dropped.

**A row that matches a registration is not proof that this request made it.**
The registry allows one target per name and environment, so an identical target
registered earlier is precisely what makes it REFUSE a second one — and the row
found afterwards is that earlier target. Attribution is therefore by identity
against the registry as it was known *before* the request was sent: a row whose
id was already there predates the request and settles it as refused, and only a
row that was absent before and points where the request asked is reported as
registered. Without such a picture there is no attribution to make, and the
screen says the outcome is unknown instead of guessing.

What is *known* is not only what a read returned. A write the backend confirmed
changed the registry too, and folding those in is what makes the picture true a
second time: register a target, register it again without refreshing in between,
and lose the second reply, and a picture built from reads alone would not contain
the target from the first registration — so finding it in the read-back looked
exactly like the second request having created it. Confirmed creates, updates and
removals are folded in as they happen. What is deliberately *not* folded in is
the read stamp: it answers whether a READ has happened since the outcome now in
doubt, and letting a write advance it would let one request's success stand in
for the confirmation of another request nobody has answered.

**A read that is running has not failed.** The registration form used to state,
as settled fact, that the registry could not be re-read while the first
confirming read was still outstanding — which both misinformed the operator and
invited a second read to find out. The same applies to the recorded history: a
refresh that shows nothing looks like a click that went nowhere, so it says what
it is doing and is held while it does it, and what is already on screen stays
legible underneath. The registration's own re-read is held by a synchronous
guard as well, because a button that has not re-rendered yet is not a guard.

**A draft is compared with the schema's own spelling of it.** What the operator
typed and what the schema made of it are the same path written twice —
`C:\data\reports.sqlite\` and `C:\data\reports.sqlite` — and comparing the raw
strings told somebody who had changed nothing that the form was theirs to keep,
leaving a stale entry in front of a target that had in fact been registered. Both
sides go through `normalizeTargetPath` before the comparison decides whether the
form still holds what was submitted. Anything genuinely typed since is still the
operator's work and is still kept.

**A refusal and an unknown outcome are different things.** A backend that answers
"no" is a fact about the request. A call that fell over in transport is not:
whether the write was applied is genuinely unknown, and the screen says so, keeps
the draft — in the provider, so it survives a remount — re-reads the registry, and
never repeats the write. Whether that re-read actually succeeded is reported as
itself: "the registry has been re-read" is only ever printed when it has.

The renderer owns no validation rules. Save is enabled by the same
`newOperationTargetSchema` the IPC layer parses against, so the button cannot be
live for something the main process is about to refuse. Every result on screen
is a persisted `OperationDiagnosticRun` read back from the database — never an
object the UI assembled — and truncation, warnings and unknown values are shown
as themselves rather than folded into a green tick or defaulted to `0`.

---

## 8. Testing strategy

1152 tests, none of which contact Codex, Claude, or GitHub.

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
| `adapters/claude-cli-process-contract` | **The Claude adapter against a real child process** — see below |
| `adapters/interactive-runner` | **A real duplex child process**: stdin staying open, input budgets, framing, tree kill |
| `security/redaction-and-process` | Credential redaction, environment compartmentalisation, argv-not-shell execution |
| `domain/operations-targets` · `domain/operations-diagnostics` · `domain/operations-ipc-contract` | The target and probe contracts: what they refuse — an adapter outside the enum, a config version this build cannot read, a credential value, a statement anywhere a probe id belongs |
| `db/operations-repositories` | Migration 3 on a fresh database *and* on one that already has 1 and 2, CRUD, uniqueness, the `RESTRICT` audit policy, close/reopen on disk |
| `adapters/local-sqlite-probe` | **The probe against real SQLite files in a real child process**: read-only proven by hash, size, mtime and the absence of a `-wal`, truncation counts, timeout, cancellation, stdout/stderr separation |
| `services/operations-diagnostics` · `services/operations-startup-recovery` | The order of events around a probe, the one-at-a-time rule, redaction before persistence, and recovery of a diagnostic an abrupt exit left open |
| `renderer/operations-view` | **The Operations screen, driven through its real buttons and fields** against a fake preload bridge: reachability without a project, disabled Save, exact IPC payloads, no automatic runs, double clicks, late answers, and the absence of a false success |
| `renderer/operations-async` | **The screen's asynchronous state**: a failed load asked once and retried only on request, per-target history, answers arriving out of order, a stale list that must not undo a confirmed write, one action per target at a time, and a write whose outcome nobody knows |
| `renderer/operations-backend-state` | **What the screen knows about work it did not start**: a run the backend is executing, a bounded page that has scrolled past it, a claim held across the read meant to confirm it, and a first list response a write overtook |
| `renderer/operations-recovery` | **Recovery, and what must not depend on anything else**: Operations reachable through a development bootstrap that never finishes, a manual re-read held until every read it needs has answered, an unconfirmed registration resolved against the registry, a probe request that goes unanswered, and one deep search per run |
| `renderer/operations-outcomes` | **Which request an outcome belongs to, and what the screen says before it knows**: a matching row that predates the request, a draft and a normalised path that are the same path, a confirming read still in flight, a refresh that says it is working, a registry write that never answers, and coming back to the screen without running anything |

### Renderer tests

The renderer suite renders real components and clicks real buttons. A helper
test that never mounts JSX proves the helper; it does not prove that a button is
wired to it, that Save is disabled when it should be, or that a late answer
cannot overwrite the screen — which is most of what can go wrong in a UI.

The whole of the renderer's view of the outside world is
`window.agentRelay.invoke`, so replacing that one function is enough to drive
every screen with no main process, database or child process anywhere. Races are
driven by **deferred promises**, never by sleeps: a test that decides when each
answer arrives is a test whose result does not depend on how loaded the machine
is.

A double click has to be fired as one: `fireEvent` is wrapped in `act`, so two
consecutive calls re-render in between and the second lands on a button that is
already disabled — which tests the attribute, not the guard behind it. The
harness's `burstClick` nests the clicks inside a single `act` so nothing is
flushed between them.

Only these files run in `jsdom`, opted into per file with an
`@vitest-environment` docblock. Everything else — the process, SQLite and Git
suites — keeps running in a real Node environment, which is the point of putting
the choice next to the tests that need it rather than in a glob nobody reads.

### The process-level contract suite

Every other adapter test hands `ClaudeCliAdapter` a `ProcessRunner` that returns
a canned string. That proves the adapter calls the interface correctly and
nothing at all about the boundary the interface stands for. So one suite runs the
real `ExecaProcessRunner` against
[`tests/fixtures/fake-claude-cli.mjs`](../tests/fixtures/fake-claude-cli.mjs) — a
plain Node script, no shell, spawned as an ordinary child.

The fake takes its behaviour from `fake-claude-scenario.json` **in the working
directory** and records how it was invoked into `fake-claude-invocation.json`
beside it. Reading its instructions only from `cwd` is what makes the
working-directory claim testable: a run started elsewhere finds no scenario and
says so. Environment variables are recorded by **name and presence only**, never
by value, so a real credential on the machine running the suite cannot reach a
report or an assertion message.

What this proves that a fake runner cannot: the exact argv the operating system
receives (including all 54 deny rules, each permission rule as its own entry, and
the absence of `--dangerously-skip-permissions`); that the prompt travels on
stdin byte for byte and appears in neither argv nor the command label; that a
JSON line split across two writes is reassembled and several packed into one are
not; CRLF and LF alike; that stderr is not protocol; exit codes, including the
authentication and model-failure shapes; exit 0 with no final envelope;
permission denials surviving a successful exit; evidence arriving out of order;
malformed lines; the byte-accurate output bound and the contiguous prefix it
retains; that a one-shot run's stdin ends at once when there is no input and
carries the whole of it when there is; resume; how a located path is turned into
a spawn; and that a timeout, a cancellation or a throw from the caller's own
callback actually leaves no child process behind — checked by pid, not assumed.
