# Local inference boundary

LOCAL-A adds an internal version-1 provider for one managed,
llama.cpp-compatible server. LOCAL-B1 persisted its operator configuration and
wired one long-lived lifecycle service into the main process. LOCAL-B2 adds an
opt-in `enabled` flag and request defaults to that persisted configuration, and
exposes both the configuration and the lifecycle service through a renderer
Settings section and lifecycle panel. LOCAL-B3 adds exactly one bounded manual
smoke-test action — a volatile prompt field and a "Run test inference" button —
on top of that same lifecycle panel, so an operator can send one real
completion request through the already-configured provider without leaving the
lifecycle boundary. It remains a foundation, not a workflow integration: Agent
Relay remains the sole owner of tasks, reviews, patches, retries, approvals,
and publication. The runtime loads a model and answers inference requests; it
owns none of that workflow state, and nothing in this boundary calls it
automatically — including the manual test action itself, which is never
dispatched except in direct response to that one button.

The lifecycle service is registered in the composition root and exposed through
the existing typed IPC/preload bridge. Configuration is saved through the
existing validated Settings update; the renderer never gains its own
filesystem-discovery or executable-picker channel. The contract name is
`agent-relay.local-inference`, and the only accepted contract version is `1`.
Versioned configuration, request, response, outcome, and persisted-settings
schemas reject unknown properties and versions.

## Runtime and model configuration

`Settings.localInference` is one strict version-1 object:

```json
{
  "version": 1,
  "enabled": false,
  "executable": { "kind": "discovered", "command": "llama-server" },
  "model": {
    "id": "local-model",
    "source": { "kind": "runtime_id", "runtimeModelId": "local-model" }
  },
  "fixedArguments": [],
  "port": 8080,
  "contextLimitTokens": 4096,
  "startupTimeoutMs": 600000,
  "healthTimeoutMs": 60000,
  "inferenceTimeoutMs": 1800000,
  "shutdownTimeoutMs": 60000,
  "requestDefaults": {
    "maxOutputTokens": 4096,
    "chatTemplateParameters": {}
  }
}
```

`enabled` defaults to `false`: a fresh install, and every upgraded legacy row,
opts in to nothing. While disabled, `getState`/`getCapabilities`/`start`/
`checkHealth` construct no provider, discover no executable, launch no process
and send no HTTP request — they return the existing state/capability DTO shapes
with a bounded, explicit disabled reason. `stop` remains passive. `requestDefaults`
carries the only two caller-adjustable defaults the existing request contract
has: `maxOutputTokens` (bounded by, and never exceeding, `contextLimitTokens`)
and `chatTemplateParameters` (the same flat, primitive-valued map described
below, defaulting to `{}` so generic llama.cpp behaviour is unchanged until an
operator configures it — an Ornith deployment might set
`{"enable_thinking": false, "preserve_thinking": false}`).

Migration 9 (`local-inference-settings`) inserts a fresh default row only when
the key is absent. Migration 11 (`local-inference-request-defaults`) is
forward-only and upgrades a pre-existing row: a row already in the current
shape is left untouched; a row in the legacy pre-B2 shape keeps every existing
executable/model/argument/port/context/timeout value and gains
`enabled: false` plus `requestDefaults` (`maxOutputTokens` set to
`min(4096, contextLimitTokens)`, `chatTemplateParameters` set to `{}`);
malformed or unrecognisable data falls back to the shipped default rather than
being carried forward broken, and unrelated Settings keys are untouched either
way. Provider id `local-llama-cpp`, working directory policy, token/byte
ceilings other than `requestDefaults`, and process policy remain trusted
application policy and are not persisted operator input.

The executable is either the fixed PATH-discovered command `llama-server` or an
explicit absolute path. A broken explicit path never falls back to PATH. A model
has a stable, safe id for requests and responses plus either an absolute local
path or a runtime-specific model identifier. Machine-local executable and model
paths are never response identities or lifecycle diagnostics.

The adapter copies and validates fixed argument entries at construction. It
rejects control characters, credential-shaped values, and flags that could
override the adapter-owned model, alias, host, port, or context size. It then
appends these entries in a deterministic order:

```text
--model <configured source>
--alias <stable model id>
--host 127.0.0.1
--port <configured port>
--ctx-size <configured context limit>
```

The process boundary receives an executable and an argv array with
`shell:false`; it never receives a command string. Prompt text, completion
limits, and chat-template parameters occur only in the HTTP request body.
Credential-shaped inherited environment variables are scrubbed. JavaScript
test fixtures are launched through the existing `launchFor` rule.

An executable that is a command shim or a script — `.cmd`, `.bat`, `.ps1`,
`.psm1`, `.vbs`, `.vbe`, `.wsf`, `.wsh`, `.sh` — is refused, whether it was
configured explicitly or returned by PATH discovery, and the refusal happens
before the version probe and before any launch. Such a file is not a program but
an instruction to an interpreter, and running one means running the shell this
application does not use. PATH discovery honours `PATHEXT`, so a
`llama-server.cmd` earlier on PATH than any real binary is an entirely ordinary
thing for the locator to return; `launchFor` rewrites only JavaScript entry
points, so nothing downstream would have caught it. A configured shim fails
configuration validation; a discovered one produces `unavailable`.

## Capability, health, and inference evidence

These are deliberately separate claims:

1. Discovery says the configured executable exists or `llama-server` was
   located.
2. A bounded `--version` probe says that file ran and returned a safe version
   identity.
3. Health says the started process returned a bounded 2xx JSON response from
   `GET /health` with `status` exactly `"ok"`.
4. Inference verification says one complete response was received and fully
   validated. Only this sets `inferenceVerified`.

Discovery, a version banner, an open port, and process log text never establish
health or successful inference.

## Lifecycle

The lifecycle IPC boundary contains exactly `localInference:getCapabilities`,
`localInference:start`, `localInference:getState`,
`localInference:checkHealth`, and `localInference:stop`. Each accepts only a
strict empty object. There is no command channel.

One additive operation, `localInference:runTestInference`, accepts a strict
`{prompt: string}` and nothing else — no request id, no message array, no
token or template override, no model/provider identity, no path, URL,
host/port, repository data, argv or command. Its response is the existing
version-1 `LocalInferenceOutcome`. The main process builds the request: the
current contract version, a generated request id, and exactly one
`{role: 'user', content: prompt}` message, with no request-level
`maxOutputTokens` or `chatTemplateParameters`, so the saved `requestDefaults`
already assembled into the bound configuration remain authoritative. It
delegates exactly once to the retained provider's existing `infer` method —
the same bounded, non-streaming, one-choice, loopback-only operation every
other caller of that method already gets, with the same prompt/request/
response/completion byte ceilings and inference timeout. A disabled or unbound
service constructs no provider and returns a bounded structured failure
without dispatching anything; an enabled provider still enforces its existing
Healthy-only transition, so a call while stopped, starting, inferring,
stopping, or in a terminal state is refused before any request is sent.

The service retains one provider, but deliberately does not put lifecycle calls
behind a promise queue. Overlapping calls reach that retained provider so a stop
can interrupt startup or join cleanup already in flight, and concurrent stops
share the same stop attempt. The provider owns the synchronization and process
identity checks that make those overlaps safe. A state read is synchronous and
passive. Changed Settings are not rebound while a provider is active or cleanup
is uncertain; the owning snapshot stays in use until an explicit stop returns
exactly `stopped`, after which the next operation binds the latest configuration.

Configuration is durable; lifecycle state is not. Every application launch
starts at `{ "kind": "stopped" }` (or the disabled `unavailable` DTO, when
`enabled` is false) and performs no discovery, version probe, launch, health
request, inference, retry, fallback, or automatic start.

### Renderer Settings and lifecycle panel

The Settings screen's "Local inference" card exposes every field above:
enabled state, executable discovery versus an explicit absolute path, model id
and source, one fixed argument per line (never shell-parsed), port, context
size, all four timeouts, the default max output tokens, and a raw JSON textarea
for the default chat-template parameter map. Fixed arguments and the
chat-template map are kept as raw text alongside the parsed draft so partially
typed content never jumps or disappears; a blank chat-template textarea is
normalised to `{}` rather than treated as an invalid-JSON failure. The complete
draft — including an untouched `localInference` — is submitted through the
existing `settings:update` channel; there is no separate local-inference
settings or discovery channel, and main-process validation is authoritative
regardless of what the form already checked.

A separate "Local inference lifecycle" card uses the six bounded IPC
operations above. Opening it calls `getState` and nothing else — no automatic
capability check, start, poll, retry, inference, or restart. It shows four
facts (What happened, Current state, Result, Next action) and renders exactly
one state-derived primary lifecycle button: capability checking while stopped
with no or unavailable evidence, Start once capabilities report available,
health checking while healthy, a passive `getState` refresh for
starting/inferring/stopping, and a disabled "cleanup required" label for
failed/cancelled/timed-out states (Stop is the only way out of those, never a
silent retry). The lifecycle button is disabled whenever local-inference edits
are unsaved or the saved configuration is disabled, in both cases with an
explanatory reason rather than being hidden. A synchronous shared claim
(checked before any request, not only via the disabled attribute) collapses a
burst of clicks into one IPC call and prevents the lifecycle button,
capability check, passive refresh, Stop, and test inference from dispatching
concurrently with one another. Stop remains a separate control for
starting/healthy/inferring/failed/cancelled/timed-out states, but the same
panel-wide claim disables and guards it while any panel action is unresolved;
while Stop is unresolved, it likewise blocks every other panel action. The
provider's backend cancellation and Stop synchronization remain intact for
defensive non-renderer races even though the renderer serializes its controls.

Below the lifecycle controls, the same card always renders a labelled prompt
textarea and a "Run test inference" button, in every state. Both stay visible
so the card layout does not shift depending on lifecycle state, but the
button — and the *validity* gate on the prompt — activate only once the saved
configuration is enabled, has no unsaved edits, the state is exactly
`healthy`, no panel action is pending, and the prompt is non-empty and within
the shared message-content bound; a concise reason is shown when it is not.
The textarea's own enabled/disabled state is deliberately independent of
prompt *content* — it stays enabled and editable through the same
enabled/saved/healthy/idle conditions regardless of whether the current text is
empty or too long, so an operator can always focus it to type a first prompt,
or edit an oversized paste back down, rather than being locked out by the very
validation that is supposed to guide them. One click sends exactly `{prompt}`
to `runTestInference` and nothing else — it never triggers a capability check,
Start, health check, retry, fallback, or restart. A completed outcome renders
four separate labelled values from the response DTO: Completion, Finish
reason, Duration (milliseconds), and Provider/model identity. Every typed
finish-reason variant is mapped to its own honest label, including `other`
(with its bounded reason text) and `unknown` — neither is ever presented as
`stop`. A failed, cancelled, or timed-out outcome, or a rejected/thrown IPC
call, renders an explicit "Failure reason" instead, using only the
outcome's own bounded/redacted `reason` or a defensively redacted, bounded
serialized error message; an untyped rejected bridge promise is reduced to a
fixed allowlisted transport-failure reason — never a raw response body, path,
argv, stack trace, or error `details` — and is never presented as a completion. The completion text
shown is exactly the string the adapter's `parseCompletion` already validated
and redacted; the renderer does not re-derive, re-validate, or bypass that
redaction, so a credential-shaped fake completion is shown as `[redacted]`.
The prompt and the rendered result live only in this component's own state —
never the global store, the Settings draft, localStorage, sessionStorage, task
history, run events, SQLite, or a console log — so unmounting the panel or
restarting the application leaves no trace of either.

One discriminated state model contains exactly:

```text
unavailable  starting  healthy  inferring  stopping
stopped      failed    cancelled timed_out
```

The transition table in `src/shared/domain/local-inference.ts` is the only
definition of the graph. In summary:

```text
unavailable | stopped | failed | cancelled | timed_out
                         -- explicit start --> starting

starting -- exact health --> healthy
starting -- error/cancel/deadline --> failed | cancelled | timed_out

healthy -- infer --> inferring -- valid completion --> healthy
                         |-- error/cancel/deadline --> failed | cancelled | timed_out

active or terminal -- explicit stop --> stopping --> stopped
stopped, or unavailable with no owned process -- stop --> unchanged
unavailable with an outstanding process -- stop --> stopping
```

An unexpected process exit from a healthy runtime becomes `failed`. Starting
while starting, healthy, inferring, or stopping; health checking outside
healthy; and inferring outside healthy throw `INVALID_TRANSITION` before a
process launch or HTTP request. A failed, cancelled, or timed-out provider never
restarts itself. Recovery always requires an explicit later `start()`.

One provider instance owns at most one process and allows at most one inference
at a time. Concurrent stop calls await the same cleanup. Repeated stop calls on
an already stopped provider do not launch, request, or kill anything again.

## Loopback protocol and bounded operations

The managed server binds only to `127.0.0.1` on the configured numeric port.
The adapter contacts only these endpoints:

- `GET /health`
- `POST /v1/chat/completions`

Inference is non-streaming and sends exactly one request with the stable model
id, validated `system`/`user`/`assistant` messages, `stream:false`, `n:1`, and a
bounded `max_tokens`. When supplied, the flat JSON-primitive
`chat_template_kwargs` map preserves values such as Ornith's
`enable_thinking:false` and `preserve_thinking:true` exactly.

The configured address is the whole address. Both requests are sent with
redirects refused, so a 3xx from whatever is listening on that port fails the
request instead of sending the next one somewhere the operator never named. The
refusal happens before that second request is put on the wire, which is the only
point at which it is worth anything — a prompt cannot be un-sent once another
server has read it.

Refusing a redirect is not evidence that nothing happened. The runtime already
received the POST, since it had to in order to answer 3xx, so the outcome
carries `dispatchOutcome: "unknown"` like every other post-dispatch ambiguity
and the request is never repeated anywhere.

Startup, each health request, inference, and shutdown have independent finite
budgets. During startup, each health probe uses the smaller of its own health
budget and the remaining overall startup budget. Cancellation uses
`AbortSignal`. Timeout and cancellation are reported only after process-tree
cleanup is observed; failure to confirm cleanup is reported as `failed` — and
that applies to the inference *outcome* as well as to the lifecycle state. A
cancelled or timed-out request whose runtime could not be confirmed gone is
returned as `failed`, because `cancelled` and `timed_out` say the operation is
over and an operation whose runtime may still be executing the prompt is not.
The `dispatchOutcome` is unaffected: still `unknown`, still never a licence to
send a second request.

"Cleanup confirmed" is a claim about the **tree**, not about the child. On
POSIX, the managed process leads its own process group, so the group is signalled
and then polled with signal 0 until it is empty; a descendant that ignored
`SIGTERM` while its parent exited politely is escalated to `SIGKILL` and waited
for, and a group that still has members when the budget expires is reported as
unconfirmed. On Windows, Agent Relay starts a native launcher first. The
launcher creates a Job Object with kill-on-close, creates the runtime suspended,
assigns it to that object, and only then resumes it. Descendants inherit the Job
Object, so the kernel retains the group even if the runtime parent crashes. The
launcher does not exit normally until it has terminated the remaining group and
observed the Job Object empty. Agent Relay requests an explicit stop by closing
a private control pipe; the launcher then terminates the Job Object, observes it
empty, and exits. If the launcher itself is terminated, closing its last Job
Object handle still terminates the contained processes. A reserved launcher
failure exit is not accepted as cleanup evidence: the provider retains ownership
and refuses another start when empty-job confirmation is unavailable.

Ownership of the process is continuous: it is handed from the current runtime to the outstanding one in the same synchronous step, and held across the wait for the cleanup. Nothing can observe the provider mid-handover, so an explicit `stop` that arrives while an automatic cleanup is still running finds that same process and joins the attempt already in flight rather than starting a second kill. It cannot answer `stopped` while the outcome is still unknown.

A cleanup that could not be confirmed does not release the runtime. The provider
keeps the process handle, and while it holds one, `start` is refused: `failed`
means the previous runtime *may still be alive*, and starting on top of it is how
two servers end up sharing one port. A later `stop` re-attempts that same
process rather than reporting success because the handle was dropped, and only a
confirmed cleanup clears the way for a new start. The parent exiting on its own
is not sufficient evidence either — its descendants are covered by the same
cleanup, and an unconfirmed one keeps the same hold.

Once the inference POST is initiated, timeout, cancellation, transport loss,
runtime crash, malformed JSON, and output overflow all have
`dispatchOutcome: "unknown"`. The runtime may have processed the prompt, so the
provider never retries the POST, changes models, or restarts automatically. A
definitive non-2xx response is `rejected`; validation before dispatch is
`not_dispatched`.

## Limits and retained data

Configuration supplies lower operational limits, and version 1 enforces these
hard maxima:

| Budget | Hard maximum |
|---|---:|
| Context tokens | 1,000,000 |
| Completion tokens | 1,000,000 and no greater than context |
| Prompt bytes | 4 MiB and no greater than request |
| Request bytes | 8 MiB |
| Raw response bytes | 8 MiB |
| Completion bytes | 4 MiB and no greater than response |
| Retained stdout bytes | 2 MiB |
| Retained stderr bytes | 2 MiB |
| Startup timeout | 10 minutes |
| Health timeout | 60 seconds |
| Inference timeout | 30 minutes |
| Shutdown timeout | 60 seconds |

stdout and stderr are continuously drained, redacted, retained separately as
bounded contiguous prefixes, and marked when bytes were omitted. They are never
parsed as health or inference data. Raw HTTP bodies, prompts, executable paths,
model paths, and argv are not retained in lifecycle diagnostics. A response
body or completion that exceeds its limit is discarded as a failure; partial
completion text is never returned as success.

Successful responses carry the original request id, contract version, stable
provider and model ids, a per-start runtime instance id, the bounded runtime
version established when that instance started, a bounded runtime response id
when present, duration, completion text, and a typed finish reason.

The runtime version belongs to the *instance*. A start requires one valid
bounded version identity, and that value is what every completed response from
that instance reports; a later `capabilities()` call runs a fresh `--version`
probe against the file on disk, and a failure there — an upgrade replacing the
file, a machine briefly out of handles — does not erase what the running process
already established. While an instance is running, `capabilities()` reports its
version rather than the probe's, because the process being described is the one
that is running. Missing usage is represented by `null` token counts. A missing finish
reason is `{kind:"unknown"}`; an unfamiliar bounded reason is an explicit
`other` value. Absence is never invented as zero or `stop`.

## Ornith: the implementation-provider integration built on this boundary

Ornith is a third, explicitly selected **implementation-only** task provider,
alongside Claude and Codex. It is not a separate runtime: selecting Ornith
reuses this exact `LocalInferenceService`/`LocalInferenceProvider` boundary —
same configuration, same lifecycle, same manual Start/Stop. Nothing about
choosing Ornith on a task starts, restarts, or health-checks the runtime; an
Ornith round refuses outright unless the runtime is *already* retained and
*already* `healthy`, confirmed by one bounded `health()` check immediately
before the round begins.

What Ornith adds, precisely:

- An application-wide **execution lease** (`OrnithInferenceLeaseService`,
  internal — never an IPC channel): at most one Ornith round may run at a
  time, and a second concurrent attempt (including while the Settings "Run
  test inference" smoke test could otherwise fire) is refused as `BUSY`
  rather than sharing or queueing behind the retained provider.
- A strict, versioned **action protocol** (`src/shared/domain/ornith.ts`):
  Ornith's only output is one JSON object naming one of a fixed set of
  repository operations (list/read/search files, create/replace/delete a
  file, `git status`/`git diff`, request verification, `finish`, or
  `blocked`). Nothing resembling a shell command, an argv, or a URL is ever
  an accepted field, and prose, Markdown fences, or trailing content make the
  whole completion a terminal failure — never something Agent Relay tries to
  repair or re-ask for.
- A bounded, Agent Relay-owned **tool executor**
  (`src/main/services/ornith-worktree-tools.ts`) that resolves every path
  against the real filesystem, refuses symlinks/reparse points/hard-linked
  write targets, hash-guards every edit and delete, and never executes
  anything the model wrote as a command — `git` is invoked only with a fixed,
  read-only or narrowly-scoped argv.
- A hard, non-negotiable limit set (`ORNITH_LIMITS`): turns, actions,
  rolling-context bytes, prompt/completion bytes, cumulative read/write
  bytes, changed-file count, verification calls, per-operation timeouts, and
  an overall loop deadline of `min(settings.processTimeoutMs, 30 minutes)`.
  None of this is renderer-configurable, and nothing a completion contains
  can widen any of it.
- The execution lease captures the retained runtime's exact context and output
  limits. Before a worktree or round is created, Relay reserves template and
  completion space and proves the immutable prompt fits using a conservative
  one-UTF-8-byte-per-token ceiling. Large read results are paged to the
  remaining prompt budget. An undersized context therefore produces a clear
  Settings remediation without dispatching inference or consuming a round.
- **No conversation is retained.** Every request is a complete, stateless
  chat-completion request: the full approved specification, any accepted
  plan-review addenda, and the bound rule evidence travel on *every* turn
  (Ornith keeps no server-side memory of earlier turns), and only the rolling
  log of prior tool results is pruned as the turn budget is spent. If the
  authoritative content alone cannot fit the prompt budget, the round refuses
  before any inference call is made rather than silently truncating it.
- Ornith never fabricates or persists a durable session/thread identifier —
  `Task.implementationThreadId` stays `null` for every Ornith run, by
  contract.

See `docs/architecture.md` for how this fits the relay loop and
`docs/security.md` for the full boundary/limit list. `docs/manual-test.md`
has the no-publish acceptance path using a real Ornith/llama.cpp model.

## Known limitations

- Outside the Ornith implementation-provider integration described above, the
  only other inference surface is the one manual, single-shot smoke-test
  button described earlier in this document. Neither surface starts,
  restarts, or health-checks the runtime automatically, and mounting the
  renderer, opening Settings, or checking state never dispatches an inference
  request on its own.
- There is no streaming, tool calling, embeddings, multimodal input, completion
  cache, Context Pack, repository indexing/RAG, patching, retries, fallback
  models, or workflow wiring. A non-completed test inference is never retried
  automatically.
- There is no model-specific tokenizer in the trusted host process. Ornith
  instead uses a deliberately conservative byte-to-token upper bound, so some
  prompts that a particular tokenizer could fit may require a larger configured
  context window.
- Runtime usage fields are optional and are returned as `null` when absent.
- One provider manages one process and one inference at a time; the manual
  test action and every Ornith task round share that same
  single-inference-at-a-time constraint, enforced by the Ornith execution
  lease described above — a second concurrent request is refused as `BUSY`,
  never queued.
- Lifecycle and inference evidence, including the manual test prompt and its
  result, are process-local and non-durable; only configuration persists.
- The Windows launcher is an Agent Relay-owned native executable built during
  `npm install` and copied beside the main-process bundle. If it is missing, a
  managed runtime launch fails before the target process starts; there is no
  fallback to uncontained execution.
- Deterministic LOCAL-B1/LOCAL-B2/LOCAL-B3 acceptance uses only the Agent
  Relay-owned fake runtime and a temporary profile/port. An operator reported
  that a real Ornith **lifecycle** run succeeded while bound and contacted on
  loopback (recorded 2026-09-12; run date, model, and version were not
  supplied and are not independently verified here). Real **inference**
  acceptance through this manual test action was not run and remains pending
  until this change merges — see `docs/manual-test.md`.
