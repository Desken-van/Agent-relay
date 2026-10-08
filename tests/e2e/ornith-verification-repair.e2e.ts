/**
 * A broken Ornith edit recovers through the ordinary repair step, in the real application.
 *
 * The live failure this reproduces: Ornith inserted a function twice, `node --test` could not load the test
 * file ("SyntaxError: Identifier 'whisper' has already been declared"), and Agent Relay classified that as
 * unknown — a diagnostic re-run, then a dead end — instead of a failure of the files. Here the model is the
 * repository-owned fake runtime, scripted to make exactly that mistake and then fix it, so the recovery is
 * reproducible whatever a real model happens to do. Everything else is real: the built application, its
 * renderer and IPC, the Run screen's primary action, `OrnithWorktreeTools` writing the worktree, and Relay's
 * own `npm run verify` running `node --test` on it.
 *
 * Proved: the failed verification is classified as the files' own with the located error kept; the one next
 * action is "Fix verification failures · Ornith"; the repair round's prompt carries that error and the file it
 * is in, never a machine path; the repair works on the SAME worktree (the earlier edit is kept, not reset);
 * Relay verifies again and the task reaches review; the original repository is untouched. Only the
 * specification is seeded in the database, as in `ornith-implementation.e2e.ts`: this suite must not depend
 * on a live Codex.
 *
 * It runs twice: with a llama.cpp profile, and with a Strata profile configured through the same Settings
 * screen against a fake Strata install (its `serve/server.py` is the fake runtime, started by Node in place of
 * Strata's Python; its engine prints a version; its model config names the model and context). The repair
 * path is the same; what the Strata run adds is that the runtime is Strata's, end to end.
 */

import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { _electron as electron, type ElectronApplication, type Locator, type Page } from 'playwright-core';
import { FakeLocalInferenceRuntime, freePort } from '../helpers/fake-local-inference';

const require = createRequire(import.meta.url);
const electronExecutable = require('electron') as string;
const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const builtMain = resolve(repositoryRoot, 'out/main/index.js');
const FAKE_LOCAL_INFERENCE_RUNTIME_PATH = resolve(import.meta.dirname, '..', 'fixtures', 'fake-local-inference-runtime.mjs');

const SHOUT = 'export function shout(text) {\n  return `${text.toUpperCase()}!`;\n}\n';
const WHISPER = '\nexport function whisper(text) {\n  return `${text.toLowerCase()}...`;\n}\n';
const TEST_FILE = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { shout, whisper } from '../src/strings.js';",
  '',
  "test('shout', () => {\n  assert.equal(shout('hi'), 'HI!');\n});",
  "test('whisper', () => {\n  assert.equal(whisper('HeLLo'), 'hello...');\n});",
  ''
].join('\n');

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' } });
}

function applicationEnvironment(profile: string): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  env.AGENT_RELAY_DATA_DIR = profile;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  delete env.AGENT_RELAY_DEVTOOLS;
  return env;
}

async function launch(profile: string, cwd: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    executablePath: electronExecutable,
    args: ['--disable-gpu', builtMain],
    cwd,
    env: applicationEnvironment(profile),
    timeout: 30_000
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  return { app, page };
}

function card(page: Page, title: string | RegExp): Locator {
  return page.locator('.card').filter({ has: page.locator('.card__title', { hasText: title }) }).first();
}

async function invokeIpc<T = unknown>(page: Page, channel: string, input: unknown): Promise<T> {
  const result = await page.evaluate(
    async ({ channel, input }) => (globalThis as any).agentRelay.invoke(channel, input),
    { channel, input }
  );
  if (!result.ok) throw new Error(`IPC ${channel} failed: ${JSON.stringify(result.error)}`);
  return result.data as T;
}

/** A tiny hand-rolled poll, avoiding a dependency on this file's Vitest `expect.poll` typings for boolean predicates. */
async function expect_(read: () => Promise<string | null>, predicate: (text: string | null) => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = await read();
    if (predicate(text)) return;
    if (Date.now() >= deadline) throw new Error(`Condition not met before timeout. Last text: ${text}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Fill a field and read it back until the value holds. The Settings form can re-render while it is being
 * filled (a selection change re-renders the profile editor), and a value typed in that instant is lost; the
 * Save button then stays disabled for a reason that has nothing to do with this suite.
 */
async function fillHeld(field: Locator, value: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await field.fill(value);
    await new Promise((r) => setTimeout(r, 100));
    if ((await field.inputValue()) === value) return;
  }
  throw new Error(`The field did not keep the value ${JSON.stringify(value)}.`);
}

type RuntimeKind = 'llama_cpp' | 'strata';

/** What a ready Strata server answers on /health for the fake model. */
const STRATA_READY = { status: 'ok', max_context: 32768, model: 'fake-model', images: false, api_key: false, loaded: true, service: 'strata' };

/** How the fake runtime answers /health for each runtime kind. */
const healthFor = (kind: RuntimeKind): Record<string, unknown> => (kind === 'strata' ? { healthBodies: [STRATA_READY] } : { health: 'ok' });

/** A fake Strata install in the fake runtime's own directory (its working directory and scenario home). */
function fakeStrataInstall(dir: string): { serverScript: string; engineConfig: string } {
  mkdirSync(join(dir, 'serve'), { recursive: true });
  mkdirSync(join(dir, 'engine'), { recursive: true });
  const serverScript = join(dir, 'serve', 'server.py');
  // Node runs a file of unknown extension as CommonJS: this "server.py" is the fake runtime.
  writeFileSync(serverScript, `import(${JSON.stringify(pathToFileURL(FAKE_LOCAL_INFERENCE_RUNTIME_PATH).href)});\n`);
  const engine = join(dir, 'engine', 'strata.mjs');
  writeFileSync(engine, '#!/usr/bin/env node\nprocess.stdout.write("strata 0.1.41 (fake)\\n");\n');
  chmodSync(engine, 0o755);
  const engineConfig = join(dir, 'strata-fake.json');
  writeFileSync(engineConfig, JSON.stringify({ exe: engine, args: ['--max-context', '32768'], model_name: 'fake-model' }));
  return { serverScript, engineConfig };
}

async function startLocalInference(page: Page, port: number, kind: RuntimeKind, runtimeDir: string): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click();
  const settingsCard = card(page, /^Local inference$/);
  await settingsCard.waitFor();
  await settingsCard.getByLabel(/^Enable local inference/).check();
  await settingsCard.getByLabel(/^Enable "Local model" for new task selection$/).check();
  await settingsCard.getByRole('button', { name: /Local model/ }).click();
  await settingsCard.getByText(/^Editing: Local model/).waitFor();
  const common: readonly [Locator, string][] = [
    [settingsCard.getByLabel(/^Model id/), 'fake-model'],
    [settingsCard.getByLabel(/^Port/), String(port)],
    // As in ornith-implementation.e2e.ts: room for the immutable prompt, plus the correction evidence.
    [settingsCard.getByLabel('Context size (tokens)'), '16384'],
    [settingsCard.getByLabel('Default max output tokens'), '1024']
  ];
  let fields: readonly [Locator, string][];
  if (kind === 'strata') {
    const install = fakeStrataInstall(runtimeDir);
    await settingsCard.getByRole('combobox', { name: 'Runtime', exact: true }).selectOption('strata');
    fields = [
      // Node stands in for the Python of Strata's own .venv.
      [settingsCard.getByLabel(/^Strata Python interpreter/), process.execPath],
      [settingsCard.getByLabel(/^Strata server script/), install.serverScript],
      [settingsCard.getByLabel(/^Strata model config/), install.engineConfig],
      [settingsCard.getByLabel(/^Strata model name/), 'fake-model'],
      ...common
    ];
  } else {
    await settingsCard.getByRole('combobox', { name: /^Executable/ }).selectOption('explicit_path');
    await settingsCard.getByRole('combobox', { name: /^Model source/ }).selectOption('runtime_id');
    fields = [
      [settingsCard.getByRole('textbox', { name: 'Executable path', exact: true }), FAKE_LOCAL_INFERENCE_RUNTIME_PATH],
      [settingsCard.getByLabel('Runtime model identifier'), 'fake-model'],
      ...common
    ];
  }
  for (const [field, value] of fields) await fillHeld(field, value);
  // All of them, once more, right before saving.
  for (const [field, value] of fields) if ((await field.inputValue()) !== value) await fillHeld(field, value);
  const save = page.getByRole('button', { name: 'Save settings' });
  await expect_(async () => String(await save.isEnabled()), (enabled) => enabled === 'true');
  await save.click();
  await page.getByText('Settings saved').waitFor();
  const lifecycle = card(page, 'Local inference lifecycle');
  // The runtime is named for what it is wherever the profile is offered.
  if (kind === 'strata') await expect_(async () => lifecycle.textContent(), (text) => (text ?? '').includes('Local model · Strata'));
  await lifecycle.getByRole('combobox', { name: /^Active profile/ }).selectOption('default');
  await lifecycle.getByRole('button', { name: 'Check capabilities' }).click();
  await expect_(async () => lifecycle.textContent(), (text) => (text ?? '').includes('Executable available: yes'));
  await lifecycle.getByRole('button', { name: /Start runtime/ }).click();
  await expect_(async () => lifecycle.textContent(), (text) => /Current state\s*Healthy/.test(text ?? ''));
}

interface VerificationRecord {
  readonly passed: boolean;
  readonly failureKind?: string;
  readonly outputSummary?: string;
  readonly reason: string | null;
}

function verificationRecords(profile: string, taskId: string): VerificationRecord[] {
  const db = new DatabaseSync(join(profile, 'agent-relay.sqlite'), { readOnly: true });
  try {
    return (db.prepare("SELECT structured_result FROM runs WHERE task_id = ? AND run_type = 'verification' ORDER BY started_at ASC")
      .all(taskId) as { structured_result: string }[]).map((row) => JSON.parse(row.structured_result) as VerificationRecord);
  } finally {
    db.close();
  }
}

describe.each(['llama_cpp', 'strata'] as const)('Ornith verification repair Electron acceptance (%s runtime)', (kind) => {
  it('turns a node:test failure of Ornith\'s edit into one repair round over the same worktree, then review', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'agent-relay-ornith-repair-e2e-'));
    const repoDir = mkdtempSync(join(tmpdir(), 'agent-relay-ornith-repair-e2e-repo-'));
    const runtime = new FakeLocalInferenceRuntime().scenario(healthFor(kind));
    const port = await freePort();

    git(repoDir, ['init', '-b', 'main']);
    git(repoDir, ['config', 'user.name', 'Ornith Repair Fixture']);
    git(repoDir, ['config', 'user.email', 'fixture@example.invalid']);
    // The scripted edits carry hashes of LF content, so this repository pins LF before anything is checked
    // out: a host's core.autocrlf (the Windows default) would otherwise give the task worktree CRLF files
    // whose hashes the script cannot know. Repository-local, so worktrees Agent Relay adds from it inherit it.
    // CRLF handling is covered by the unit tests, which write their files with known line endings.
    git(repoDir, ['config', 'core.autocrlf', 'false']);
    mkdirSync(join(repoDir, 'src'));
    mkdirSync(join(repoDir, 'test'));
    writeFileSync(join(repoDir, 'package.json'), `${JSON.stringify({ name: 'repair-fixture', version: '1.0.0', type: 'module', scripts: { verify: 'node --test' } }, null, 2)}\n`);
    writeFileSync(join(repoDir, '.gitignore'), 'node_modules/\n');
    writeFileSync(join(repoDir, 'src', 'strings.js'), SHOUT);
    writeFileSync(join(repoDir, 'test', 'strings.test.js'), TEST_FILE);
    git(repoDir, ['add', '.']);
    git(repoDir, ['commit', '-m', 'initial commit']);
    mkdirSync(join(repoDir, 'node_modules'));
    const baseCommit = git(repoDir, ['rev-parse', 'HEAD']).trim();
    const originalLog = git(repoDir, ['log', '--oneline']).trim();

    // Round 1 inserts whisper twice (the live mistake); the repair round removes the second copy. Relay
    // releases the local runtime before its verification, so the repair round starts a NEW runtime process,
    // whose scripted answers start from the first again: each round gets its own sequence.
    const duplicated = `${SHOUT}${WHISPER}${WHISPER}`;
    runtime.scenario({
      ...healthFor(kind),
      completionTextSequence: [
        JSON.stringify({ version: 1, action: 'read_file', path: 'src/strings.js', offset: 0, limit: 4096 }),
        JSON.stringify({ version: 1, action: 'replace_text', path: 'src/strings.js', sha256: sha256(SHOUT), replacements: [{ oldText: SHOUT, newText: duplicated }] }),
        JSON.stringify({ version: 1, action: 'finish', summary: 'Added whisper.' })
      ]
    });

    let running: ElectronApplication | null = null;
    try {
      const { app, page } = await launch(profile, runtime.path);
      running = app;
      await startLocalInference(page, port, kind, runtime.path);

      const project = await invokeIpc<{ id: string }>(page, 'projects:addExisting', { localPath: repoDir, name: 'Repair Project', defaultBranch: 'main' });
      const taskTitle = 'Add a whisper function';
      const task = await invokeIpc<{ id: string }>(page, 'tasks:create', {
        projectId: project.id,
        title: taskTitle,
        originalRequest: 'Add whisper(text) to src/strings.js; the test already expects it.',
        implementationProvider: 'ornith'
      });
      const specification = {
        title: taskTitle,
        summary: 'Add an exported whisper(text) to src/strings.js returning the text lower-cased followed by "...".',
        assumptions: [],
        acceptanceCriteria: ['src/strings.js exports whisper(text).', 'npm run verify passes.'],
        constraints: ['Change only src/strings.js.'],
        suggestedTests: [],
        implementationPrompt: 'Read src/strings.js, add and export whisper(text) after shout, then finish.',
        scopedFilePaths: ['src/strings.js']
      };
      {
        const db = new DatabaseSync(join(profile, 'agent-relay.sqlite'));
        try {
          const now = new Date().toISOString();
          const grounding = {
            version: 1, checkout: 'base_commit', baseBranch: 'main', branch: null, commit: baseCommit,
            clean: true, implementationProvider: 'ornith', capturedAt: now, stale: null
          };
          db.prepare('UPDATE tasks SET status = ?, specification_json = ?, specification_approved_at = ?, specification_grounding_json = ?, updated_at = ? WHERE id = ?')
            .run('READY_FOR_IMPLEMENTATION', JSON.stringify(specification), now, JSON.stringify(grounding), now, task.id);
        } finally {
          db.close();
        }
      }
      const readTask = async () => (await invokeIpc<{ task: { status: string; currentRound: number; worktreePath: string | null; lastError: string | null } }>(page, 'tasks:get', { taskId: task.id })).task;

      // The Run screen of this task, and its one primary action.
      await page.getByRole('button', { name: 'Projects' }).click();
      await page.getByRole('button', { name: /Repair Project/ }).dblclick();
      await page.getByRole('button', { name: new RegExp(taskTitle) }).dblclick();
      await page.locator('button.rail__item').filter({ hasText: 'Run' }).click();
      const primary = page.locator('button.btn--recommended').first();
      /**
       * The primary action as the operator meets it, and the state that decides whether it can be pressed. The
       * label alone proves nothing: task events bring the next action's label while the request that led to it
       * is still finishing (its spinner and pending flag are still on — the action keeps the same key), and the
       * Ornith action also waits for the local runtime to be Healthy or released for Relay's own verification.
       */
      const primaryState = async (): Promise<string> => JSON.stringify(await page.evaluate(async () => {
        // This file is checked without DOM typings; the page's own `document`, as `invokeIpc` reaches `agentRelay`.
        const button = (globalThis as any).document.querySelector('button.btn--recommended') as {
          readonly textContent: string | null;
          readonly disabled: boolean;
          getAttribute(name: string): string | null;
          querySelector(selector: string): unknown;
        } | null;
        const runtime = await (globalThis as any).agentRelay.invoke('localInference:getState', {});
        return {
          label: button?.textContent?.trim() ?? null,
          enabled: button !== null && !button.disabled,
          pending: button?.querySelector('.spinner') !== null,
          disabledReason: button?.getAttribute('title') ?? null,
          runtime: runtime.ok ? runtime.data : null
        };
      }));
      const untilAvailable = (label: RegExp, timeoutMs: number): Promise<void> => expect_(primaryState, (text) => {
        const state = JSON.parse(text ?? '{}') as { label?: string | null; enabled?: boolean; pending?: boolean };
        return label.test(state.label ?? '') && state.enabled === true && state.pending === false;
      }, timeoutMs);

      /* Round 1: Ornith duplicates the function; Relay's node --test cannot load the test file. */
      await untilAvailable(/Run implementation · Ornith/, 15_000);
      await primary.click();
      await untilAvailable(/Fix verification failures · Ornith/, 90_000);
      const afterFirst = await readTask();
      expect(afterFirst.status).toBe('READY_FOR_IMPLEMENTATION');
      expect(afterFirst.lastError).toContain('a project file declares the same name twice');
      const worktree = afterFirst.worktreePath!;
      expect(readFileSync(join(worktree, 'src', 'strings.js'), 'utf8').match(/export function whisper/g)).toHaveLength(2);
      const failed = verificationRecords(profile, task.id).at(-1)!;
      expect(failed).toMatchObject({ passed: false, failureKind: 'implementation' });
      expect(failed.outputSummary).toContain("src/strings.js:");
      expect(failed.outputSummary).toContain("SyntaxError: Identifier 'whisper' has already been declared");
      expect(failed.outputSummary).not.toContain(worktree);
      // Pressable for the right reason: the runtime is the one Relay released for its own verification.
      expect(JSON.parse(await primaryState())).toMatchObject({ enabled: true, disabledReason: null, runtime: { kind: 'stopped', releasedForVerification: true } });
      expect(runtime.completionRequests()).toHaveLength(3);
      const firstRuntimePid = runtime.evidence().pid;

      /* The repair round: handed the located error, working on the same files. */
      runtime.scenario({
        ...healthFor(kind),
        completionTextSequence: [
          JSON.stringify({ version: 1, action: 'read_file', path: 'src/strings.js', offset: 0, limit: 4096 }),
          JSON.stringify({ version: 1, action: 'replace_text', path: 'src/strings.js', sha256: sha256(duplicated), replacements: [{ oldText: `${WHISPER}${WHISPER}`, newText: WHISPER }] }),
          JSON.stringify({ version: 1, action: 'finish', summary: 'Removed the duplicated whisper declaration.' })
        ]
      });
      await primary.click();
      await untilAvailable(/Run review/, 90_000);
      expect(runtime.evidence().pid).not.toBe(firstRuntimePid);
      const repairPrompt = runtime.completionRequests()[0]!.body;
      expect(repairPrompt).toContain('EVIDENCE FROM THE PREVIOUS ATTEMPT');
      expect(repairPrompt).toContain('a project file declares the same name twice');
      expect(repairPrompt).toContain("SyntaxError: Identifier 'whisper' has already been declared");
      expect(repairPrompt).toContain('src/strings.js:');
      expect(repairPrompt).not.toContain(worktree);
      expect(repairPrompt).not.toContain(repoDir);
      expect(runtime.completionRequests()).toHaveLength(3);

      const repaired = await readTask();
      expect(repaired.status).toBe('READY_FOR_REVIEW');
      expect(repaired.worktreePath).toBe(worktree);
      expect(repaired.currentRound).toBe(afterFirst.currentRound);
      expect(readFileSync(join(worktree, 'src', 'strings.js'), 'utf8')).toBe(`${SHOUT}${WHISPER}`);
      expect(verificationRecords(profile, task.id).at(-1)).toMatchObject({ passed: true });

      // The original repository: untouched, no commit, no remote.
      expect(git(repoDir, ['log', '--oneline']).trim()).toBe(originalLog);
      expect(readFileSync(join(repoDir, 'src', 'strings.js'), 'utf8')).toBe(SHOUT);
      expect(git(repoDir, ['remote']).trim()).toBe('');

      // Both Ornith rounds are recorded as runs of the runtime that actually served them.
      {
        const db = new DatabaseSync(join(profile, 'agent-relay.sqlite'), { readOnly: true });
        try {
          const served = (db.prepare("SELECT structured_result FROM runs WHERE task_id = ? AND agent = 'ornith' ORDER BY started_at ASC")
            .all(task.id) as { structured_result: string }[]).map((row) => (JSON.parse(row.structured_result) as { runtimeProviderId?: string }).runtimeProviderId);
          expect(served).toEqual(kind === 'strata' ? ['local-strata', 'local-strata'] : ['local-llama-cpp', 'local-llama-cpp']);
        } finally {
          db.close();
        }
      }

      await running.close();
      running = null;
    } finally {
      if (running) await running.close().catch(() => undefined);
      rmSync(profile, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
      await runtime.cleanup();
    }
  }, 240_000);
});
