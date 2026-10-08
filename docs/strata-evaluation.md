# Strata as a local runtime: evaluation (STRATA-1)

What was checked before and after a Strata runtime was added beside llama.cpp
(see [local-inference.md](local-inference.md#a-strata-runtime) for how to use
it). Every number here was measured on one machine, on the dates given, with the
versions given; none is carried over from Strata's own documentation.

## The machine and the versions

| | |
| --- | --- |
| Machine | CachyOS Linux, AMD Ryzen AI 9 HX 370, 30 GiB RAM (zram swap 30.5 GiB), NVMe SSD |
| GPU | NVIDIA RTX 3060 12 GB, driver 615.71.09, on PCIe 3.0 x4 (~4 GB/s) |
| Strata | [Niko1221/Strata](https://github.com/Niko1221/Strata) at `fb58e0dbc8399662c0e47c76578c6e878b14f6cf` (engine 0.1.41), not updated during the measurements |
| Model | Qwen3.8-Flash-Next Coder, IQ1_M (ISTA-DASLab GSQ-RCO-Coder GGUF), context 32768, KV int8, no vision |
| Memory mode | low-RAM (resident): the GPU holds ~30% of the 23 GB of experts, the rest is read from a packed copy on the SSD |
| Comparison | Ornith 1.5 9B Q4_K_M on llama.cpp b11471 (CUDA), context 32768, the profile Agent Relay already ships with |

Measured 2026-10-08/09.

## Installing it here

Strata's setup has no ready-made Linux engine for 0.1.41 (its releases carry
Windows builds only), so it compiles one, which needs the CUDA 13.0 toolkit.
Nothing was installed system-wide: the toolkit (13.0.2, nvcc 13.0.88, assembled
from the runfile's payload without its installer) and a GCC 14 host compiler
(conda-forge, through a standalone micromamba) were put in the experiment's own
folder, because the system's GCC 16 is newer than CUDA 13.0 accepts. Everything
sat outside this repository:

| What | Size |
| --- | --- |
| Model files (two GGUF shards) | 55 GB |
| Packed experts for the low-RAM mode | 25 GB |
| MTP draft layer | 6.5 GB |
| CUDA 13.0 toolkit (subset) | 2.3 GB |
| GCC 14 toolchain | 1.2 GB |
| Strata checkout and its `.venv` | ~0.3 GB |

Strata's `json_schema` check needs the Python package `jsonschema`, which its
setup does not install; it was added to its `.venv` (`jsonschema==4.25.1`).

## Compatibility

Checked against a live server on loopback, and the response-format checks also
deterministically through Strata's own HTTP server with its scripted mock
engine and Agent Relay's exact `ORNITH_ACTION_JSON_SCHEMA`.

| Contract | Result |
| --- | --- |
| `/health` | `status: "ok"`, `loaded`, `model`, `max_context`, `service` |
| Health is not readiness | `status: "ok"` is reported while `loaded` is false, so readiness needs `loaded: true` |
| `/v1/models`, `/props` | the loaded model only, with its context |
| A valid Ornith action | 200, `finish_reason: stop` |
| Reasoning | returned separately in `reasoning_content`, never in `content` |
| Truncated output (`max_tokens` too small) | with a response format: 502 `structured_output_failed`; without: 200 with `finish_reason: length` |
| Prompt beyond the context | 400 `invalid_request_error`, nothing truncated |
| Not JSON | with a response format: 502 `structured_output_failed` |
| Breaks the schema (`limit: 999`, unknown action, extra or missing field, wrong version, duplicate key) | 502 `structured_output_failed` **only with `jsonschema` installed**; without it, a schema-breaking object is returned as 200 |
| Prose or a code fence around the JSON, two objects in one reply | with a response format: 200 with only the first object — the rest is dropped silently |
| Cancellation (client closes the connection) | generation stops at once (`cancel=True` in its log); idle within ~1 s; the next request is served |
| Client timeout | same as cancellation |
| Stop (SIGTERM to the server) | server and engine gone in 3–8 s; GPU memory back to its idle 1 MiB |

Because a response format would hand Agent Relay's strict one-action parser a
cleaned-up completion, the adapter sends none. Without one, the Coder model
answered a real Ornith prompt with a sentence of prose instead of an action
(five attempts of five, reproduced over HTTP); with one fixed system message
stating the format and still no response format, it answered with exactly one
action on every one of the 30 turns measured since (24 over HTTP, 6 in the UI run).

## Speed and memory

Ornith-sized prompts (3.6–4.3 thousand tokens, the production loop's own):

| | Strata Coder IQ1_M | Ornith 9B |
| --- | --- | --- |
| Reading the prompt | 145–213 tokens/s | 1,300–1,400 tokens/s |
| Writing the answer | 3–8 tokens/s | ~52 tokens/s |
| One agent turn | 22–57 s | 0.7–7 s |
| Start until ready | 20–25 s | ~7 s |
| Stop | 3–8 s | < 1 s |
| Prompt cache between turns | not reused (`cache_n: 0` on every turn) | — |

A short cold prompt (~850 tokens) read at 36–57 tokens/s.

| While running | Strata Coder IQ1_M | Ornith 9B |
| --- | --- | --- |
| GPU memory | 11.5–11.7 GB of 12 | 5.8 GB |
| RAM of its own processes | up to 19.2 GB | — (about 1.7 GB less available) |
| Available RAM, lowest | 3.1–3.4 GB of 30 | ~16–19.5 GB |
| Swap in use, highest | 21–23 GB (other programs pushed out) | ~unchanged |
| Reads from the SSD | ~1 GB/s while answering (295 GB in 291 s) | the model load only |

The SSD reads are the low-RAM mode re-reading experts from the packed file. On
this machine, using it pushes most other programs into (zram) swap.

## The same small tasks, same loop

Agent Relay's production Ornith loop, a disposable repository each time, the
model's verification and Relay's tool budgets as shipped. Strata in the
adapter's mode (no response format, the format message); Ornith in its own
(llama.cpp `json_schema`, thinking off).

| Task | Strata Coder IQ1_M | Ornith 9B |
| --- | --- | --- |
| `whisper` (edit a file and its test) | 2/2 passed; 6 turns each; 220–226 s | 2/2 passed; 7 and 12 turns; 17 and 29 s |
| `whisper` with the real Codex specification and project rules | 2/2 passed; 7 turns each; 204–217 s | — |
| `clamp` (create a file and its test) | 2/2 passed; 5 turns each; 141–155 s | 1/2 passed: one failed after 3 turns (read a file it had not created yet, which ends the run); one passed in 5 turns, 12 s |

Strata took no wrong action in any of these runs. Ornith broke its own test
once (fixed in the loop, 12 turns) and once ended on a non-recoverable read.
These are six runs per model on small tasks: enough to see the speed, not to
rank the two on harder work.

## The real UI cycle

Disposable profile and repository, everything through the application's UI:
the Strata profile configured in Settings, restored after a restart without
starting anything, Codex specification (installed `/usr/bin/codex`, codex-cli
0.161.0, no path set), external plan review, approval, Strata implementation,
Relay's verification, Codex review, and publication with every confirmation
answered Cancel.

| Attempt | Outcome |
| --- | --- |
| 1 | Stopped at plan review: one finding needed a decision the test driver could not make yet. Quit with Strata running: stopped, nothing left behind. |
| 2 | **Failed** five times: the model answered with prose on turn 2 (`malformed_output`). Led to the format message above. |
| 3 | Passed: the finding accepted in the UI and the plan revised; Strata implemented the task in one round (181 s, 6 turns, 5 actions, 2 files); verification passed; Codex review approved ("all acceptance criteria are met"); all four publish confirmations cancelled, nothing committed or pushed. The review and publish steps ran after one application restart (the test driver misread a pending button). |

Recovery after a broken edit is covered reproducibly by
`tests/e2e/ornith-verification-repair.e2e.ts`, which runs once with a llama.cpp
profile and once with a Strata profile.

## Conclusion

Strata works behind Agent Relay as an owned runtime, its contracts can be held,
and on these small tasks its choices were cleaner than Ornith 9B's. On this
machine it is 8–15 times slower per task, takes nearly all of the GPU, most of
the RAM and a constant ~1 GB/s of SSD reads, and its output format rests on a
prompt rather than a grammar. Ornith stays the default; Strata is an explicit
alternative for a machine with more RAM (its docs put the Coder at 32 GB, the
full model at 48–64 GB), where it would not run in the low-RAM mode.
