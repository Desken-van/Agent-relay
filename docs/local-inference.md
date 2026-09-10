# Local inference boundary

LOCAL-A adds an internal version-1 provider for one managed,
llama.cpp-compatible server. It is a foundation, not a workflow integration.
Agent Relay remains the sole owner of tasks, reviews, patches, retries,
approvals, and publication. The runtime loads a model and answers inference
requests; it owns none of that workflow state.

The provider is not registered in the composition root and is not exposed
through Settings, the database, IPC, preload, or the renderer. A trusted main
process caller must construct it with a validated configuration. The contract
name is `agent-relay.local-inference`, and the only accepted contract version is
`1`. Versioned configuration, request, response, and outcome schemas reject
unknown properties and versions.

## Runtime and model configuration

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
Object handle still terminates the contained processes.

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

## Known limitations

- There is no Settings or database persistence, IPC/preload API, or renderer UI.
- There is no streaming, tool calling, embeddings, multimodal input, completion
  cache, Context Pack, repository indexing/RAG, patching, or workflow wiring.
- Prompt bytes are bounded, but there is no tokenizer-based preflight prompt
  token count.
- Runtime usage fields are optional and are returned as `null` when absent.
- One provider manages one process and one inference at a time.
- The lifecycle and inference evidence are process-local and non-durable.
- The Windows launcher is an Agent Relay-owned native executable built during
  `npm install` and copied beside the main-process bundle. If it is missing, a
  managed runtime launch fails before the target process starts; there is no
  fallback to uncontained execution.
- Deterministic acceptance uses the Agent Relay-owned fake runtime. Running a
  real llama.cpp or Ornith build and model is outside LOCAL-A acceptance.
