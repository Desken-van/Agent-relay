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
| Prompt beyond the context | 400 `invalid_request_error`, nothing truncated (a config without `fit_max_tokens`, as Strata's setup writes it; see below) |
| Not JSON | with a response format: 502 `structured_output_failed` |
| Breaks the schema (`limit: 999`, unknown action, extra or missing field, wrong version, duplicate key) | 502 `structured_output_failed` **only with `jsonschema` installed**; without it, a schema-breaking object is returned as 200 |
| Prose or a code fence around the JSON, two objects in one reply | with a response format: 200 with only the first object — the rest is dropped silently |
| Cancellation (client closes the connection) | generation stops at once (`cancel=True` in its log); idle within ~1 s; the next request is served |
| Client timeout | same as cancellation |
| Stop (SIGTERM to the server) | server and engine gone in 3–8 s; GPU memory back to its idle 1 MiB |

That 400 holds for the config measured, which has no `fit_max_tokens`. A config
with `"fit_max_tokens": true` (accepted by Agent Relay: it runs nothing and
touches no file) answers differently, read from Strata's code at the pinned
revision (`serve/server.py`, not measured live): a prompt that leaves no room
to answer is still a 400, but a prompt that fits while prompt plus
`max_tokens` does not is answered with the output cap lowered to the room
left, as a 200. The prompt is never truncated either way. Agent Relay then
gets a shorter answer: one that stops with `finish_reason: length` before a
complete action is refused as `limit_output_exceeded`, never run, and its
message names the output limit although the cause was the context.

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
| Prompt cache between turns | not reused (`cache_n: 0` on every turn); see [below](#with-free-ram-and-the-prompt-cache) | — |

A short cold prompt (~850 tokens) read at 36–57 tokens/s.

| While running | Strata Coder IQ1_M | Ornith 9B |
| --- | --- | --- |
| GPU memory | 11.5–11.7 GB of 12 | 5.8 GB |
| RAM of its own processes | up to 19.2 GB | — (about 1.7 GB less available) |
| Available RAM, lowest | 3.1–3.4 GB of 30 | ~16–19.5 GB |
| Swap in use, highest | 21–23 GB (other programs pushed out) | ~unchanged |
| Reads from the SSD | ~1 GB/s while answering (295 GB in 291 s) | the model load only |

The SSD reads are the low-RAM mode re-reading experts from the packed file. On
this machine, using it pushes most other programs into (zram) swap. These
figures were taken with other desktop programs holding ~21 GB of RAM; with
that RAM free, Strata is several times faster (next sections).

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

## Harder tasks, three models, hidden tests

Five tasks through the same production loop, two runs each, each judged
afterwards by hidden tests the model never saw (every hidden suite passes a
reference solution first). Besides Strata and Ornith 9B, Qwen3-Coder-30B-A3B
(`unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF` at `b17cb02`, UD-Q4_K_XL, 17.7 GB,
sha256 checked) ran on the same llama-server build as Ornith, with
`--n-cpu-moe 28` (the experts of 28 of its 48 layers in RAM) and otherwise the
Ornith profile's flags — an ordinary llama.cpp profile, no code needed.

| Task | Ornith 9B | Qwen3-Coder-30B-A3B | Strata Coder IQ1_M |
| --- | --- | --- | --- |
| `whisper`: edit a function and its test | 1/2 runs passed; hidden 3/3, 3/3 | 2/2; 3/3, 3/3 | 2/2; 3/3, 3/3 |
| `clamp`: create a module and its test | 0/2 (read a file not yet created); hidden 4/4, 4/4 | 2/2; 4/4, 4/4 | 2/2; 4/4, 4/4 |
| `bugfix`: 1-based pages, rounding, validation | 2/2; 8/8, 8/8 | 2/2; 8/8, 8/8 | 2/2; 8/8, 8/8 |
| `priority`: store + API + HTML view | 0/2 (repeated a read; finish refused); hidden 6/8, 5/8 | 0/2 (repeated a read; verification budget spent); hidden 8/8, 8/8 | 0/2 (finish refused); hidden 8/8, 8/8 |
| `csv`: RFC 4180 quoting | 0/2; hidden 0/1, 2/8 | 1/2; hidden 4/8, 7/8 | 2/2; 8/8, 8/8 |
| **Runs the loop accepted** | 3/10 | 7/10 | 8/10 |
| **Runs whose code passed every hidden test** | 6/10 | 8/10 | 10/10 |

| Per run (median of the runs above) | Ornith 9B | Qwen3-Coder-30B-A3B | Strata Coder IQ1_M |
| --- | --- | --- | --- |
| One turn | ~1–7 s | ~7.4 s | ~25–50 s |
| Writing the answer | ~52 tokens/s | ~40 tokens/s (45 with `--n-cpu-moe 22`) | 3–8 tokens/s |
| `bugfix` | 28 s | 62–85 s | 161–182 s |
| `priority` | 66–73 s | 505–719 s (many repeated turns) | 372–428 s |
| `csv` | 30–58 s | 166–182 s | 194–205 s |
| Start until ready | ~7 s | 13.5 s | 20–25 s |
| GPU memory | 5.8 GB | 9.6 GB (11.4 at `--n-cpu-moe 22`) | 11.7 GB |
| Lowest available RAM | ~16 GB | 11.9 GB | ~3 GB |

All four "finish refused" endings (two Strata, one Ornith on `priority`) were
the same Agent Relay rule: a finish summary that mentions a path starting with
a slash (here the route `/todos`) is refused as an absolute machine path, even
though the code was complete. It applies to every model alike. (Since fixed:
a route is no longer taken for a machine path, see
[security.md](security.md#5c-ornith-a-bounded-structured-only-implementation-provider).)

Ten runs per model on five small-to-medium tasks: enough to see a clear order
(Strata's code was right every time, Qwen3-Coder-30B-A3B close behind,
Ornith 9B least often), not enough to measure the size of the gaps.

## With free RAM and the prompt cache

The same five tasks, two runs each, measured again on 2026-10-09 in three
conditions: as above (other programs holding ~21 GB of RAM), with those
programs closed, and with them closed **and** Strata's prompt cache used.

The cache: every Ornith turn is a fresh prompt that starts with the same
specification, rule evidence and protocol, and Strata keeps no cache point
inside the one user message a turn sends, so it read the whole prompt again on
every turn. The adapter now marks where that repeated part ends
(`strata_prefix`, see [local-inference.md](local-inference.md#a-strata-runtime));
Strata pins a cache point there and later turns read only what follows. On
these tasks the repeated part was 2,768 of a turn's ~2,900–3,600 tokens.
(Strata's `strata_checkpoint: false` is not sent with it: the engine then
ignores the pin, measured.)

| | RAM held by other programs | RAM free | RAM free + prompt cache |
| --- | --- | --- | --- |
| One turn (median) | 25.2 s | 10.2 s | 9.0 s |
| Prompt tokens read per turn (median) | 3,050, in 14.8 s | 3,586, in 8.5 s | 818, in 6.0 s |
| Turns that reused a cached prefix | 0 of 20 measured | 0 of 71 | 66 of 71 (the misses: each task's first turn) |
| Writing the answer (median) | 12 tokens/s | 33 tokens/s | 34 tokens/s |
| `whisper` | 131–132 s | 66–67 s | 41–52 s |
| `clamp` | 87–94 s | 45–54 s | 23–31 s |
| `bugfix` | 161–182 s | 75 s | 59–61 s |
| `priority` | 372–428 s | 160–162 s | 143–147 s |
| `csv` | 194–205 s | 94–95 s | 72–81 s |
| All five tasks, both runs | ~33 min | ~15 min | ~12 min |
| Reads from the SSD | ~1 GB/s while answering | median 21 MB/s | median 1 MB/s |
| Highest swap in use | 21–23 GB | 9.2 GB | 8.8 GB |
| Lowest available RAM | ~3 GB | 2.8 GB | 2.3 GB |
| Runs the loop accepted | 8/10 | 8/10 | 8/10 |
| Runs whose code passed every hidden test | 10/10 | 10/10 | 10/10 |
| Replies that were not one action | 0 | 0 | 0 |

The answers did not change with speed: the same 10/10 hidden-test result, the
same turn counts within one or two, no malformed reply. The two refused runs in
each column are `priority` again, refused for `/todos` in the finish summary
(above). Strata takes whatever RAM is free for its expert cache (up to 23.8 GB
of its own here), so "lowest available RAM" stays low; what changed is that it
no longer pushes the rest of the machine into swap or reads the SSD
constantly. Measured against the first table, Strata on a machine with its RAM
free is now 2–3 times slower per task than Ornith 9B, not 8–15 times, and
faster than Qwen3-Coder-30B-A3B on `priority` and `csv`.

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
and its code was the most often right of the three models measured (10/10 runs
passed every hidden test, in each of the three conditions measured). Its speed
depends mostly on free RAM: with other programs holding most of it, a task took
8–15 times as long as with Ornith 9B; with that RAM free and the prompt cache
used, 2–3 times. It still takes nearly all of the GPU and whatever RAM is free,
and its output format rests on a prompt rather than a grammar (no reply broke
it in the 215 turns of those three series). Qwen3-Coder-30B-A3B on the existing llama.cpp
runtime remains the lighter alternative with a grammar-enforced format, slightly
less often right. Ornith stays the default; Strata is an explicit alternative
for when correctness matters more than time, run with the RAM-heavy programs
closed.
