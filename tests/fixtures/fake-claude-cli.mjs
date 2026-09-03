/**
 * A stand-in for the Claude Code CLI, for process-level contract tests.
 *
 * It exists because the interesting parts of `ClaudeCliAdapter` are the parts a
 * fake `ProcessRunner` cannot have: a real pipe that splits a JSON line across
 * two chunks, a stderr channel that must stay out of the protocol, a prompt that
 * only ever travels down stdin, an exit code, and a child that has to actually
 * die when the run is cancelled.
 *
 * Contract, deliberately narrow:
 *
 *  * It is a plain Node script. It is spawned as `node fake-claude-cli.mjs …`
 *    with no shell, and it starts nothing itself.
 *  * Its behaviour comes from `fake-claude-scenario.json` **in the working
 *    directory**. Nothing is read from the environment, the command line, or
 *    anywhere outside that directory — so a run that was started in the wrong
 *    place cannot accidentally pick up the right script.
 *  * It reads stdin to EOF, always, the way a CLI reading a prompt would. A run
 *    given no prompt therefore finishes quickly only because `run()` closes the
 *    child's stdin — which is exactly the contract worth testing.
 *  * It records how it was invoked into `fake-claude-invocation.json`, in the
 *    same directory. That file is the evidence for argv, stdin and cwd.
 *  * Environment variables are recorded by **name and presence only**. Values
 *    are never written, printed or returned, so a real credential that happens
 *    to be set on the machine running the suite cannot leak into a report, a
 *    snapshot or an assertion failure.
 *  * It contains no credential, and emits none.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SCENARIO_FILE = 'fake-claude-scenario.json';
const REPORT_FILE = 'fake-claude-invocation.json';

/** Exit code used when the script was started outside its scenario directory. */
const NO_SCENARIO_EXIT = 91;

/** Name shapes a scrubbed environment must not contain. Names only, never values. */
const TOKEN_SHAPED = /(TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|CREDENTIAL|PRIVATE_KEY)/i;

const argv = process.argv.slice(2);
const cwd = process.cwd();

function readScenario() {
  try {
    return JSON.parse(readFileSync(join(cwd, SCENARIO_FILE), 'utf8'));
  } catch {
    // Not an error to paper over: the scenario file is the proof that the child
    // was started in the working directory the adapter promised.
    process.stderr.write(`fake-claude: no ${SCENARIO_FILE} in ${cwd}\n`);
    process.exit(NO_SCENARIO_EXIT);
  }
}

const scenario = readScenario();

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function write(stream, text) {
  return new Promise((resolve) => {
    stream.write(text, resolve);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The session this run belongs to: the resumed one when asked to resume. */
function sessionIdFor() {
  const index = argv.indexOf('--resume');
  const resumed = index >= 0 ? argv[index + 1] : undefined;
  return resumed ?? scenario.sessionId ?? 'fake-session';
}

const sessionId = sessionIdFor();
const eol = scenario.eol === 'crlf' ? '\r\n' : '\n';

/** `{{sessionId}}` is the only substitution; scenarios stay literal otherwise. */
function expand(text) {
  return text.split('{{sessionId}}').join(sessionId);
}

// Read to EOF unconditionally. Nothing here works around a stdin that never
// closes; if one ever did, this is where the suite would hang and say so.
const stdin = await readStdin();

writeFileSync(
  join(cwd, REPORT_FILE),
  JSON.stringify(
    {
      pid: process.pid,
      cwd,
      // The arguments the tool itself received: whatever launched the script is
      // already consumed by the runtime.
      argv,
      stdin,
      stdinSha256: createHash('sha256').update(stdin, 'utf8').digest('hex'),
      stdinBytes: Buffer.byteLength(stdin, 'utf8'),
      // Presence, never value.
      envPresent: Object.fromEntries(
        (scenario.reportEnv ?? []).map((name) => [name, process.env[name] !== undefined])
      ),
      envTokenShapedNames: Object.keys(process.env).filter((name) => TOKEN_SHAPED.test(name)).sort()
    },
    null,
    2
  ),
  'utf8'
);

for (const action of scenario.actions ?? []) {
  if (typeof action.sleep === 'number') {
    await delay(action.sleep);
  } else if (typeof action.stdout === 'string') {
    // Written exactly as given, newline included or not: this is how a scenario
    // splits one JSON line over several chunks, or packs several into one.
    await write(process.stdout, expand(action.stdout));
  } else if (typeof action.stderr === 'string') {
    await write(process.stderr, expand(action.stderr));
  } else if (action.event !== undefined) {
    await write(process.stdout, `${expand(JSON.stringify(action.event))}${eol}`);
  }
}

if (scenario.hang === true) {
  // Stays alive until something kills it. Nothing here exits on its own, which
  // is the point: a timeout or a cancellation has to do the work.
  setInterval(() => {}, 1_000);
} else {
  process.exit(typeof scenario.exit === 'number' ? scenario.exit : 0);
}
