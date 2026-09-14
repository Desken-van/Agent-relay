/**
 * A stand-in for a llama.cpp-compatible inference server.
 *
 * It exists because the interesting parts of `LlamaCppLocalInference` are the
 * parts a fake runner and a fake `fetch` cannot have: a real process that has to
 * actually die, a real descendant that has to die with it, a real socket that
 * can hang, a real body that can be cut short or arrive too large, and a real
 * argv as the operating system received it.
 *
 * Contract, deliberately narrow:
 *
 *  * It is a plain Node script, spawned with no shell, and it is never a real
 *    llama.cpp. It loads no model, downloads nothing, and contains no
 *    credential.
 *  * Its behaviour comes from `fake-local-inference-scenario.json` **in the
 *    working directory**, re-read on every request so a test can change the
 *    runtime's mind halfway through a run.
 *  * It records only safe evidence into `fake-local-inference-evidence.json` in
 *    the same directory: argv, its own pid, the pid of any descendant it
 *    spawned, and the method/path/body of each request. Environment variables
 *    are recorded by **name and presence only**, never by value.
 *  * It binds to 127.0.0.1 and nothing else.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SCENARIO_FILE = 'fake-local-inference-scenario.json';
const EVIDENCE_FILE = 'fake-local-inference-evidence.json';

/** Exit code used when the script was started outside its scenario directory. */
const NO_SCENARIO_EXIT = 93;
/** Ceiling on a recorded request body, so evidence can never be unbounded. */
const MAX_RECORDED_BODY = 256 * 1024;

const argv = process.argv.slice(2);
const cwd = process.cwd();

function readScenario(required) {
  try {
    return JSON.parse(readFileSync(join(cwd, SCENARIO_FILE), 'utf8'));
  } catch {
    if (!required) return null;
    process.stderr.write(`fake-local-inference: no ${SCENARIO_FILE} in ${cwd}\n`);
    process.exit(NO_SCENARIO_EXIT);
  }
}

/* -------------------------------------------------------------------------- */
/* Capability probe                                                            */
/* -------------------------------------------------------------------------- */

if (argv.includes('--version')) {
  // A real llama-server prints its banner and exits without binding anything.
  // That is the whole point of the capability probe: it proves a file runs, and
  // nothing whatsoever about inference.
  const probe = readScenario(false) ?? {};
  const line = probe.versionLine ?? 'version: 9999 (fake-local-inference)';
  const stream = probe.versionStream === 'stdout' ? process.stdout : process.stderr;
  stream.write(`${line}\n`);
  process.exit(typeof probe.versionExit === 'number' ? probe.versionExit : 0);
}

/* -------------------------------------------------------------------------- */
/* Server mode                                                                 */
/* -------------------------------------------------------------------------- */

const boot = readScenario(true);

function scenario() {
  return readScenario(false) ?? boot;
}

function argumentValue(name) {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null;
}

const port = Number(argumentValue('--port'));
if (!Number.isInteger(port) || port <= 0) {
  process.stderr.write('fake-local-inference: no usable --port in argv\n');
  process.exit(94);
}

const evidence = {
  pid: process.pid,
  cwd,
  argv,
  descendantPid: null,
  // Presence, never value. A real credential set on the machine running the
  // suite must not be able to reach a report, a snapshot or an assertion.
  envTokenShapedNames: Object.keys(process.env)
    .filter((name) => /(TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|CREDENTIAL|PRIVATE_KEY)/i.test(name))
    .sort(),
  requests: []
};

function recordEvidence() {
  writeFileSync(join(cwd, EVIDENCE_FILE), JSON.stringify(evidence, null, 2), 'utf8');
}

/**
 * A helper the runtime "spawned" and forgot about.
 *
 * It exits on its own account never — only a tree termination reaches it. That
 * is exactly what makes it evidence: if this pid is still alive after a stop, a
 * timeout or a cancellation, then the kill hit one process rather than a tree.
 *
 * With `descendantIgnoresTermination` it also refuses the polite signal, which
 * is the case that separates "the child exited" from "the tree is gone": the
 * parent goes quietly on SIGTERM while this one carries on, so a supervisor that
 * takes the parent's exit as proof leaves it running.
 */
if (boot.spawnDescendant === true) {
  const body =
    boot.descendantIgnoresTermination === true
      ? "process.on('SIGTERM', () => {}); process.on('SIGINT', () => {}); process.on('SIGHUP', () => {}); setInterval(() => {}, 1000);"
      : 'setInterval(() => {}, 1000);';
  const descendant = spawn(process.execPath, ['-e', body], {
    stdio: 'ignore',
    windowsHide: true,
    detached: process.platform === 'win32' && boot.detachedDescendant === true
  });
  descendant.unref();
  evidence.descendantPid = descendant.pid ?? null;
}

function noise(stream, bytes, character) {
  if (typeof bytes !== 'number' || bytes <= 0) return;
  // Written as lines so a line-oriented drain sees them the way a real server's
  // log would arrive, rather than as one enormous chunk. Each stream uses its
  // own character, so a test can prove the two never mixed.
  const line = `${character.repeat(199)}\n`;
  let written = 0;
  while (written < bytes) {
    stream.write(line);
    written += line.length;
  }
}

if (typeof boot.stderrSecret === 'string') {
  // A credential shape a real server might print by accident. It is not a real
  // credential, and the point is that it must not survive retention.
  process.stderr.write(`${boot.stderrSecret}\n`);
}

noise(process.stdout, boot.noisyStdoutBytes, 'o');
noise(process.stderr, boot.noisyStderrBytes, 'e');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function send(response, status, body, contentType = 'application/json') {
  response.writeHead(status, { 'content-type': contentType });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve) => {
    let text = '';
    request.on('data', (chunk) => {
      if (text.length < MAX_RECORDED_BODY) text += String(chunk);
    });
    request.on('end', () => resolve(text));
    request.on('error', () => resolve(text));
  });
}

function completionBody(current, completionIndex) {
  // `completionTextSequence`, when present, lets one scenario answer several
  // completion requests differently in order (e.g. Ornith's multi-turn tool
  // loop) — the fixture is already re-read per request, this just indexes
  // into it instead of requiring the test to rewrite the file mid-loop, which
  // it has no way to synchronize with a loop it does not step one turn at a
  // time. The last entry repeats once the sequence is exhausted.
  const sequence = Array.isArray(current.completionTextSequence) ? current.completionTextSequence : null;
  const text = sequence
    ? (sequence[Math.min(completionIndex, sequence.length - 1)] ?? 'Fake completion.')
    : (current.completionText ?? 'Fake completion.');
  const payload = {
    id: current.responseId ?? 'chatcmpl-fake-1',
    object: 'chat.completion',
    created: 1,
    model: 'fake-model',
    // A field llama.cpp adds and this contract must tolerate rather than refuse.
    timings: { predicted_ms: 1 },
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        ...(current.omitFinishReason === true
          ? {}
          : { finish_reason: current.finishReason ?? 'stop' })
      }
    ],
    ...(current.omitUsage === true
      ? {}
      : { usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } })
  };
  return JSON.stringify(payload);
}

async function handleHealth(current, response) {
  if (typeof current.healthDelayMs === 'number') await delay(current.healthDelayMs);

  switch (current.health) {
    case 'hang':
      // Never answers. Only a deadline ends this.
      return;
    case 'malformed':
      return send(response, 200, 'this is not json');
    case 'not_object':
      return send(response, 200, '"ok"');
    case 'non2xx':
      return send(response, 503, JSON.stringify({ status: 'loading model' }));
    case 'loading':
      return send(response, 200, JSON.stringify({ status: 'loading model' }));
    case 'huge':
      return send(response, 200, JSON.stringify({ status: 'ok', pad: 'p'.repeat(200_000) }));
    default:
      // Extra fields are legitimate; `status` is the only thing that decides.
      return send(response, 200, JSON.stringify({ status: 'ok', slots_idle: 1 }));
  }
}

async function handleCompletion(current, response, completionIndex) {
  if (typeof current.completionDelayMs === 'number') await delay(current.completionDelayMs);

  switch (current.completion) {
    case 'hang':
      return;
    case 'crash':
      // Dies mid-request, with the socket open and nothing written.
      recordEvidence();
      return process.exit(typeof current.crashExit === 'number' ? current.crashExit : 7);
    case 'malformed':
      return send(response, 200, '{"choices": [');
    case 'no_choices':
      return send(response, 200, JSON.stringify({ id: 'chatcmpl-fake-1', choices: [] }));
    case 'bad_usage':
      return send(
        response,
        200,
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: -3, completion_tokens: 1 }
        })
      );
    case 'non2xx':
      return send(response, 500, JSON.stringify({ error: 'fake failure' }));
    case 'huge_body':
      return send(
        response,
        200,
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          pad: 'p'.repeat(current.hugeBytes ?? 400_000)
        })
      );
    case 'huge_completion':
      return send(
        response,
        200,
        JSON.stringify({
          choices: [
            {
              message: { role: 'assistant', content: 'c'.repeat(current.hugeBytes ?? 40_000) },
              finish_reason: 'stop'
            }
          ]
        })
      );
    default:
      return send(response, 200, completionBody(current, completionIndex));
  }
}

const server = createServer((request, response) => {
  const current = scenario();

  void (async () => {
    const body = request.method === 'POST' ? await readBody(request) : '';
    evidence.requests.push({
      method: request.method ?? '',
      path: request.url ?? '',
      body: body.slice(0, MAX_RECORDED_BODY)
    });
    recordEvidence();

    if (request.url === '/health') return handleHealth(current, response);
    if (request.url === '/v1/chat/completions') {
      const completionIndex = evidence.requests.filter((entry) => entry.path === '/v1/chat/completions').length - 1;
      return handleCompletion(current, response, completionIndex);
    }
    return send(response, 404, JSON.stringify({ error: 'not found' }));
  })();
});

recordEvidence();

if (typeof boot.startupExit === 'number') {
  // Dies before it ever listens: the "runtime failed to start" case.
  process.exit(boot.startupExit);
}

const startupDelayMs = typeof boot.startupDelayMs === 'number' ? boot.startupDelayMs : 0;
setTimeout(() => {
  server.listen(port, '127.0.0.1');
}, startupDelayMs);

// Nothing here exits on its own once it is listening. A stop, a timeout or a
// cancellation has to do the work, which is what the cleanup assertions check.
