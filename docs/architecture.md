# Architecture

Agent Relay is an Electron desktop application that relays one software task
between selectable agents: **Codex** specifies; **Claude Code**, **Codex**, or
**Ornith** (a locally-run model, reusing the local-inference boundary in
`docs/local-inference.md`) implements, and **Claude Code** or **Codex** can
perform the primary read-only review — Ornith is implementation-only and is
never a specification, plan-review, or code-review provider. All the work
happens inside a dedicated Git worktree, and nothing leaves the machine
without an explicit confirmation.

---

## 1. The relay loop

### EXEC-0: provider routing

The diagram below shows the legacy default (Claude implementation / Codex review).
Migration 8 adds task-level `implementation_provider`, `review_provider`,
`provider_revision` and a dedicated `implementation_thread_id`. Existing rows
retain their prior provider choices. The specification thread is never reused for
review; every review is fresh, including when the executor and reviewer are Codex.

`workflow:configureProviders` is an explicit idle-only, revision-checked operation.
It refuses active process claims, durable running runs, approved and terminal states.
The repository records the change and updates selection in one transaction.
Changing executor clears both implementation session pointers; it does not reset
rounds, discard files or erase history. Corrections carry the full specification as
well as the review, so switching executor does not depend on another vendor's memory.
`workflow:implement` and `workflow:review` route by persisted task selection;
the old channel names remain compatibility aliases, not forced-provider overrides.

Codex writes only with the SDK workspace-write sandbox and approvalPolicy=never;
network and web search are disabled. Command telemetry is assessed using the existing
version-1 assessment envelope. A completed verification command must follow writes;
missing completion, failed checks, ambiguous command shapes, MCP calls or observed
destructive commands fail closed. Simple literal shell launchers are unwrapped for
matching, not executed by Relay. This is command evidence, not proof that a project's
test script is comprehensive. SDK abort receives both cancellation and process deadline.
Claude's implementation assessor is unchanged. Publication and retry selection read
the latest implementation/correction from either provider, including a null result;
an older passing Claude record cannot mask a later failed Codex run.

Claude review uses a fresh print session with only Read/Grep/Glob, no settings sources
and an empty strict MCP configuration. Coai configuration and external gates are
unchanged. Automated provider tests use fake adapters/SDK streams; routine Electron
E2E exercises Operations, not a paid live provider coding session. A first live task
is still required to validate installed model access and local sandbox prerequisites.

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

Migration 9 seeds the strict version-1 `localInference` Settings object only
when absent; migration 11 is forward-only and upgrades a pre-existing row to
add the opt-in `enabled` flag and `requestDefaults` (default output token cap,
default chat-template parameters) without touching its existing executable,
model, argument, port, context or timeout values. One application-scoped
lifecycle service lazily constructs the llama.cpp-compatible provider from that
configuration — but only when `enabled` is true; while disabled and no provider
is retained, every operation but `stop` returns the existing DTO shapes with an
explicit disabled reason and constructs nothing. Construction is otherwise
passive: restart restores configuration but always begins at `stopped` (or the
disabled DTO), with no process or HTTP activity. The service retains one
provider without serializing its lifecycle calls: overlapping operations reach
the provider's own state machine, which lets stop interrupt startup or join
cleanup while preventing a second launch. A changed or disabled configuration
cannot displace the snapshot that owns an active or uncertain process; only a
confirmed explicit stop releases it for rebinding on the next operation.

The typed lifecycle boundary has five strict-empty-input IPC operations —
capabilities, start, state, explicit health, and stop — plus one additive,
strict-prompt-only operation, `runTestInference`, whose input schema accepts
nothing but `{prompt: string}` and whose response is the existing version-1
`LocalInferenceOutcome`. Repository data, argv, paths, model/host/port
identity and arbitrary commands are not accepted on any of the six channels,
and none of that is exposed by the renderer either. The Settings screen
exposes the persisted fields above and a lifecycle panel drives those six
operations, always against *saved* settings; it opens by calling only
`getState`, computes one state-derived primary action, and there is still no
workflow-provider integration or automatic startup.

`runTestInference` is a manual, one-shot smoke test, not a second inference
channel: the lifecycle service accepts only prompt text, builds exactly one
version-1 request — a generated request id and a single `{role: 'user',
content: prompt}` message, with no request-level token or template override —
and delegates it once to the retained provider, so the saved output-token cap
and chat-template defaults already assembled into that provider's
configuration remain the only source of those limits. It is available only
while the retained provider reports `healthy`; a disabled or unbound service
constructs nothing and returns a bounded structured failure, and an enabled
provider in any other state (starting, inferring, stopping, stopped, or a
terminal state) rejects the call through its existing transition guard before
any request is sent. The renderer's synchronous, panel-wide in-flight claim
keeps capabilities, Start, health, passive refresh, Stop, and test inference
from overlapping one another. This UI serialization does not change the
provider's defensive backend ability to cancel an inference or synchronize
Stop with non-renderer races.

The prompt and its rendered result live only in the panel's own component
state — never Settings, SQLite, task/run history, application logs, or
browser storage — so both are gone on unmount and never reappear after a
restart.

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
IMPLEMENTING → READY_FOR_IMPLEMENTATION (saved correction or implementation lacks verification proof)
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

### Verification evidence passed into review

A successful standalone `npm run verify` is stored as a versioned record with
its command, exit code, duration and exact worktree identity. Before dispatching
a review, the orchestrator re-computes that identity and rejects a missing,
failed or stale record. The validated record is then passed through the review
port and rendered as a dedicated authoritative prompt section. An older
implementation/correction report remains available as historical context, but
its earlier verification failure cannot override Relay's current successful
record. After the reviewer returns, the identity is checked again before its
verdict is accepted.

A completed Codex or Claude correction whose files were saved, has no security
refusal, but whose process assessment cannot prove verification uses
`correction_unverified`, not
`correction_aborted`. It returns to `READY_FOR_IMPLEMENTATION`; the existing run
history then projects **Run verification** as the sole next action. This preserves
the work and the consumed correction round while preventing an AI sandbox or
telemetry limitation from silently spending another round on the same findings.
`correction_aborted` is reserved for a security refusal or a thrown, cancelled
or startup-reconciled correction whose attempt did not return normally, and
therefore still restores `CHANGES_REQUESTED` so that attempt can be retried.

An *implementation* round that saved files but cannot prove them verified has the
same shape and now the same treatment: `implementation_unverified` (from
`IMPLEMENTING`) lands in `READY_FOR_IMPLEMENTATION` exactly as
`implementation_aborted` does, but through its own event so the two are not the
same fact. It is used whenever a round that did not finish cleanly leaves files behind —
its own edits, or edits an earlier attempt left in the worktree — and has no
security refusal: its own verification failed, timed out or never ran, the loop's
time limit ended it, or a limit or provider failure stopped it after it had
written. The task's `lastError` then says what changed, which verification
attempt (if any) ended how, and that the changes are preserved; the round is not
handed back. A round that provably
changed nothing is unchanged: `implementation_aborted`, round returned, and the
primary action stays **Run implementation**.

From that state the operator's one action is **Run verification**, which
runs `npm run verify` against the existing worktree — no new worktree, no new
attempt, no provider call, no discarded diff, no round consumed. A pass advances to
`READY_FOR_REVIEW`; a failure or timeout stays in `READY_FOR_IMPLEMENTATION` with
the outcome, exit code, duration, reason, a bounded sanitized output tail and a
**failure kind** recorded on the verification run.

### One next step, decided by what the verification found

The Run screen renders exactly one workflow control at a time (plus the
separate *Stop task* safety control). Two "next steps" side by side — a repair
beside a re-run, a retry beside a verification — sent operators down the wrong
one, so there is no secondary action anywhere in `runGuidance`. Which single
step is right is decided from the recorded evidence, and the status text says
why it is the right one. The failure kind is classified by
`classifyVerificationFailure` (`src/shared/domain/verification-failure.ts`)
from the locally held, bounded output BEFORE the record is stored, and only on
positive evidence: `implementation` needs an explicit test assertion, `error
TS…`, ESLint error or build failure in the output; `infrastructure` needs a
known test-runner signature (vitest's own pool messages, a command that ended
without an exit code, files that changed under the run) and NO such failure
beside it; `output_limit` is a command the process layer stopped because its
output reached the stored log budget (`ProcessResult.outputLimitExceeded`,
read before the exit code, and whatever the retained part says — it is
incomplete by definition); anything else is `unknown` and fails closed. A
record written before the kind existed is read as `unknown`.

| Evidence on the task                                             | The one action                          | Round | Provider prompt |
|------------------------------------------------------------------|-----------------------------------------|-------|-----------------|
| Verification passed                                              | **Run review · <reviewer>**             | —     | —               |
| Verification failed, kind `implementation`                       | **Fix verification failures · <impl.>** | new round | repair prompt from the record's `outputSummary` only |
| Verification failed, kind `infrastructure` (e.g. Vitest worker timeout) | **Run verification again**       | none  | none            |
| Verification failed, kind `cancelled`                            | **Run verification**                    | none  | none            |
| Verification failed, kind `unknown` (incl. a Relay timeout, a legacy record), first time on this snapshot | **Run verification to diagnose** | none | none |
| Verification failed, kind `unknown`, materially the same as the previous one, files and settings unchanged | *waiting: User action required* (no workflow control) | none | none |
| Verification failed, kind `output_limit`, files and settings unchanged | *waiting: User action required* (no workflow control; a Settings link) | none | none |
| Either of the two above, once the files or the verification settings changed | **Run verification** | none | none |
| Implementation left files, no verification yet                   | **Run verification**                    | none  | none            |
| Implementation attempt provably left nothing behind              | **Retry implementation · <impl.>**      | attempt returned | none    |
| Approved specification, no attempt yet                           | **Run implementation · <impl.>**        | new round | —           |

A generic **Retry implementation** is never offered while verification is the
stage, and **Fix verification failures** and **Run verification again** are
never offered together. Retrying verification consumes no implementation round,
touches no file, and — because only an `implementation` kind supplies repair
evidence — an infrastructure, cancelled, output-limit or unknown failure never
becomes a correction prompt for any provider.

**The re-run policy** (`verificationRerunPolicy` in
`src/shared/domain/verification.ts`) bounds the diagnostic re-run. Each failed
record keeps two 16-hex fingerprints, never raw output: `configurationFingerprint`
(the time limit and stored log budget the command ran under) and
`evidenceFingerprint` (kind, outcome, exit code and the already sanitized summary
with numbers blanked). A first `unknown` result on a snapshot has one diagnostic
re-run; a second `unknown` that is materially the same (same identity, same two
fingerprints, a cancelled run in between ignored) exhausts it, and an
`output_limit` result has none. The guidance then offers the one gated step, **Run
verification after changes**, and `Orchestrator.runVerification` enforces the
gate where the snapshot is known: it computes the worktree identity and the
configuration fingerprint first and refuses — before any row is written, any
state moves or anything is spent — while both equal the recorded run's, with a
sentence that says what must change (the files, or the settings the reason
names). A changed snapshot, changed settings or a materially different failure
starts a fresh allowance. A record without fingerprints never refuses.

**The Run screen never offers what the gate would refuse.** In those two states
`runGuidance` consults `RunGuidanceExtra.verificationReadiness`, the renderer's
last read of the read-only `workflow:verificationReadiness` channel, which
`Orchestrator.verificationReadiness` answers from the SAME two values the gate
compares — the current worktree identity (read with the same `identity()` the
verification uses) and the current configuration fingerprint — through the
shared `verificationReadinessFor`. The answer is one of `not_blocked`,
`blocked`, `ready` (with which of files/settings changed) or `unavailable`
(fixed prose): no identity, fingerprint, path or output ever crosses to the
renderer. Until it has answered, and while it says `blocked` or `unavailable`,
the guidance is a *waiting* state — "User action required", no workflow
control, *Stop task* still available — with a notice carrying two navigation
controls that run nothing: *Open Settings · Stored log budget* (for an output
overflow; it focuses that control on the Settings screen) and *Check for
changes* (re-reads readiness after edits made outside the app). Readiness is
also re-read whenever the gated run, the task or the verification settings
change. On `ready` the one workflow control is **Run verification**; the gate
in `runVerification` still decides again, against the values of that moment, so
conditions that revert between the read and the click are refused.

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

Long-lived local inference has an additional whole-tree containment contract.
On POSIX it runs in a process group. On Windows, an Agent Relay-owned native
launcher creates a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, creates
the runtime suspended, assigns it to that job, and only then resumes it. The
suspended start closes the race in which a runtime could create an uncontained
helper before assignment. Descendants inherit the job, so containment survives
the primary runtime crashing or detaching a helper. The launcher remains alive
until the primary runtime has exited and the job is empty. Agent Relay requests
an explicit stop by closing a private control pipe; the launcher terminates the
job, observes it empty and only then exits, making that exit positive whole-tree
evidence. If the supervisor or launcher crashes, kill-on-close still terminates
the remaining members, but an abnormal or reserved launcher failure exit is not
called proof: ownership remains held and a second runtime stays blocked. The
launcher is resolved only from Agent
Relay's own build output or beside the bundled main process. If it is absent,
launch fails before the configured runtime is created—there is no uncontained
fallback and no PATH lookup.

One narrow exception to "run once, collect output": `InteractiveProcessRunner`,
implemented by the same class, keeps stdin open so a line-oriented protocol can
be driven turn by turn. It exists because `codex app-server` starts shutting
down at stdin EOF and never answers, so `run({ input })` cannot talk to it. The
controller handed to callers exposes only `writeLine` and `closeInput`, input is
bounded by message count and bytes, embedded newlines are refused (framing is
one record per line), and every security flag comes from the same shared options
builder as the other two paths.

`StdioMcpClient` is the second consumer of that narrow interactive boundary. It
implements only the MCP operations Agent Relay needs to establish a trustworthy
process contract: `initialize`, `notifications/initialized`, paginated
`tools/list`, and one `tools/call`. It does not use an SDK-owned launcher,
because a second launcher would bypass the no-shell, scrubbed-environment,
bounded-output and process-tree-kill invariants above.

An MCP server configuration names an explicit absolute executable, fixed argv,
optional absolute working directory, enabled state, wall-time and byte/block
budgets, and the exact tool names accepted from that server. Discovery fails
closed if a tool is missing, duplicated or newly advertised. A call outside the
allowlist is rejected before a process starts. The client accepts text content
only in this first phase and distinguishes JSON-RPC failure, process failure,
timeout, cancellation, a completed result with `isError`, and a successful text
result whose provider-specific body happens to encode a refusal. Tool
annotations are evidence; they never grant permission or bypass workflow state.

Each discovery or call owns one bounded process and closes stdin when the result
is complete. A response is not accepted if that process subsequently times out
or exits unsuccessfully. INT-A deliberately stopped at this boundary: no real
provider was contacted, no Coai session entered the task FSM, and no credentials
or shared-rule repository was loaded. The later INT-C acceptance crosses that
boundary only in an isolated, explicitly opt-in synthetic journey.

### Rule evidence boundary

`RuleEvidenceService` captures instructions as evidence before any model sees
them. A project source discovers only `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`,
`.github/copilot-instructions.md`, and Markdown rule files below
`.claude/rules` and `.cursor/rules`. A conventions source has no implicit local
location and no broad discovery: its root and selected relative files are
explicit inputs.

`FilesystemRuleSourceReader` accepts canonical source-relative POSIX paths,
refuses traversal and symlinks in every path component, never follows a linked
rule directory, and reads a file whole or omits it — never truncates it into a
different instruction. Discovery, per-file bytes, total bytes, source count and
file count all have hard ceilings. Missing, non-file, linked, oversized,
invalid-UTF-8, unreadable and budget-excluded entries remain visible as typed
omissions.

Every source is inspected as a Git repository before and after reading. A
conventions source can require both a full expected object id and a clean
checkout; drift fails closed. A project worktree may intentionally be dirty,
and that fact is recorded rather than refused. The resulting versioned snapshot
contains full text, source-relative paths, per-file SHA-256, revisions,
cleanliness and omissions. Its canonical hash excludes only capture time and
absolute checkout paths. A runtime schema validates the object before it is
rendered as an unambiguous JSON prompt envelope.

INT-B stops at capture. INT-C adds an opt-in durable binding: once a task binds a
snapshot, it cannot replace it or bind one after specification starts. The same
validated envelope is passed to Codex specification, Claude implementation and
corrections, and Codex final review rather than re-reading files at different
moments.

A source's `revision` and `clean` describe the checkout its rule files were read from
at capture, and the rendered envelope says so: they are never a statement about the
task's worktree or the specification's target.

### Specification grounding: one target for every stage

A specification is written about ONE tree, and every later stage uses that tree. The
project's source checkout is never it: it can be on another branch, at another commit,
with uncommitted edits, and the task branch is cut from the base branch, not from it.

- **Generation** (`SpecificationGroundingService.open`). When the task already has its
  worktree, Codex reads that worktree (after the path-safety check, a branch check, and a
  check that the project's own `refs/heads/<task branch>` names the same commit); in any
  round, a task worktree with uncommitted changes is refused (`GIT_DIRTY`), because no
  commit could name what Codex would read and nothing could later prove the worktree still
  holds it — the changes are left alone. Otherwise Codex reads a temporary, clean, detached
  checkout of `refs/heads/<base branch>` at `<worktrees root>/.agent-relay-specification/<task id>`,
  removed afterwards with a non-force `git worktree remove` (a leftover is removed the same
  way before the next generation; one that cannot be is refused, never forced). After
  Codex returns, and before anything is stored, `confirmUnchanged` inspects the checkout it
  read again: a HEAD that moved, or any uncommitted change, refuses the result, so the task
  keeps the specification and record it had. A regeneration against a different target
  starts a fresh Codex thread.
- **The record.** `tasks.specification_grounding_json` (migration 21) holds a
  `SpecificationGrounding` — checkout kind, base branch, task branch, commit, cleanliness,
  the implementer it was written for, capture time, and a `stale` mark. It is written in
  the same row update as `specificationJson`; a plan-correction revision keeps it; a
  continuation does not copy it.
- **The task branch.** `ensureWorktree` creates the branch from the recorded commit, not
  from wherever the base branch is now, and refuses (and marks stale) when the base branch
  no longer contains that commit. So the external plan review — which reads the task
  branch — and the implementation start from exactly the tree the specifier read.
- **Plan review, triage and revision.** The plan text names the target and the
  implementer's capabilities; Codex triage and the plan-correction revision run in the
  task worktree, never in `project.localPath`. All three run the same target check as
  approval (injected as `verifyTarget`, required by both services): a plan round before
  its gate row is prepared or anything is sent to the reviewer; triage and the revision
  before Codex reads the worktree and again after it returns. A task branch that moved,
  or a worktree edited, is recorded and refused; a change during the read discards the
  triage (nothing is recorded on the gate) or fails the correction (no new version).
- **Base branch names.** A project's base branch is free text; before it reaches Git it
  must be a plain branch name by Git's own rules, so `main~1` or `main^` can never
  resolve to another commit.
- **Mismatch.** `verifySpecificationGrounding` (run by the approval IPC before the
  synchronous approval, and by the first implementation round before a branch, lease or
  round exists) requires the task worktree to be on its branch at the recorded commit and
  still clean; without a worktree, the recorded commit must still be on the base branch.
  A definite mismatch is written as `stale` on the record it checked (never on a newer
  one) and refused; a Git failure is only an error. Approval also refuses, without Git,
  a missing, stale, unverifiable or wrong-implementer record.
- **Unverifiable.** A record with `clean: false` — written by an earlier build that let a
  specification be regenerated after the first round from a worktree with uncommitted
  changes — is classified `unverifiable`: no commit names what was read, so it is never
  trusted. It is refused like a missing record (approval, verification, the first round,
  plan review and revision), with no stale mark added, and regenerated instead.
- **Implementer.** Claude and Codex can carry out anything a specification written for
  the other, or for Ornith, asks; Ornith cannot run commands. So only a move to Ornith
  from another implementer requires regeneration.
- **Existing tasks.** A specification generated before this existed has no record. It is
  never rewritten, approved or implemented automatically: before the first round the Run
  screen's one action is **Regenerate specification**, the backend refuses approval and
  the first round, and the plan-correction loop refuses to revise it without opening a
  correction. Later rounds and continuations are not re-checked: their files have moved
  on by design.

### External plan-review gate

Migration 4 adds two separate records. `task_rule_evidence` owns the immutable
task-to-snapshot binding. `plan_review_gates` is append-only across changed
specifications and stores the specification hash, rules hash, external session,
server identity, verdict, structured findings, decisions and durable status.
No absolute repository path is stored in either table.

`CoaiPlanReviewer` is provider-specific policy over the generic INT-A transport.
It declares only the four tools it itself calls — `open`, `status`,
`review_plan`, `resolve` — as a REQUIRED subset the server must advertise, not
an exact match against a fixed server shape or version: the transport
tolerates whatever other tools a server additionally advertises (see
`McpToolProfileMismatchError` in `stdio-mcp-client.ts`), so plan review's
compatibility does not depend on whether the installed Coai build also
supports durable code review, `ask_human`, or anything else. `CoaiCodeReviewer`
does the same independently, declaring only its own three addressable
round-lifecycle tools (`reserve_round`, `run_round`, `round_status`). See
`src/main/adapters/mcp/coai-profiles.ts` for the full per-operation tool list
and the two labelled reference server shapes it also keeps for diagnostics.
JSON inside the single MCP text block is parsed again; MCP `isError`,
`{error: ...}` refusal, malformed output and workflow verdict remain different
outcomes.

`PlanReviewGateService` writes `reviewing` before the non-idempotent plan round
and writes `resolving` plus all decisions before the non-idempotent resolve.
A crash therefore leaves an unknown durable intent rather than inviting an
automatic duplicate call. A `proceed` verdict still cannot approve the
specification: every finding must receive exactly one accept/reject decision,
and rejection requires a reason. Approval checks both the canonical
specification hash and rule snapshot hash after resolve advances the provider to
its code-review stage.

The gate is optional: a task with no bound rule evidence follows the existing
workflow. Once evidence is bound, the gate is mandatory and cannot be bypassed
by the normal Approve or implementation entry points. Settings persist an
explicit MCP executable, fixed argument vector, optional working directory and
an exact clean conventions revision; authentication remains owned by the MCP
server. Agent execution keeps the operator-selected process timeout, while the
shared Coai server configuration caps MCP calls at the transport's independent
30-minute ceiling; raising the former cannot make the latter invalid. The
renderer can only name a task, acknowledge a dirty checkout, or
submit typed finding decisions. It cannot supply executable paths, rule bytes,
repository roots or prompts through the operational IPC channels.

Resolving a round does not rewrite the immutable specification. Findings the
operator chose **Accept and address** are therefore rendered as a separate,
additive section in every implementation prompt, together with the suggested
correction and optional operator note. Rejected findings are not forwarded.
The section is explicitly unable to relax the specification, worktree boundary,
or publication rules; it carries a reviewed requirement, not new authority.

The Run screen captures and displays the immutable evidence, prepares the task's
isolated branch, launches a plan round, and records an accept/reject decision for
every finding before resolve. A rejected finding requires a reason in the UI,
the IPC schema and the service. Durable `opening`, `reviewing` and `resolving`
states are shown as unknown in-flight outcomes and never become automatic retry
buttons. Coai's documented `status` refusal for a missing repository-and-branch
session is one narrow exception: it is typed as positive absence evidence and
may re-arm only an `opening` gate, because `review_plan` is reached only after
`open` returns. The same evidence from `reviewing` or `resolving` never permits
a repeat. Live acceptance on 2026-09-07 completed the whole `proceed` journey
through Coai 0.14.0 and a real Codex reviewer, including five durable findings,
five decisions and restart read-back. This is evidence for that one path, not a
claim that provider failure, `revise`, timeout and crash windows are all live-
accepted; those remain INT-G scope.

### Auto decide and the plan-correction loop

Migration 19 (`plan-auto-decisions-and-corrections`) adds the durable state for
both. Nothing else about the gate changed: `resolve` is still the only call that
sends decisions to the external provider, and it still refuses an incomplete set.

**Auto decide** asks Codex about ONE finding and records the answer, so the
decision is on the finding when the click finishes. It is a request about one named
round: the renderer sends only `taskId`, `gateId`, `findingsSha256` (the SHA-256 of
the stored `findings_json`) and `findingIndex`; it cannot supply a decision, a
recommendation or a prompt. The main process re-reads the round, refuses when the
identity is not the current one, and merges the result into
`plan_review_gates.auto_decisions_json` with a synchronous read-modify-write, so
concurrent analyses of different findings all survive. An `accept` or `reject` is
stored as a decision with its reason and evidence; `needs_user` is stored only as a
recommendation and leaves the finding undecided. A finding that already has a saved
automatic decision is never analyzed again: a repeated request (a refresh, a second
window, a click after a lost answer) returns the saved decision with no Codex call, and
an answer that finishes after another writer saved one is dropped in its favour, so the
first saved answer stands and a repeat can never contradict it. A stop is just as
firm: once automation has stopped on a finding (`needs_user`) for a round, asking again
reports the stored stop with no Codex call, so a repeat cannot turn "needs a person"
into an automatic decision, and the button says why it is off (in its tooltip and as its
accessible description, since a tooltip on a disabled button is not announced). The operator's own
draft always wins over a saved decision, and a finding with a typed draft cannot be
analyzed at all (its Auto decide button is disabled), so a draft is never replaced.
The detail read (`planReview:get`, `codeReview:get`) also reports `analyzing`, the
findings whose analysis is running in the main process right now, so a panel that was
reloaded mid-analysis still shows it, offers no second click, and reads the round back
every two seconds until the result arrives.
A stored decision is not a resolution: the round stays `awaiting_resolve` until the
operator resolves it. Plan review has no per-finding durable decision, so this
stands in for one, keyed by the round it answers so a new round can never inherit it.
Code review needs no such record: `codeReview:autoDecide` writes the existing
per-finding decision (`decide`, conditional on the finding's revision) as `system`.

**The correction loop.** Accepting a plan finding says it is valid; it does not
change the specification. `Resolve and revise plan` (`planReview:resolveAndRevise`)
resolves the round and then keeps going until a stop condition:

```
awaiting decisions ──resolve──▶ settled round ─┬─ no accepted finding ─▶ plain resolve, done
                                               └─ accepted findings ───▶ Codex revises
      ▲                                                                       │
      │                                                  atomic complete: new immutable version
 Auto decide                                                                  │
      └── fresh Coai plan review ◀── new gate for the revised hash ◀──────────┘
```

The loop owns no state. `planCorrectionNextStep` derives the next step from durable
rows only — the gate, its decisions, the correction row for that gate and the
task's specification — so a crash, a restart or a second window resumes from what
is recorded:

| Durable state | Next step |
|---|---|
| No gate; identity unknown or no gate | none |
| Gate in `opening`/`reviewing`/`resolving`/`failed` | **reconcile** (never repeat a non-idempotent Coai call) |
| Gate `awaiting_resolve` | **decide** (needs decisions) |
| Current gate settled with accepted findings, correction not completed | **revise** — or `round_limit` once `Settings.maxReviewRounds` corrections have run |
| Current gate `proceeded` | clean |
| Current gate `changes_requested`/`interrupted` with no accepted finding | run the next review |
| Gate `prepared` | run its review |
| Obsolete gate | run a review only if a correction completed; otherwise none |

`plan_review_corrections` holds one row per gate that needed a revision, with
`UNIQUE(source_gate_id)` as the idempotency key: a retry reopens the SAME row, so
one gate can never yield two corrections, two versions or two review rounds. The row
freezes what Codex was given (`accepted_json`). Codex must answer with the complete
revised specification AND, for every accepted finding, the specification field in which
it was addressed and what changed there (`addressed_json`, stored with the completion
and shown in the panel). Before anything is committed the service checks that every
accepted finding is named, that none is named that was not accepted, that every
claimed field really differs from the specification being revised, and that no field
changed without being tied to an accepted finding (an unrequested rewrite of a
constraint, the scope or the implementation prompt is refused); otherwise the
correction is marked `failed`, nothing is stored, and the same row is retried. This
does not prove a finding is fixed — only the fresh independent review can — but a
revision that changed something unrelated, or ignored a finding, is refused instead of
being carried into that review as though it were dealt with. The round number is the
newest one plus one, not a count. The Codex call has no effect until
`complete`, which in one transaction swaps `tasks.specification_json`
(compare-and-swap on the exact text the correction started from), appends the
version and closes the row. A crash before that leaves a `running` row that is read
as `interrupted` when no loop is alive in this process. `task_specification_versions`
is append-only, enforced by an `UPDATE` trigger; the first version is recorded
lazily in the transaction that opens the first correction. Every revised
specification is a new hash, so the existing gate-per-hash rule gives it a fresh
rule-evidence binding and a fresh Coai session round. That gate is created carrying
the previous round's contract fingerprint, and a gate for the revised specification
that already exists (prepared by an earlier attempt or from another screen) has the
fingerprint carried onto it, so a provider whose tool contract changed between rounds
is flagged, never adopted.

The loop stops, and says why, on: `needs_user` findings (Auto decide stops on
purpose), a verdict that needs a human, Coai's contract fingerprint changing, a gate
that needs reconciliation, the correction budget (checked BEFORE accepted decisions
are sent to the external reviewer, so findings the budget cannot revise are never
recorded as accepted there; the round stays open), a stale revision or concurrent
mutation, or a Codex/validation failure (the row is marked `failed` and nothing is
changed). It never approves the specification and never advances past an accepted
finding the specification does not yet reflect: approval refuses a specification whose
own review round accepted findings (`APPROVAL_REQUIRED`), and a plain `resolve` refuses
any decision set containing an accept, so the only way to settle such a round is the
loop that revises the plan.
`Resolve review` (no revision) is available only when nothing was accepted.

**Review identity.** Coai keys a session by (repository, ref) and `open` is idempotent: the same
pair returns the same session however far it has advanced, and there is no "new session"
parameter (the tool schemas are `open`, `status`, `review_plan`, `resolve`, plus the ones this
build does not call). Every gate of a task used the task's branch, so once the first review was
resolved — the session then stands at CodeReview — the loop's review of the revised
specification was handed that finished session and `review_plan` was refused ("the plan stage is
over for this session"), and reconciling that gate read the finished session back and settled the
corrected plan as `proceeded`. A gate now records the ref it was reviewed under
(`plan_review_gates.review_subject`, additive, migration 20). A task's first gate keeps the task's
branch; every later gate is given a ref of its own by `PlanReviewSubjectFactory`
(`GitPlanReviewSubjectFactory`): one commit object — the task branch head's tree, that head as its
parent, a message naming the gate and the specification — that no branch, tag or other ref reaches.
The provider resolves the ref with `git rev-parse` and documents a commit id as a valid ref, so the
id is a fresh identity. Nothing is checked out, staged, created as a ref or pushed, and the task
branch, its worktree and the user's checkout are never written; the only Git commands are
`rev-parse` and `commit-tree` (signing forced off, fixed author and timestamps).
- Lifecycle: the commit is fixed by its inputs, and no two gates can share one (the gate id is in
  the message). For a gate whose row already exists (the loop's review of a revised specification) a
  crash between making it and recording its id names the same object on retry; a recovery retry is a
  new gate with a new id, so an interrupted one leaves one more unreferenced object that nothing points
  at. The id is the gate's `review_subject`, used by every provider call for that gate — `open`,
  `review_plan`, `status`, `resolve`. There is nothing to delete: an unreachable object is removed
  by Git's own `gc` after `gc.pruneExpire` (two weeks by default) and Agent Relay creates no ref that
  would keep it (a ref would show in `git branch`/`for-each-ref` and be pushed by a mirror push).
  After that, on the real server, `status` still answers for a session already opened under the pruned
  id (it looks the session up by key), so a dispatched gate remains reconcilable; a new `open` is
  refused with `git rev-parse: cannot resolve '<id>' ...`. The adapter types exactly that refusal as a
  known non-dispatch (`unresolvable_subject`), so an undispatched gate is marked spent and offered
  the fresh-session retry instead of looping through reconcile.
- `open` proves nothing by returning, so before the non-idempotent `review_plan` the service checks
  the session it got: it is not another gate's, it is the one this gate recorded, it is at PlanReview
  and not awaiting a resolution, and — for a first dispatch — it is provably empty (the adapter reports
  the rounds `open` returned; a provider that does not say proves nothing, and nothing is not read as
  "none"). Otherwise nothing is sent: the gate goes back to `prepared`, marked `failure_kind` (the
  session it was handed is NOT recorded as its own), and the loop stops with `recovery_required`.
- Each dispatch records how many plan rounds its session already held (`rounds_at_open`). A read-back
  attributes a round to the dispatch only if the count went up; a previous round "returned by status"
  settles nothing.
- Rows written before migration 20 (the four columns are NULL): a NULL `review_subject` means the
  task's own branch — the identity every earlier gate was dispatched under — so an in-flight legacy
  gate is read back against the session its round actually lives in; a NULL `rounds_at_open` means
  no baseline check (the earlier behaviour); and session ownership is structural (the first gate to
  record a session owns it), so a legacy gate that shares a session with an earlier gate is foreign
  and is recovered without any provider call. Nothing is backfilled or rewritten by the migration.
- Reconciliation reads only evidence that is the gate's. A gate whose recorded session belongs to an
  earlier gate (the first to record a session owns it) is not read against the provider at all: it is
  marked `foreign_session` and left as it was. A gate still at `opening` sent no round, so rounds found
  in its session are foreign. A gate with a session of its own that is answered for another one keeps
  its unknown outcome (a mismatch) and is not replaced over it. The same rule stops approval:
  `assertPlanReviewAllowsApproval` — used by approve, implement, verify and a continuation — refuses a
  `proceeded` gate that was settled by reading another review's session.
- Failures are not equal. A provider refusal in words the adapter has audited as coming before any round
  (`plan stage is over`, `no session`) and a session found unfit are known non-dispatches
  (`PlanReviewNotDispatchedError`; safe to replace under a fresh identity). A timeout, a lost
  connection or a refusal in other words is an unknown outcome: never classified, never repeated, never
  replaced — only a read-back may settle it. The loop never retries by itself in either case.
- Recovery. A gate that cannot count (`planReviewRecovery`, derived from the task's own rows) is shown as
  such, the loop's next step is `recover_review`, and the one action is "Retry in a fresh review session"
  (`planReview:retryFreshSession`, which replaces and nothing else; the replacement is an ordinary current
  `prepared` gate, so reviewing it is the usual separate "Run external plan review" — these calls are never
  chained): `retryInFreshSession` makes a review identity, then in ONE transaction
  writes a new gate for the SAME specification and rule evidence and marks the old attempt
  `superseded_by` it (its status, session and error text untouched), withdraws an approval that rested
  on the discarded evidence, and sends nothing to the provider; the review is a separate, explicit call.
  It refuses an attempt whose call has an unknown outcome on a session of its own, and one whose
  specification has since changed. It never starts implementation.
- Implementation stays impossible while the specification is unapproved or its review cannot count: the
  approval check runs in the backend entry points themselves, not in the renderer. The status badge says
  "Specification awaiting approval" for an unapproved `READY_FOR_IMPLEMENTATION` task (the internal
  status is unchanged), and no screen offers "Run implementation" until an approved, reviewed plan exists.

**Stopping.** The task stays `READY_FOR_IMPLEMENTATION` while the loop runs, so `Stop task`
(`workflow:stop` → `Orchestrator.stop()`) has to reach it, and `Orchestrator.stop()` used
to know only its own agent runs. `TaskOperationRegistry` is the process-wide register of
stoppable operations, built ONCE in the composition root and handed to the orchestrator and
to every plan-review service the IPC layer builds per call (a per-call registry would stop
nothing). It is separate from `PlanReviewClaims`: claims arbitrate which plan-review
operations may overlap, the registry decides who can be cancelled, and each keeps its own
guarantees.
- Every claim-taking entry point registers first — the loop (exclusive), `review`,
  `resolve`, `reconcile`, `triage` (exclusive) and one finding's Auto decide (shared, like
  its claim) — links any caller-supplied signal to the operation's own controller, and
  removes the entry in a `finally`. A second conflicting operation for the task is refused
  (`BUSY`), and so is an agent run.
- That ONE signal is what the loop passes to Auto decide, Coai `resolve`/`open`/`review_plan`
  and Codex `reviseSpecification` (which no longer builds a fresh, unreachable one), and the
  loop checks it before every step. Analyses not yet dispatched are never sent.
- `Orchestrator.stop()` writes `CANCELLED` first and THEN signals the registered operations,
  synchronously, so nothing an operation does after its next `await` can find the task
  still eligible. Every durable write that follows an awaited provider call re-reads the
  task and refuses a stopped one; the specification swap itself
  (`PlanCorrectionRepository.complete`) also requires the task to still be in the status the
  revision started in, so a revision that returns after Stop changes nothing — no
  specification, no version, no completed correction — whatever any signal says.
- Honesty about outcomes: a stop while Coai `open`/`review_plan`/`resolve` is in flight
  leaves the gate in the phase it wrote before the call (`opening`/`reviewing`/`resolving`)
  with an error that says the outcome is unknown, so the next step is `reconcile`, never a
  repeat. A stop while Codex revises marks the correction `failed` with a message saying the
  read-only revision was discarded. A revision that committed atomically just before Stop
  is preserved as the fact it is, but no later review starts.
- Whatever a provider throws when the stop kills its call (a typed CANCELLED, a generic exit,
  a transport error), an operation whose own signal was aborted is reported as a stop
  (`asStopped`), a Codex revision's row says it was stopped and discarded, and a gate's note
  says the outcome is unknown with the provider's words after it. `operations` is a REQUIRED
  dependency of both `PlanReviewGateService` and `PlanCorrectionService`, so building either
  without the cancellation wiring is a compile-time error.
- The panel reports a stop as a stop (neither a success nor a fault of the loop), reads the
  round back, and `Stop task` stays usable while the loop runs but cannot be double-submitted.

**Code review** treats accepted findings as correction requirements, not fixes.
`codeReview:get` returns them with one of three statuses — `open` (the code has not
moved), `awaiting_fresh_review` (it moved; no review of it yet) and
`fresh_review_done`. The requirements are merged into the existing correction round
(`Orchestrator.sendCorrections`, allowed from `READY_FOR_REVIEW`/`APPROVED` through
the `corrections_sent` workflow edges), so the implementation provider, round budget,
verification and review are the ones every correction already uses. A finding is
closed only by an explicit `resolved` decision, which the service accepts for a
finding of an older subject only when a completed review round exists on the newest
subject, and refuses outright for an accepted finding on the current code (it is a
correction still owed, and the code has not moved). A finding nobody accepted keeps
the behaviour it always had. Codex can be wrong, so a decision it made carries a
"Change decision" control: the operator's own accept or reject is appended after it
(the automatic one stays in the history) and is the one in force.

**Stopping a code review.** `Stop task` reaches a code-review round, a reconciliation, a
whole-set analysis and one finding's Auto decide through the SAME `TaskOperationRegistry` the
plan side uses: `CodeReviewService` takes `operations` as a required dependency and the
composition root hands it the instance the orchestrator's `stop()` reads, so there is no second
registry and no private controller. `review`, `reconcile` and `triage` register as exclusive
operations, a finding's Auto decide as a shared one (different findings still run together, and
one Stop reaches all of them), each before its first read or provider call and released in a
`finally`; `runAsOperation` is the one helper both services use for that. The operation's own
signal goes to every provider call that takes one: the reviewer's `availability`, `beginRound`,
`reviewCode` and `roundStatus`, and Codex `triageFindings`.
- After every awaited external call, again after the local re-read of the working tree that
  follows it, and immediately before the write it guards with nothing awaited in between, the
  service checks that the signal is not aborted and the task is neither stopped nor closed. The
  database writes are synchronous and `stop()` is synchronous, so a write that passes the check
  cannot be overtaken by a stop. What it guards: creating the round, marking it dispatched,
  completing it and storing its findings (`persistCompletion`, live or by reconciliation), storing
  the analysis (`upsertTriage`), recording a decision (manual, or Auto decide's through the same
  `decide`) and storing a captured subject. Codex is not started for a task that was stopped while
  it was being prepared, and a new operation for a stopped task is refused before it reads anything.
- Honesty about outcomes: a stop while `reviewCode` is in flight leaves the round `reviewing`
  with a note saying its outcome is unknown and was not recorded — never `completed`, never
  `failed`, and never with findings; a stop while the round is being reserved closes it as `failed`
  (nothing was dispatched); a stop during a read-back changes nothing (a read-only call learned
  nothing that may be written). The task is closed by then, so the outcome cannot be reconciled
  from Agent Relay afterwards: the provider's own record is the place to look. In a batch stopped
  part-way, decisions written before the stop stay recorded, the rest are refused, and every call
  that did not finish reports the stop instead of a success.
- Concurrent operations: an exclusive operation is refused (`BUSY`) while anything else is
  registered for the task, and a second Auto decide for the SAME finding is refused by its claim.
  A manual decision made while Auto decide analyzes the same finding keeps its compare-and-swap on
  the finding's revision (the automatic result is dropped as `already_decided`), and a decision on
  a stopped task is refused whoever asks. An agent run is refused while any of these is
  registered, and `Stop task` during an agent run signals them too.
- The panel says the task was stopped and reads the review back once; a bulk Auto decide that was
  stopped part-way reports the findings it did not analyze as failures, never as a success.

### Authoritative Run actions and linked continuations

`runGuidance` is the authoritative projection for **Run → Actions**. It maps the
Task status plus the current External Plan Review identity/phase and continuation
entry metadata to the four guidance strings and zero or one `RunPrimaryAction`.
When an action exists, `Next action` is assigned from the descriptor's label;
the renderer does not keep another label or recommendation table. `RunView`
renders one primary control and exhaustively dispatches its key to one bounded
IPC operation. Plan-review preparation, review, reconciliation and resolution
remain separate calls and are never chained. Provider configuration and Stop
are structurally separate controls.

Migration 10 adds `task_continuations`, a one-to-one immutable source/continuation
relationship, and a partial unique index allowing only one non-terminal Task per
non-null worktree path. The relationship records the initially selected entry
action and explicit inherited implementation, verification and review run ids;
source runs are neither copied nor reparented. `TaskDetail` exposes bounded link
summaries in both directions, plus an in-progress/ready creation status so an IPC
timeout can be recovered by reopening the source or retrying the idempotent call.

`task_continuation_claims` is the durable, process-wide worktree lease. A
`creating` claim is committed before asynchronous checkout identity validation.
The identity is sampled a second time immediately before the creation
transaction; a mismatch changes the new task and bound claim to verification
entry in that same transaction, before a renderer can observe the result.
Task creation, cloned immutable rule/settled plan evidence, the relationship and
binding the claim to `awaiting_first_action` then commit in one SQLite
transaction. A retry returns the existing linked task. Startup deletes orphaned
`creating` claims (no related writes can have committed) and inconsistent or
terminal bound claims, while retaining a valid continuation waiting for its
first action. Concurrent service instances follow the durable claim until it
either produces the link or is released; they do not guess that a legitimate
identity read must finish inside a short wall-clock timeout.

The lease remains held until that first corrections, verification, or review
action recomputes checkout identity and durably enters its busy state. A mismatch
before corrections/review atomically changes the effective pending entry to
verification and fails before a provider is dispatched. The historical chosen
entry remains on the relationship; the claim's effective entry is the sole
active override until consumed, after which Task status is authoritative.
Specification regeneration is not a protected first action and is refused while
this lease is pending, before a run row, provider call, or Task mutation.
Cancelling before dispatch releases the lease. The partial worktree index then
governs the ordinary lifecycle: FAILED, CANCELLED and COMPLETED release active
ownership, including crash-recovered continuations and continuation chains.

Inherited verification is eligible only until the continuation records a newer
implementation, correction or verification. Review and publication recompute
the current `WorktreeVerification` identity immediately before dispatch; stale,
malformed or failed evidence rejects before reviewer, commit, push or GitHub
work. Inherited review rows never count against the fresh budget, which begins at
round zero and uses the currently validated `Settings.maxReviewRounds`.
`TaskDetail.effectivePublishRefusal` applies the publication service's same
own-first/inherited-until-superseded implementation selector, keeping Run
guidance from treating an intentionally empty continuation run history as
missing evidence. A newer successful, current Agent Relay verification may
replace an inherited verification/configuration/telemetry refusal, but never an
inherited security refusal. Closed source-task code-review history remains
readable; capture, dispatch, reconciliation and finding decisions all reject
before writing or contacting a reviewer.

### External code-review evidence — INT-D-A backend foundation

**Status: backend only.** There is no renderer, no correction loop and no live
provider acceptance for this path yet. Migration 7 adds the durable layer the
remaining slices will stand on. The provider adapter is INT-D-B and is now
present — see "The code-review provider adapter" below — but it is switched off
by default and refuses against the Coai build shipped today, because that build
cannot name a round before it runs one.

Why this is separate from the plan gate rather than folded into it: the plan
gate answers one question per specification identity and decides its findings in
a single `resolve`, so one JSON blob per gate is an honest representation. Code
review asks the same question of a moving artefact round after round, and the
same defect can survive several rounds, be fixed in one, and reappear. That
needs findings that are rows with their own identity, history and decisions. An
array index cannot be that identity — the third round's index 2 is rarely the
first round's index 2 — and re-serialising the array each round would erase
exactly the history the table exists to keep.

Migration 7 adds four tables. `code_review_subjects` is insert-only: there is no
update path anywhere in the repository port, because a statement about what was
reviewed that can be edited afterwards proves nothing. `code_review_rounds`
carries the provider and server identity, session, verdict, reviewers, gating
count, threshold, reported usage and a monotonic `revision`.
`code_review_findings` holds the stable local ids, provenance and dedup
fingerprints. `code_review_decisions` is append-only, so a superseded answer
stays in the trail instead of being overwritten. No absolute path is stored in
any of them.

The subject is the whole contract. `GitCodeSnapshotSource` captures the task
branch with five read-only commands — `rev-parse`, `merge-base`,
`diff --name-status`, `ls-files --others` and `status --porcelain` — behind an
allowlist rather than a forbidden list, because it has exactly those things to
run and anything else would be a bug. It deliberately does **not** use `git add --intent-to-add`,
which is how [`collectChanges`](../src/main/adapters/git/git-adapter.ts) makes
untracked files visible to `git diff`: that writes index entries into a checkout
the user owns, and producing a snapshot by modifying the thing being measured is
the one property it must not have. Committed work, uncommitted tracked edits and
untracked files are all covered, and no hidden commit is ever created.

Every changed regular file is **streamed** and digested, whatever its size, and
the canonical form ([`canonicalCodeSnapshot`](../src/shared/domain/code-review.ts))
writes base commit, head commit, branch, entries, omissions, completeness and
whether the worktree holds uncommitted work, in a fixed order with entries sorted
by path. It contains repository-relative POSIX paths only — no absolute path, no
checkout location, no timestamp, no machine identity — so two machines looking at
the same code agree on what it is.

Streaming replaced a size ceiling, and that was a correctness fix rather than a
performance one. A file skipped for being large used to record only its path, a
reason and a byte count, so **two different files of exactly the same length
produced identical entries and therefore one subject hash** — different code with
the same identity, which is the single failure this design exists to prevent.
Constant-memory hashing removes the reason the ceiling existed.

What cannot be digested — an unreadable file, or a path that resolves outside the
worktree — is recorded by name and reason, and marks the snapshot **incomplete**.
An incomplete snapshot is still stored, because it honestly says what was and was
not seen, but it is never treated as exact: `review` and `decide` both refuse
against it. A truncated change set is incomplete for the same reason. Partial
evidence presented as exact is how a review comes to describe code nobody looked
at.

A snapshot also has to say that the tree held still while it was read, and
that claim is proved at the level of bytes rather than inferred. The whole change
set is digested, then digested again, and the two content manifests must
match. A manifest entry is the same tuple the subject hash is
built from — path, change, digest, size — because a manifest holding less than
the identity holds cannot prove the identity was stable: an untracked file that
gets added to the index between the passes has the same bytes and a different
subject. Alongside the entries the manifest carries the file-set composition,
the base and head commits, the branch and the checkout's own identity. Divergence is
retried a bounded number of times; if no attempt reproduces itself, the capture
is stored as **incomplete** and never as exact.

The cheap Git description (head, branch, `status --porcelain`, the change set
with its added and removed line counts) is kept ahead of that comparison as an
early exit, but it is not the proof, because it cannot be. An edit that replaces
a file's body with a different body of the same shape moves none of its fields:
`--numstat` still reports the same counts, `--name-status` the same letters,
`status` the same lines. A file digested early in a pass could therefore be
rewritten while a later file was being read, and a capture trusting the
fingerprint would call that combination exact — a subject hash naming a state
that never existed on disk. Only re-reading the content can rule it out, and a
snapshot that claims to be an exact statement of the code has to have ruled it
out.

Path safety is enforced on both sides. The reader resolves the real path and
refuses anything that is a symlink or reparse point, or that lands outside the
worktree — a link with an innocent-looking name inside the tree can point at a
private key. Reviewer-supplied `file` locations are validated as empty or
repository-relative POSIX, rejecting absolute paths, drive letters, UNC shares,
`..` traversal, backslashes and NUL: a path is the one field in reviewer output
that something downstream will eventually try to open, and one that needed
sanitising meant something this gate does not permit.

Before any durable write and before any external call, the checkout itself is
validated: the worktree must share a Git common directory with the project, must
not be detached, and must be on the branch the task records. A worktree that
moved, was re-pointed or was left on another branch is refused with
`WORKTREE_INVALID` and leaves no round row behind.

Staleness is therefore not a flag anybody has to remember to set; it is the
observable difference between two hashes — but only between two hashes that are
each exact. `subjectIdentity` answers in this order, and the order is the
contract:

1. the capture failed → `unknown`, carrying a bounded, redacted reason;
2. either snapshot is incomplete → `incomplete`, **whatever the hashes say**;
3. both exact and the hashes differ → `stale`;
4. both exact and equal → `current`.

Completeness is checked before the hashes because an incomplete snapshot's hash
is not an exact description of the code: two partial captures can cover
different sets of files and hash differently without anybody having edited
anything. Reading that difference as `stale` would be a claim — "your code
moved" — derived from evidence that cannot support it, and would send an
operator to re-capture when the real problem is a file nobody can read.

The same five states are what a completed round reports, in one
`subjectAfter` field rather than a pair of booleans. Two booleans express four
combinations, two of them meaningless, and leave every reader to reconstruct the
state machine — which is exactly how `incomplete` came to be reported as
`stale`. Only `current` puts a result in force.

### The code-review provider adapter (INT-D-B)

`CoaiCodeReviewer` speaks to a Coai MCP server over the same bounded stdio
transport the plan gate uses: one short-lived process, no shell, a fixed argv
from persisted settings, and a tool list that must match the configured
allowlist EXACTLY.

**Two audited profiles, and nothing between them.** A profile is a complete tool
list, not a minimum.

| Profile | Tools | What it serves |
|---|---|---|
| plan | `providers`, `open`, `review_plan`, `review_code`, `review_document`, `consult`, `resolve`, `status`, `ask_human` | plan review only |
| addressable | those nine plus `reserve_round`, `run_round`, `round_status` | plan review **and** code review |

A server whose list is missing a tool, carries an unknown extra, or repeats a
name is refused — the same refusal in all three cases, because from this side
they are the same fact: the contract is not the one that was read. "The tools I
need are present" was deliberately not implemented; a server that grew a tool
nobody here has audited may have changed its others too. `CoaiPlanReviewer`
accepts either profile, so a deployment running the newer server need not run a
second one to keep the plan gate working.

**One server, one profile, chosen by what is enabled.** Both gates talk to the
same executable, so the profile is decided by configuration rather than by which
gate is asking: with code review off the plan gate is configured for the nine
tools, and with it on BOTH gates are configured for the twelve. Pinning the plan
gate to nine for ever would have refused the addressable server outright — so
enabling code review would have silently broken plan review against the very
server that supports both. The choice is still between two audited lists; it is
never a subset, a minimum or a superset.

**The installed Coai server is the plan profile.** It has `review_code`, and
that is precisely the tool this adapter must never call: it creates its own
round and names it only afterwards, so a caller whose answer was lost has
nothing to ask about. `availability()` discovers the profile, finds the three
addressable tools absent, and reports **"addressable code review is not
supported"** — before `CodeReviewService` writes any durable intent, so a
refusal leaves no round row to reconcile. Nothing in this build depends on a
sibling checkout or an unpublished local server: the profile is a wire shape,
and a server either presents it or is refused.

**Each method calls exactly one tool, and never another.**

| Port method | Tool | Consumes a round? |
|---|---|---|
| `availability` | *(discovery only)* | no |
| `beginRound` | `reserve_round` | no |
| `reviewCode` | `run_round` | yes |
| `roundStatus` | `round_status` | no |

**The reservation token is the durable local round id.** `reserve_round` needs a
stable idempotency key, and the round row already exists when it is called, so
its id is the key: it survives a restart, it is different for every local round,
and — unlike the subject hash — it tells two rounds over the SAME code apart,
which is the ordinary case of reviewing something twice. It is not a timestamp
and not anything the adapter invents, because neither survives the restart the
token exists for. `ExternalCodeReviewer.beginRound` therefore takes the token as
an argument rather than deriving it from the subject.

**Known, and bounded: a lost `reserve_round` answer strands its reservation.**
If the reservation succeeded at the provider and only its answer was lost, the
local round is closed as a refusal that provably reviewed nothing, and the next
review builds a new row with a new token — so nothing ever addresses the old
reservation again. The cost is bounded to the provider's own bookkeeping: a
reservation dispatches no reviewer and spends no round quota, so a stranded one
reviews nothing and costs nothing. Resuming it would need a durable reservation
phase of its own, and that is deliberately not designed here.

**A locator component is an opaque identifier, and it has a shape.**
`sessionId` and `roundId` are opaque to Agent Relay — it never parses them, only
stores them and hands them back — and that is precisely why they need one. They
are written to the durable round and shown wherever a round's provider identity
is, so a length bound alone let a server name its own session with an escape
sequence, a path, an argv fragment or a token and have it persisted verbatim.

The allowed alphabet is letters, digits and `. _ - :`, starting with a letter or
a digit, 1–128 characters. That covers every identifier a real server produces —
UUIDs, hex digests, dotted and colon-namespaced slugs — and excludes whitespace,
control characters, quotes, slashes and backslashes, so a component can be
neither a path nor a command line fragment. The leading character is constrained
separately so an id cannot begin with `-` and read as an option. A
credential-shaped value is refused on top of that, because a token satisfies the
alphabet on its own.

Nothing is normalised or stripped: either the value is acceptable whole or the
locator is refused whole, since a locator edited on the way in no longer names
the round the provider created. The check runs at the adapter's SCHEMA, so a bad
component fails the whole payload closed, and again in `CodeReviewService` before
the locator becomes durable — `ExternalCodeReviewer` is an interface, and a
second implementation reaches that line without passing through the adapter at
all. `providerId` is checked for shape there too and, separately, for equality
with the trusted local provider identity: whether the string is storable and
whether the round is ours are different questions. A refusal names the field and
the violation, never the value, and it happens above the non-idempotent call, so
the round is closed as a pre-dispatch failure rather than left unresolved.

**Every uncertain read-back is `unknown`.** `roundStatus` maps `running` and
`completed` as the provider states them, and returns `not_started` only when the
provider positively says so about a round it holds and has not dispatched. A
timeout, a transport failure, a refusal returned as data, output that will not
parse, a `completed` with no result attached, an answer carrying another
locator, and a provider reporting the round as spent all become `unknown` with a
bounded redacted reason. None of them is read as "nothing ran", because only one
of them would be safe to and they are indistinguishable from here.

**A contradictory answer is ambiguity, not evidence.** `round_status` is parsed
as a discriminated union on `state`: only `completed` may carry a `review`, and
every other state is a strict object without the key. A payload claiming
`not_started` while also carrying a finished review therefore does not parse,
and a parse failure is `unknown`. That closes the one path by which a provider
could be asked to re-run a round it had just said it completed — `not_started`
is the single answer that releases a round, so it has to be free of
self-contradiction.

**Exactly four provider strings are stored, and all four are checked twice.**
A completed round carries `serverName`, `serverVersion`, `reviewers` and
`instruction` into SQLite. `serverInfo.name` and `serverInfo.version` arrive in
the MCP initialize handshake rather than in a tool result, so the credential scan
that runs over a payload never saw them at all; `reviewers` and `instruction` are
in the payload, but that scan looks for credential shapes and for nothing else.

| Field | Rule |
|---|---|
| `serverName`, `serverVersion` | identity: bounded length, **no** control character of any kind, no credential shape |
| `reviewers`, `instruction` | prose: bounded length, tab/newline/carriage-return allowed and every other control character refused, no credential shape |
| `findings` | unchanged — parsed against its schema and scanned as a whole |

The check runs in `CoaiCodeReviewer` before a round is built, and **again** in
`CodeReviewService.validateAnswer`, which is the boundary where an answer becomes
durable and is shared by a live dispatch and by reconciliation.
`ExternalCodeReviewer` is an interface: a second implementation reaches storage
without passing the adapter at all, so the adapter's check is a convenience and
the service's is the guarantee. An unstorable value fails the round rather than
being cleaned up — none of it is kept, and the refusal names the field and the
problem, never the value.

Two layers, in this order: the result-wide credential scan inside `parse` refuses
a payload before a round is built, so a credential never reaches the per-field
check. The per-field check is what adds the control-character and length rules,
which the scan was never meant to cover.

**A provider's own explanation is never stored, on any of the four paths.**
`lastError` is durable and operator-visible, and redaction hides credential
*shapes* — it hides neither an absolute path, nor an argv, nor a control
character, and was never meant to. So no provider-authored sentence reaches it.
The reviewer can produce one at four different moments, and each is answered with
a fixed message this build owns:

| Path | What the provider could say | What is stored |
|---|---|---|
| reservation (`reserve_round`) | a refusal, a transport error, a `state` string nothing constrains | `RESERVATION_FAILED` — closed as failed, nothing was dispatched |
| live dispatch (`run_round`) | a refusal, a timeout, a lost answer | `DISPATCH_UNCONFIRMED` — stays unresolved, because it may have run |
| dispatch never attempted | nothing; the reviewer was gone before anything was sent | `DISPATCH_NOT_ATTEMPTED` — closed as failed, on typed proof |
| completed answer | `serverName`, `serverVersion`, `reviewers`, `instruction` | the round itself, once all four pass the checks above; otherwise the owned sentence naming the field, or `ANSWER_MALFORMED` for a schema failure |
| reconciliation (`round_status`) | an `instruction` beside `failed`/`unknown`, and the port's `reason` | `RECONCILE_UNKNOWN`; `status.reason` is deliberately not read |

The reservation path matters most and was closed last. `CoaiCodeReviewer.parse`
quotes an MCP server's refusal sentence into `AgentRelayError.message` **on
purpose**, so the caller who asked for a review can be told what the server said
— which meant both live catches were copying foreign text into SQLite by simply
storing `error.message`. The adapter's reservation check no longer interpolates
the provider's `state` either: which state it was is not worth storing at the
price of a field nothing constrains.

**`failed before dispatch` and `unconfirmed after dispatch` are different facts,
and only one of them may close a round.** From inside a catch block they look
identical, so the distinction cannot be guessed: it is carried by a TYPE.
`SettingsBoundCodeReviewer` resolves configuration per call, so a round can be
reserved while the integration is on and find it switched off before anything is
sent; `required()` throws `CodeReviewNotDispatchedError` there, and that class is
positive evidence that no request left the process, because it is raised from the
configuration seam which is always reached BEFORE any MCP call.

`CodeReviewService` branches on `instanceof`, never on the code. `TOOL_MISSING`
alone proves nothing — a real adapter can raise it from inside an external call,
once the request has already gone out, and treating that as proof would close a
round that may well have run. On the typed error the round is closed `failed`
with `DISPATCH_NOT_ATTEMPTED` and a new round may be started once the integration
is configured again; on anything else it stays `reviewing` with
`DISPATCH_UNCONFIRMED`. The typed error is rethrown unchanged, so the caller
still receives its ordinary `TOOL_MISSING` code and message.

**Transient and durable are deliberately different.** The original error is
rethrown untouched, so the immediate caller keeps its `code`, its message and
whatever classification it needs to decide what to do or what to show. Only the
copy that lands in the round is fixed. Being told what went wrong and recording
it forever are different acts with different risks, and this is the seam between
them.

What is lost is a provider's description of its own failure, which was never
trustworthy enough to store. What is kept is the part that governs behaviour: a
reservation that failed dispatched nothing, and a dispatch whose answer was lost
may well have run.

**Dirty subjects are still refused.** `readsUncommittedWorktreeState` is `false`
and stays false whatever is configured: `run_round` reviews a commit in a
worktree the provider pins to a SHA, so uncommitted and untracked work is
invisible to it. The service refuses such a subject before dispatch rather than
accepting a confident verdict about different code. Reviewing a dirty tree needs
a provider that can snapshot it AND prove the snapshot is the caller's own; that
attestation does not exist, and this pass does not invent it — no hidden commit,
no staging, no mutation of the user's index.

**Wiring is main-process only.** `SettingsBoundCodeReviewer` resolves the
configuration per call from persisted settings, so enabling the integration or
clearing its executable takes effect on the next call rather than the next
restart, and a build with nothing configured refuses exactly as the unconfigured
reviewer did. `codeReview:review` accepts a task id and nothing else: the
executable, argv, working directory, tool profile, provider identity, subject
and scope are all resolved here from durable state. `CodeReviewClaims` remains
the single-flight authority, so two windows race in the service rather than at
the channel.

**A refusal repeats nothing the server sent.** `availability.reason` is stored
and shown, and carries no path, argv or secret. A tool-profile mismatch is
recognised by its TYPE — `McpToolProfileMismatchError`, thrown by the transport —
and answered with names from this build's own `COAI_ADDRESSABLE_TOOLS`. Every
other discovery failure gets a fixed sentence plus its error code, because the
transport uses the same `details` field for a failed spawn's raw stderr, which
can hold an absolute path or a command line. Redaction hides credential shapes;
it does not hide a path, and was never meant to.

**Live provider acceptance has not been performed.** Every test runs against an
Agent Relay-owned fake MCP process; no vendor model has been called and no
provider quota has been spent through this adapter.

### Where the dispatch boundary is

Everything that can refuse without an external effect happens first, and the
last of those refusals is a typed preflight: `ExternalCodeReviewer.availability()`
answers whether a call can be made at all. The order is

> checkout identity → unresolved-round check → subject identity → reviewer
> capability → **availability preflight** → *(boundary)* → round row → dispatch

A refusal above the boundary is proof that nothing external happened, so it
leaves no round row to reconcile; a failure below it is not proof of anything and
leaves the round unresolved, blocking an automatic retry. That distinction is
carried by an explicit contract rather than inferred from whatever exception a
`reviewCode` call happens to throw — guessing between "no provider is
configured" and "the call went out and its answer was lost" from an exception
type is how a provably local refusal came to leave a `reviewing` row behind.

The reviewer is handed the **task worktree**, not the project checkout, because
that is where the snapshot came from; pointing it at the project root would hand
it a different working tree that merely shares a repository. And because a
reviewer that reads only committed refs cannot see a subject containing
uncommitted work, `ExternalCodeReviewer` declares
`readsUncommittedWorktreeState`, defaulting to false — such a subject is refused
rather than dispatched, since the failure it prevents is not a worse review but a
confident verdict about different code.

An answer must also attest what it read: `ExternalCodeReviewRound` carries
`reviewedSubjectSha256`, and a result that does not match the dispatched subject
— or that omits the attestation — is refused, leaving the round unresolved with
no findings. `readsUncommittedWorktreeState` is a promise about a reviewer's
general behaviour; attestation is evidence about this particular answer, and only
the second catches a reviewer that read the right worktree at the wrong moment or
an answer that arrived for another round. An INT-D-B adapter that declares the
capability must therefore compute and return the same snapshot hash; the boolean
alone is not sufficient.

Attestation says what an answer read; it does not say which round the answer
belongs to. Those come apart, because several rounds legitimately share one
repository, branch, base, head and subject hash — reviewing the same code twice
is the normal case — so a subject describes a round no more uniquely than a
street name describes a house. `ExternalCodeReviewer` therefore works in terms
of an `ExternalCodeRoundLocator`: the provider it lives at, plus that provider's
own session and round identity, opaque here. The provider is part of the name
rather than context around it, because session and round ids are unique only
inside one provider's namespace — and the configured reviewer can genuinely be a
different one by the time recovery runs, which is exactly when an unresolved
round is waiting. Reconciliation compares the recorded provider against the
reviewer it is about to ask, and refuses rather than asking a stranger a
question that it might answer.

The order matters more than the type. `beginRound` opens or reserves the round
at the provider and must not consume one; its locator is written into that
specific durable row **before** the non-idempotent `reviewCode` dispatch, so a
crash afterwards leaves a round that can be named rather than one that can only
be described. `reviewCode` and `roundStatus` both take the locator, answers echo
it back, and a result whose locator is not the dispatched one is refused with the
round left unresolved — a round with no recorded locator can never be settled by
recovery at all.

Because the locator is what an answer is checked against, the answer may not
restate it: the completion transaction writes the verdict, the findings and the
provider's own reporting, and deliberately leaves all three locator columns
alone. Letting a result rewrite the identity it was matched on would make the
check circular, and a provider that merely omitted a field would blank part of a
locator on an otherwise good round. The database holds the same invariant from
below — a `CHECK` that the three columns are all present and non-empty or all
null, so half a locator cannot exist, and a partial `UNIQUE` index so two local
rounds can never claim one provider round and both accept the same recovered
answer. Both halves of the locator are validated for shape before the dispatch
that depends on them, not when the recovery that needs them finally runs. Without that, "what happened to the round for this subject?" is
a question with more than one right answer, and whichever came back would be
written into whichever row was still open: another round's verdict, filed as
this round's evidence.

An answer that lists the same finding twice is folded to one before the
completion transaction, because a provider repeating itself is not describing
two defects and must not collide on `UNIQUE (finding_id, round_id)` and discard a
real review. But the fingerprint deliberately excludes `gating` and `fix`, so two
entries can share an identity while disagreeing about whether the defect gates
the round — there is no honest way to choose, and choosing silently would record
a gating decision the reviewer never made, so that answer is refused as the
contradiction it is. `newFindings` and `repeatedFindings` count distinct
findings, not array entries.

`CodeReviewService` writes the round row before the reviewer call leaves the
process, so a crash between dispatch and answer leaves durable intent rather
than silence. Completion is one transaction: the round status, every finding and
every occurrence are written together or not at all, because a `completed` round
holding only the findings that happened to be written before something threw
would under-report a review that really finished, and nothing downstream could
tell. A lost answer stays `reviewing`, and `interrupted` marks a round
that demonstrably went out and vanished; neither authorises an automatic repeat,
because a non-idempotent call needs positive evidence that dispatching again
repeats nothing, and neither state supplies it. A malformed verdict, an
oversized finding list, a provider refusal or credential-shaped reviewer prose
all leave the round unresolved with its reason recorded — never `completed`.

`codeReview:reconcile` is how a round that went out and lost its answer is
settled, and it is read-only by contract: `roundStatus` never starts a review.
It distinguishes four outcomes, and the distinctions are the point. `completed`
applies the result, but only after both the locator and the subject attestation
match. `running` leaves the round exactly where it was, since a second dispatch
would certainly double a call still in flight. `not_started` is the one answer
that releases the round, because it is positive evidence that nothing was
consumed — and it closes the round rather than re-dispatching, since recovery
reads and a person decides what happens next. `unknown` changes nothing and
records a bounded, redacted reason: no answer is not evidence that no review
ran, and treating it as such is precisely how a non-idempotent call gets made
twice.

A finding keeps its stable identity and history across rounds, while
`code_review_finding_occurrences` keeps what each individual round said about it
— severity, gating, fix, provider and role. The two genuinely diverge: a later
round can re-raise the same defect without gating it, or suggest a different
remedy, and folding that into the stable row would rewrite what an earlier round
said.

Deduplication is equality, never similarity. The fingerprint covers provider,
role, category, severity, file, line and normalised title and body, scoped to
the subject hash; case and whitespace are normalised because rewrapping a line
is not a different defect, and nothing else is. That direction is deliberate:
merging two distinct defects hides one for good, while failing to merge a repeat
costs one extra line to read. A materially rewritten finding is a new record,
because it says something the previous one did not and inheriting its decision
would answer a question nobody asked.

Decisions are `accept`, `reject` or `resolved` — the third is distinct because
"legitimate and will be addressed" and "no longer applies" are different facts,
and collapsing them loses the difference between an outstanding commitment and
finished work. Every decision stores a reason, actor, source, timestamp and the
finding revision it was taken against. Two guards apply: the finding must belong
to the task's current subject, so an answer written against older code is never
carried forward onto newer code the operator was not shown; and the write is
conditional on the finding revision, so a stale screen cannot overwrite a newer
answer. Reviewer prose is data throughout — stored, hashed and shown, never
interpreted as an instruction.

`codeReview:get` presents findings as **live** only while the subject is
provably `current`. Under `stale`, `unknown` or `incomplete` the live list is
empty and everything remains visible under `historicalFindings`, because a
finding about code the task no longer has — or code nobody could read — is not a
live statement about anything, and presenting it as one is how a stale review
comes to be acted on. Nothing is ever deleted.

The operational IPC surface is `codeReview:get`, `codeReview:capture`,
`codeReview:reconcile` and `codeReview:decide`, all `.strict()`. They accept identifiers, a revision and a
typed decision, and refuse an executable path, repository or worktree path, base
ref, raw diff, scope text, prompt or provider configuration. The scope a
reviewer would be given is built in the main process from durable state. There
is deliberately no `codeReview:review` channel yet: a channel that existed and
always failed would be a worse answer than one that does not exist.

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
* The Zod schema that validates the response is projected to JSON Schema via
  `z.toJSONSchema()` and passed as `outputSchema`, so the model is constrained on
  the way out and checked on the way in. **What the model is given is a strict
  contract.** OpenAI structured outputs reject an object schema whose `required`
  does not list every key of `properties`, so the specification's model-facing
  schema (`taskSpecificationResponseSchema`) has no optional field:
  `scopedFilePaths` is required and the prompt tells the model to return `[]`
  when it has no confident scope, never to omit it.
* **How Agent Relay reads a specification is a separate schema**
  (`taskSpecificationSchema`): the same fields, except that a missing
  `scopedFilePaths` — a specification stored before the field existed — reads as
  `[]`. Every consumer of a stored specification uses the reading schema; only
  `taskSpecificationJsonSchema()` uses the strict one. Both share one field
  definition, and no behaviour depends on how Zod would emit a default into JSON
  Schema.
* `specificationIdentity` hashes the specification **as stored**: a key the
  stored JSON lacked — today, the reader's `[]` for a missing
  `scopedFilePaths` — is not added to the canonical text. The
  hash is persisted with plan-review gates and compared for equality, so
  normalizing a legacy row must not make its gate obsolete. An explicitly stored
  `[]` hashes as it always did.
* A structural test walks every Codex model-facing schema (specification,
  review, triage, implementation report) at every object level and fails when a
  property is not required or `additionalProperties` is not `false`, so a future
  optional field cannot reach the API unnoticed.
* **The failure a user sees is the provider's, not the process's.** A failed turn
  yields a structured `error` / `turn.failed` event (its `message` is often a
  JSON document with the API's `code`, `type`, `param` and HTTP status) and, once
  stdout ends, an SDK throw `Codex Exec exited with code N: <all stderr>`. The
  structured event is the primary error (`Codex failed: [invalid_json_schema] …
  (param …, HTTP 400)`), bounded, redacted and with the home directory replaced
  by `~`. Stderr is diagnostics: it is stored as a bounded, redacted `stderr`
  run event (best-effort, recorded after the error is built, so a failing event
  store cannot replace the cause), and the raw `error` events stay in the log.
  With no structured event (stderr-only failure, spawn error, stream ending
  early) the earlier fallback — `Codex failed: ` plus the first 500 redacted
  characters — applies. Authentication is classified from the provider's status
  and code only, never from free-text stderr. A stop or timeout still outranks
  either.

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
* The session id is persisted from the first envelope that carries it, before
  the process finishes. Max-turn exhaustion is detected before generic process
  failure and points the retry at that preserved session. Authentication is
  inferred only from stderr before any session was established; protocol stdout
  may contain arbitrary repository text and is never authentication evidence.
* Before implementation and verification, the composition root's worktree
  dependency preparer may reuse the registered checkout's existing
  `node_modules`. It creates only an ignored local link, only while package and
  lock manifests match, and never runs a package manager or reaches the network.
  Existing worktree-owned dependencies are left alone; missing or incompatible
  dependencies fail with an actionable message before an agent starts.

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

## 6b. Ornith — the local-inference implementation provider

Ornith is routed exactly like the Claude/Codex branches in
`Orchestrator.runImplementation`, with an exhaustive switch on
`task.implementationProvider` — there is no default branch, so an unhandled
provider fails to compile rather than silently falling back to Claude. It
reuses the existing relay-loop invariants unchanged: isolated worktree,
round budget, one-run-per-task exclusion, startup reconciliation, and the
post-provider `WorktreeVerification` snapshot gate before `READY_FOR_REVIEW`.

**Preflight, before anything durable.** `Orchestrator.acquireOrnithLeaseIfNeeded`
runs before the task moves to `IMPLEMENTING`, before a round is consumed, and
before a run row exists — it acquires the application-wide
`OrnithInferenceLeaseService` lease (implemented by the same
`LocalInferenceService` instance the Local inference lifecycle IPC handlers
use) and performs one bounded `health()` check against the already-retained
provider. `recheckOrnithLeaseIfNeeded` re-confirms it immediately before the
run is recorded, covering the time worktree creation may have taken. Neither
call, nor anything downstream, ever calls `start()`.

**The loop** (`src/main/services/ornith-implementation.ts`) builds one
complete, stateless chat-completion request per turn — the full approved
specification, any accepted plan-review addenda, the bound rule evidence,
fixed protocol instructions, a rolling window of prior bounded tool results,
and remaining-budget counters — dispatches it through
`OrnithInferenceLeaseService.inferForOrnith`, and parses the single JSON
action in the reply with `parseOrnithCompletion`
(`src/shared/domain/ornith.ts`). Every completion's `providerId`/`modelId`/
`runtimeInstanceId` must match the identity the lease established; a
mismatch — from a Settings change, a runtime replacement, or a race with
`localInference:stop` — ends the round rather than continuing against a
different runtime. Non-terminal actions are executed by
`OrnithWorktreeTools` (`src/main/services/ornith-worktree-tools.ts`, detailed
in `docs/security.md` §5c); `finish` and `blocked` end the loop;
`run_verification` dispatches to the same `WorktreeVerification` executor
used elsewhere, but only as diagnostic evidence folded into the loop's own
assessment — the authoritative gate remains Agent Relay's own post-provider
snapshot verification, run exactly as it is for Claude and Codex.

The same output-handling rule covers both: the command's own stdout/stderr is
never streamed as a progress event, in either path — only a fixed,
Relay-authored line before and after it runs — and only the bounded, sanitized
summary a completed run produces is ever persisted, broadcast live, or shown.
See docs/security.md §5c ("Verification output is sanitized...") for the exact
boundary between the raw buffer, the safe summary, and generic progress.

**What a verification attempt is.** Dispatching the action and the command
passing are different facts, and the record keeps them apart
(`src/shared/domain/ornith-verification.ts`). The executor returns raw facts
(exit code, timeout, cancellation, duration, output); `classifyVerificationExecution`
turns them into one outcome — `passed`, `failed`, `timed_out`, `cancelled`, or
`not_run` for an attempt Relay refused to start — with the command, exit code,
duration, an explicit reason and a bounded, sanitized output summary. The
`run_verification` event's `ok` is the *command's* result and `dispatched` says
the action ran; a failing command is never `ok: true`. The run's
`structuredResult.counters.verificationAttempts` holds up to six attempts, and
`ornithAudit.worktreeChangedFiles` is a final `git status` count of what the
worktree holds however it got there, so a later round that changed nothing does
not make an earlier round's unverified edits look gone. When that count could
not be established (Git failed or timed out), it is unknown rather than zero: the
latest count an earlier round recorded stands. The assessment's
`verificationStatus` follows the latest attempt that actually *ran* (a later
refusal cannot hide a failure) and never becomes `passed` from a diagnostic run.

**Verification is deadline-aware.** The loop keeps
`verificationFinishReserveMs` (2 minutes) of its overall budget for recording the
result, returning it to the model, `finish` and cleanup; a verification's own
budget is the time remaining minus that reserve, and it is stopped at it (as
`timed_out`, with that reason) rather than left to be cut off by the deadline. It
is not started at all when that budget is under `minVerificationBudgetMs` (3
minutes) or the last attempt's duration — a command that already took nine
minutes is not begun with five to spare. A repeat is refused when the worktree
fingerprint (the `git diff HEAD` plus each untracked file's content, hashed;
unknown — and so allowed — beyond 200 files or 16 MiB) is the one the last
verification ran against, so an unchanged diff cannot buy the same answer twice —
including after an edit and its exact reversal. At most `maxVerificationRefusals`
(2) refusals are made per run: the earlier ones are fed back to the model as
recoverable, saying how many more will end the run, and the last one ends it. They
are recorded as `not_run` and never as a verdict.

**Scope, once named, is confirmed before it is widened.** When the
specification names files and the manifest confirms them, a repository-wide
`search_text` (no `files`, or files outside the list) is refused
(`scope_expansion_refused`, not dispatched, no bytes charged) until a search of
ALL the named files came up empty (empty in one of two says nothing about the
other); each such empty result earns exactly one wider search. A scan cut short by
the read budget reports no match count at all, so it never counts as "empty"; a
named file that cannot be searched by nature (binary, or above the 64 KiB
per-file search limit — this repository's larger docs) does not block the task,
since it could never come up non-empty. Refusals are bounded like verification's
(`maxScopeExpansionRefusals`, 2, the last ending the run). A task that names no
files, or whose named files the manifest does not confirm, is unaffected.

**Stop.** `workflow:stop` aborts the task's `AbortController`, which
`inferForOrnith` and every bounded tool/verification operation observe. The
independently callable `localInference:stop` additionally calls
`onIndependentStop` on the held lease, which aborts that same controller —
so stopping the runtime directly still closes the owning Ornith run
(cancelled status, released lease, reconciled task state) instead of leaving
it to discover the runtime is gone only on its next turn. Neither Stop path
starts or restarts anything.

**Persistence.** Migration 12 (`ornith-provider`) widens the `CHECK`
constraint on `tasks.implementation_provider` and `runs.agent` to accept
`ornith`, adds a `CHECK` that an `ornith` run's `run_type` is
`implementation` or `correction`, and widens `task_provider_changes`'
implementation-side columns the same way — all three tables are rebuilt
under their existing name (SQLite has no `ALTER TABLE ... ALTER CONSTRAINT`)
with every row copied across unchanged. `tasks.review_provider` keeps its
existing `claude`/`codex`-only constraint. Because `tasks` and `runs` have
many dependent tables, `openDatabase` defers `PRAGMA foreign_keys = ON`
until after migrations finish, so the `DROP TABLE` the rebuild requires
cannot trigger SQLite's implicit cascading delete through any of them; the
migration proves this with `PRAGMA foreign_key_check` before it returns, and
throws — rolling the whole migration back — if that check is not empty.

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

**A read that was overtaken is not evidence, and neither is a flag.** A list
read reports what it actually established — accepted, superseded, overtaken,
failed or timed out — and only `accepted` carries rows. It used to answer with a
boolean that, once superseded, fell back to a flag meaning *a complete list
existed at some point*; reconciliation read that as its own confirmation and
cleared a doubt on the strength of a read that had proved nothing. Each
reconciliation also carries a generation, so an older one cannot write its
verdict over a newer one's, nor report the newer one as finished.

**A read-back says what the registry holds, never who put it there.** After an
unknown update or delete, a read that merely *succeeded* is not settlement. The
target as it stood before the request is kept, and the completed read is compared
against both it and what was asked for, giving four different things to say: the
registry now matches the requested state, the registry is unchanged so the change
did not take effect, the registry holds neither, or there is no complete current
read and the outcome is still unknown. Only the first three release the block,
and the first is worded as what it is — a statement about the registry, not a
claim that this request is what applied it. Clearing the doubt on `read
succeeded` alone was how a mutation that never applied left the operator with no
notice at all, because the error notice was cleared along with it.

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

**Every call is waited for, and none is waited on for ever.** One helper does
it: it bounds the wait, applies the answer exactly once from whichever path
reaches it first, and tells that path whether the wait had already expired. Every
write (30s) and every read (10s) goes through it. This was not always true, and
the exception mattered: registration had no bound at all, so a bridge that never
answered left `Saving…` on screen, the draft stuck and no uncertain outcome to
recover from, for the life of the window. Reads had none either — an unanswered
list read meant `Loading targets…` with no retry, and an unanswered 500-row
search for a run meant a target blocked with its release never offered, the very
lock-up that search exists to prevent.

Expiry is this screen's patience running out and nothing else. The request is not
cancelled, it is never sent again, the target stays blocked, and a timeout is
never treated as an answer — least of all as evidence that anything reached a
terminal state. An answer that arrives after the caller has been handed an
uncertain outcome has nowhere to be returned to, so it is recorded where the
screen can still show it: a late refusal appears against its target whether or
not the editor happens to be open, and exactly once. An answer that arrives while
the confirming read is still running outranks that read, and is returned to the
caller rather than reported as an unknown outcome.

A confirming read may refresh the registry shown on screen while the mutation is
still outstanding, but it cannot publish a settlement for that mutation. The
state it sees can still be changed by the unanswered request, so calling the
change applied, unchanged or conflicting at that point would put a conclusion
beside the simultaneous warning that the request has not answered. Classification
waits until the request itself is over; a precise late answer outranks the read.

**One registry mutation at a time.** Registration, edit and removal are
serialised through a single synchronous claim. They are not independent of each
other: the registry holds one target per `(environment, name)`, so a create in
flight can decide an edit's outcome and neither request knows about the other.
Diagnostics are unaffected — they are per target and read-only.

The claim is held until the backend request has actually **answered**, not until
this renderer stops waiting for it. Releasing it on expiry looked reasonable and
was not: nothing cancels the request, so a timed-out registration is still on its
way to the registry, and an edit started on top of it is exactly the concurrent
pair the claim exists to prevent. The answer releases it — success, refusal or
transport failure alike — exactly once, and a ticket makes that safe: a late
answer may release only the claim it was itself given, never one a newer request
now holds. A confirming read does not release it either.

The cost is real and is the intended trade: while a request is outstanding, no
registry mutation can start anywhere. The target in doubt is blocked regardless;
this extends that to the registry for as long as a write it does not control may
still land. What it does not extend to is reading — a diagnostic on another
target is unaffected.

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

1971 deterministic tests in 82 files, plus two routine automated Electron
acceptance journey, none of which contact a model or remote service. A separate opt-in live
Electron suite contacts the configured reviewer and is excluded from
`npm run verify` so ordinary verification cannot consume provider quota.

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
| `adapters/stdio-mcp-client` | **The generic MCP boundary against a real fake-server process**: initialization, paginated exact-tool discovery, calls and refusal-as-data, stdout/stderr separation, message/content bounds, malformed protocol, unsuccessful exit, timeout and cancellation |
| `adapters/filesystem-rule-source` · `services/rule-evidence` | **Whole-file project and convention evidence**: fixed discovery, traversal/symlink refusal, omission and byte budgets, deterministic ordering and hashes, runtime schema agreement, plus exact revision and dirty-state behaviour through real Git repositories |
| `adapters/coai-plan-reviewer` · `services/plan-review-gate` | **Typed external plan gate**: fixed tool names, refusal/error separation, immutable task evidence, durable pre-call intent, decision completeness, secret-shaped input refusal, stale-plan invalidation and approval enforcement |
| `services/plan-review-configuration` · `domain/plan-review-ipc-contract` | **Saved integration boundary**: opt-in configuration, absolute shell-free process paths, no credential arguments, exact clean convention sources, and operational IPC with no executable, repository, prompt or rule-content fields |
| `renderer/plan-review-view` · `renderer/plan-review-settings` | **The external plan-review UI against a fake preload bridge**: task-only rule capture, no retroactive opt-in, reasoned finding resolution, no retry affordance for an unknown in-flight call, and fixed process arguments/convention files that remain editable one line at a time |
| `services/plan-auto-decide` · `services/plan-correction` · `db/plan-correction-repository` | **Auto decide and the correction loop through the real service, repositories and a real migrated SQLite database** with a fake external reviewer and Codex: one finding per request, round-identity pinning, concurrent merges, needs_user never applied, no overwrite of a durable decision, accepted findings revising the specification through an atomic compare-and-swap, one row/version/round per gate across retries and restarts, every stop condition, fail-closed approval and plain-resolve guards |
| `services/external-code-corrections` · `services/code-review` (Auto decide) | Code-review Auto decide through the existing durable decision lifecycle; accepted findings as correction requirements handed to the existing correction round; `resolved` only after a fresh completed round on newer code |
| `services/plan-correction-cancellation` · `services/task-operations` · `services/task-operations-wiring` | **Stop task against the loop, deterministically** (deferred promises and barriers, never timing): a stop during Codex revision, Coai resolve, Coai review, automatic triage and a single finding's Auto decide; the signal reaching each provider; a stop between Codex returning and the transaction, and immediately after it; the register being process-wide (a service built by one IPC call is stopped through the singleton orchestrator, on the real composition root too); refusal of a conflicting second operation; release on success, error, validation failure and cancellation |
| `renderer/plan-auto-decide` · `renderer/code-review-triage` | **Both review panels through their real buttons** against a fake preload bridge: Auto decide inside each Decision row, exact single-finding request, immediate placement, needs_user, progress and failure inside the finding, double clicks, bulk counts and partial failure, drafts and decided findings untouched, `Resolve and revise plan` versus plain resolve, loop progress and failure, requirements and the correction hand-off |
| `security/redaction-and-process` | Credential redaction, environment compartmentalisation, argv-not-shell execution |
| `domain/operations-targets` · `domain/operations-diagnostics` · `domain/operations-ipc-contract` | The target and probe contracts: what they refuse — an adapter outside the enum, a config version this build cannot read, a credential value, a statement anywhere a probe id belongs |
| `db/operations-repositories` | Migration 3 on a fresh database *and* on one that already has 1 and 2, CRUD, uniqueness, the `RESTRICT` audit policy, close/reopen on disk |
| `adapters/local-sqlite-probe` | **The probe against real SQLite files in a real child process**: read-only proven by hash, size, mtime and the absence of a `-wal`, truncation counts, timeout, cancellation, stdout/stderr separation |
| `services/operations-diagnostics` · `services/operations-startup-recovery` | The order of events around a probe, the one-at-a-time rule, redaction before persistence, and recovery of a diagnostic an abrupt exit left open |
| `renderer/operations-view` | **The Operations screen, driven through its real buttons and fields** against a fake preload bridge: reachability without a project, disabled Save, exact IPC payloads, no automatic runs, double clicks, late answers, and the absence of a false success |
| `renderer/operations-async` | **The screen's asynchronous state**: a failed load asked once and retried only on request, per-target history, answers arriving out of order, a stale list that must not undo a confirmed write, one action per target at a time, and a write whose outcome nobody knows |
| `renderer/operations-backend-state` | **What the screen knows about work it did not start**: a run the backend is executing, a bounded page that has scrolled past it, a claim held across the read meant to confirm it, and a first list response a write overtook |
| `renderer/operations-recovery` | **Recovery, and what must not depend on anything else**: Operations reachable through a development bootstrap that never finishes, a manual re-read held until every read it needs has answered, an unconfirmed registration resolved against the registry, a probe request that goes unanswered, and one deep search per run |
| `renderer/operations-evidence` | **What counts as evidence, what a wait means, and who may write**: a superseded list read, two overlapping recoveries, a list, a deep search and a registration that never answer, a late registration answer, a draft replaced while a create was in flight, a create racing an edit in one tick, an answer that beats its own read-back, a refusal arriving with the editor open, and what an unknown update or delete may be said to prove |
| `renderer/operations-outcomes` | **Which request an outcome belongs to, and what the screen says before it knows**: a matching row that predates the request, a draft and a normalised path that are the same path, a confirming read still in flight, a refresh that says it is working, a registry write that never answers, and coming back to the screen without running anything |
| `e2e/operations-electron` | **The built Electron application through its real renderer, preload, IPC, repositories and probe process**: an isolated profile, three synthetic targets, exactly five diagnostics, fixture immutability and no row-value disclosure, disabled/removal guards, invalid inputs, and persistence across restart |

The deterministic suites run before the build. The Electron journey runs after
it, through `npm run test:e2e`, so it always exercises the bundles produced by
the same `npm run verify` invocation rather than a stale development server.

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
