/**
 * LOCAL-B2 + LOCAL-B3 as an automated Electron acceptance test.
 *
 * Launches the built application against a brand-new profile and the
 * repository-owned fake local-inference runtime (never a real llama.cpp, never
 * a real model). Drives the real renderer/preload/IPC/database/service/adapter
 * path: an invalid edit is rejected, a valid configuration is saved, the five
 * lifecycle operations run against the fake runtime, one manual test inference
 * completes and is rendered with redaction, a rejected and a timed-out
 * inference are each rendered as an explicit failure, a direct IPC call made
 * while the runtime is not Healthy is rejected before any request is sent, and
 * a restart proves settings persisted while the prompt, results, and process
 * traffic did not.
 *
 * The fake runtime fixture reads its scenario from its **working directory**.
 * Local-inference settings do not expose a working-directory override (LOCAL-B2
 * deliberately adds no such field), so this suite launches Electron itself with
 * `cwd` set to the scenario directory — the managed process a settings-driven
 * adapter spawns inherits that cwd exactly as it would inherit any other
 * unconfigured cwd in production.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { _electron as electron, type ElectronApplication, type Locator, type Page } from 'playwright-core';
import { FakeLocalInferenceRuntime, freePort } from '../helpers/fake-local-inference';

const require = createRequire(import.meta.url);
const electronExecutable = require('electron') as string;
const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const builtMain = resolve(repositoryRoot, 'out/main/index.js');
const FAKE_LOCAL_INFERENCE_RUNTIME_PATH = resolve(
  import.meta.dirname,
  '..',
  'fixtures',
  'fake-local-inference-runtime.mjs'
);

/* -------------------------------------------------------------------------- */
/* Sentinels                                                                   */
/* -------------------------------------------------------------------------- */

// Distinctive enough that they cannot collide with any other string the
// application, Electron, or Node itself might incidentally print or persist.
const SENTINEL_SUCCESS_PROMPT = 'agent-relay-e2e-sentinel-success-3f9a1c';
const SENTINEL_FAILED_PROMPT = 'agent-relay-e2e-sentinel-failed-7c1e2d';
const SENTINEL_TIMEOUT_PROMPT = 'agent-relay-e2e-sentinel-timeout-52bd4f';
const SENTINEL_IPC_ERROR_PROMPT = 'agent-relay-e2e-sentinel-ipcerror-91aa6b';
// Not a real credential: shaped like one so the adapter's redaction has
// something to redact, and the assertions below have something to prove is
// never rendered, logged, or persisted unredacted.
const FAKE_CREDENTIAL = 'sk-ant-e2efakecredentialdoNOTuse0123456789';
// Deliberately does not spell "credential", "token", "secret", "password" or
// any other `NAME: value`-shaped keyword next to the fake key: the adapter's
// provider-text validator refuses a completion that still reads as
// credential-shaped even after the specific key pattern is redacted, and this
// scenario is about proving that ordinary surrounding prose survives
// alongside a *redacted* key, not about exercising that stricter refusal.
const USEFUL_COMPLETION_TEXT = `Useful completion text. Stray value: ${FAKE_CREDENTIAL} at the end.`;
const REDACTED_COMPLETION_TEXT = 'Useful completion text. Stray value: [redacted] at the end.';
const NON_PERSISTENCE_SENTINELS = [
  SENTINEL_SUCCESS_PROMPT,
  SENTINEL_FAILED_PROMPT,
  SENTINEL_TIMEOUT_PROMPT,
  SENTINEL_IPC_ERROR_PROMPT,
  FAKE_CREDENTIAL,
  USEFUL_COMPLETION_TEXT,
  REDACTED_COMPLETION_TEXT
] as const;

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

/** Every stdout/stderr byte the Electron main process writes, from launch. */
class ProcessLog {
  private chunks: string[] = [];

  constructor(app: ElectronApplication) {
    const child = app.process();
    child.stdout?.on('data', (data: Buffer) => this.chunks.push(data.toString('utf8')));
    child.stderr?.on('data', (data: Buffer) => this.chunks.push(data.toString('utf8')));
  }

  text(): string {
    return this.chunks.join('');
  }
}

async function launch(
  profile: string,
  cwd: string
): Promise<{ app: ElectronApplication; page: Page; log: ProcessLog }> {
  const app = await electron.launch({
    executablePath: electronExecutable,
    args: ['--disable-gpu', builtMain],
    cwd,
    env: applicationEnvironment(profile),
    timeout: 30_000
  });
  const log = new ProcessLog(app);
  const page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  return { app, page, log };
}

/** `hasText` does substring matching, so "Local inference" also matches the
 * "Local inference lifecycle" card — callers that mean the settings card
 * specifically must pass an end-anchored pattern. */
function card(page: Page, title: string | RegExp): Locator {
  return page.locator('.card').filter({
    has: page.locator('.card__title', { hasText: title })
  }).first();
}

function inspectProfile(profile: string): {
  localInference: unknown;
  taskCount: number;
  runCount: number;
  runEventCount: number;
} {
  const db = new DatabaseSync(join(profile, 'agent-relay.sqlite'), { readOnly: true });
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('localInference') as
      | { value: string }
      | undefined;
    const count = (table: string): number =>
      (db.prepare(`SELECT COUNT(*) as n FROM ${table}`).get() as { n: number }).n;
    return {
      localInference: row ? JSON.parse(row.value) : null,
      taskCount: count('tasks'),
      runCount: count('runs'),
      runEventCount: count('run_events')
    };
  } finally {
    db.close();
  }
}

/** Every byte of every file under `dir`, concatenated, best-effort. */
function readAllFileContents(dir: string): string {
  const parts: string[] = [];
  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        walk(full);
      } else if (stats.isFile()) {
        try {
          // Sentinel/credential text is pure ASCII, which decodes identically
          // whether or not it sits inside an otherwise-binary file (SQLite
          // pages, WAL segments): a false negative here is not possible from
          // the encoding, only a file this could not read at all.
          parts.push(readFileSync(full, 'utf8'));
        } catch {
          // Locked or otherwise unreadable; nothing to assert about content
          // that could not be read.
        }
      }
    }
  };
  walk(dir);
  return parts.join('\n');
}

describe('Local inference Electron acceptance', () => {
  it('saves settings, runs the fake lifecycle, redacts a test inference, reports failures and IPC errors, persists nothing sensitive, and proves restart is passive', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'agent-relay-local-inference-e2e-'));
    const runtime = new FakeLocalInferenceRuntime().scenario({ health: 'ok' });
    const port = await freePort();

    let running: ElectronApplication | null = null;
    try {
      const first = await launch(profile, runtime.path);
      running = first.app;
      const page = first.page;
      const log = first.log;

      await page.getByRole('button', { name: 'Settings' }).click();
      const settingsCard = card(page, /^Local inference$/);
      await settingsCard.waitFor();
      const saveButton = page.getByRole('button', { name: 'Save settings' });

      // The shipped default ships as one unopened profile row; open its editor
      // before touching any of its per-field controls below.
      await settingsCard.getByRole('button', { name: /Local model/ }).click();
      await settingsCard.getByText(/^Editing: Local model/).waitFor();

      // Invalid edit first: a reserved fixed argument must disable Save and
      // send no update.
      await settingsCard.getByLabel(/^Fixed runtime arguments/).fill('--port\n9999');
      expect(await saveButton.isDisabled()).toBe(true);
      await settingsCard.getByLabel(/^Fixed runtime arguments/).fill('');

      // A complete, valid configuration pointed at the fake runtime, with a
      // distinctive saved output-token cap and a short inference timeout so
      // the hang scenario below produces a bounded, fast timeout.
      await settingsCard.getByLabel(/^Enable local inference/).check();
      await settingsCard.getByRole('combobox', { name: /^Executable/ }).selectOption('explicit_path');
      await settingsCard
        .getByRole('textbox', { name: 'Executable path', exact: true })
        .fill(FAKE_LOCAL_INFERENCE_RUNTIME_PATH);
      await settingsCard.getByLabel(/^Model id/).fill('fake-model');
      await settingsCard.getByRole('combobox', { name: /^Model source/ }).selectOption('runtime_id');
      await settingsCard.getByLabel('Runtime model identifier').fill('fake-model');
      await settingsCard.getByLabel(/^Port/).fill(String(port));
      await settingsCard.getByLabel(/^Default max output tokens/).fill('111');
      await settingsCard.getByLabel(/^Inference timeout \(ms\)/).fill('1500');

      expect(await saveButton.isDisabled()).toBe(false);
      await saveButton.click();
      await page.getByText('Settings saved').waitFor();

      const lifecycle = card(page, 'Local inference lifecycle');
      await lifecycle.waitFor();
      // Which profile the runtime acts on is a separate, explicit choice from saving Settings.
      await lifecycle.getByRole('combobox', { name: /^Active profile/ }).selectOption('default');
      await lifecycle.getByRole('button', { name: 'Check capabilities' }).click();
      await expect.poll(async () => lifecycle.textContent()).toMatch(/Executable available: yes/);
      await lifecycle.getByRole('button', { name: /Start runtime/ }).waitFor();
      await lifecycle.getByRole('button', { name: /Start runtime/ }).click();
      await expect.poll(async () => lifecycle.textContent()).toMatch(/Healthy/);
      await lifecycle.getByRole('button', { name: 'Check health' }).click();
      await expect.poll(async () => lifecycle.textContent()).toContain('Checked health.');

      /* ---------------------------------------------------------------- */
      /* One successful test inference, with a credential-shaped completion */
      /* ---------------------------------------------------------------- */

      runtime.scenario({ health: 'ok', completionText: USEFUL_COMPLETION_TEXT });
      const promptField = lifecycle.getByLabel(/^Test inference prompt/);
      await promptField.fill(SENTINEL_SUCCESS_PROMPT);
      await lifecycle.getByRole('button', { name: 'Run test inference' }).click();
      await expect.poll(async () => lifecycle.textContent()).toContain(REDACTED_COMPLETION_TEXT);
      const lifecycleTextAfterSuccess = await lifecycle.textContent();
      expect(lifecycleTextAfterSuccess).not.toContain(FAKE_CREDENTIAL);
      expect(lifecycleTextAfterSuccess).toMatch(/Stop \(the runtime reported a normal end\)/);
      expect(lifecycleTextAfterSuccess).toMatch(/local-llama-cpp \/ fake-model/);

      const afterSuccess = runtime.completionRequests();
      expect(afterSuccess).toHaveLength(1);
      const successBody = JSON.parse(afterSuccess[0]?.body ?? '{}') as Record<string, unknown>;
      expect(successBody).toMatchObject({
        model: 'fake-model',
        stream: false,
        n: 1,
        max_tokens: 111,
        messages: [{ role: 'user', content: SENTINEL_SUCCESS_PROMPT }]
      });

      /* ---------------------------------------------------------------- */
      /* A rejected inference. The adapter tears the runtime down with it. */
      /* ---------------------------------------------------------------- */

      runtime.scenario({ health: 'ok', completion: 'non2xx' });
      await promptField.fill(SENTINEL_FAILED_PROMPT);
      await lifecycle.getByRole('button', { name: 'Run test inference' }).click();
      await expect.poll(async () => lifecycle.textContent()).toMatch(/Failure reason/);
      const lifecycleTextAfterFailure = await lifecycle.textContent();
      expect(lifecycleTextAfterFailure).not.toContain('Completion');
      await expect.poll(async () => lifecycle.textContent()).toMatch(/Failed/);

      const afterFailure = runtime.completionRequests();
      expect(afterFailure).toHaveLength(2);
      expect(JSON.parse(afterFailure[1]?.body ?? '{}')).toMatchObject({
        messages: [{ role: 'user', content: SENTINEL_FAILED_PROMPT }]
      });

      // The failed inference took the runtime down; restart it explicitly.
      await lifecycle.getByRole('button', { name: /^Stop/ }).click();
      await expect.poll(async () => lifecycle.textContent()).toMatch(/Stopped/);
      await lifecycle.getByRole('button', { name: 'Check capabilities' }).click();
      await lifecycle.getByRole('button', { name: /Start runtime/ }).waitFor();
      await lifecycle.getByRole('button', { name: /Start runtime/ }).click();
      await expect.poll(async () => lifecycle.textContent()).toMatch(/Healthy/);

      /* ---------------------------------------------------------------- */
      /* A timed-out inference, using the saved 1500ms inference timeout.   */
      /* ---------------------------------------------------------------- */

      runtime.scenario({ health: 'ok', completion: 'hang' });
      await promptField.fill(SENTINEL_TIMEOUT_PROMPT);
      await lifecycle.getByRole('button', { name: 'Run test inference' }).click();
      // The panel still shows the previous step's "Failure reason" text until
      // this new outcome resolves, so only "Timed out" — never shown by any
      // earlier step — is a reliable signal that this specific request ended.
      await expect.poll(
        async () => lifecycle.textContent(),
        { timeout: 20_000 }
      ).toMatch(/Timed out/);
      const lifecycleTextAfterTimeout = await lifecycle.textContent();
      expect(lifecycleTextAfterTimeout).not.toContain('Completion');
      expect(lifecycleTextAfterTimeout).toMatch(/Failure reason/);

      // The fake runtime's evidence file is written fresh by whichever
      // process is currently running it, and the failed inference above
      // already tore the first process down — so this second, explicitly
      // restarted process starts its own evidence from zero. This one hang
      // request is the only completion request *it* has seen.
      const afterTimeout = runtime.completionRequests();
      expect(afterTimeout).toHaveLength(1);

      /* ---------------------------------------------------------------- */
      /* An IPC-level error: called directly while not Healthy, so no       */
      /* completion request is ever sent.                                  */
      /* ---------------------------------------------------------------- */

      // This callback runs in the renderer's browser context, which this
      // file's Node-targeted tsconfig has no DOM lib for; `globalThis as any`
      // is the portable way to reach `window.agentRelay` from either side.
      const ipcResult = await page.evaluate(
        async (prompt) =>
          (globalThis as any).agentRelay.invoke('localInference:runTestInference', { prompt }),
        SENTINEL_IPC_ERROR_PROMPT
      );
      expect(ipcResult.ok).toBe(false);
      expect(runtime.completionRequests()).toHaveLength(1);

      // Explicitly stop the runtime the timeout tore down and confirm cleanup.
      await lifecycle.getByRole('button', { name: /^Stop/ }).click();
      await expect.poll(async () => lifecycle.textContent()).toMatch(/Stopped/);

      /* ---------------------------------------------------------------- */
      /* Non-persistence: Settings only, no task/run/event history, no      */
      /* browser storage, and no application log output carries anything.  */
      /* ---------------------------------------------------------------- */

      const persistedFirst = inspectProfile(profile);
      expect(persistedFirst.localInference).toMatchObject({
        enabled: true,
        profiles: [
          {
            id: 'default',
            executable: { kind: 'explicit_path', path: FAKE_LOCAL_INFERENCE_RUNTIME_PATH },
            model: { source: { kind: 'runtime_id', runtimeModelId: 'fake-model' } },
            port
          }
        ]
      });
      const persistedLocalInferenceText = JSON.stringify(persistedFirst.localInference);
      for (const sentinel of NON_PERSISTENCE_SENTINELS) {
        expect(persistedLocalInferenceText).not.toContain(sentinel);
      }
      expect(persistedFirst.taskCount).toBe(0);
      expect(persistedFirst.runCount).toBe(0);
      expect(persistedFirst.runEventCount).toBe(0);

      // Same `globalThis`/DOM-lib note as above.
      const storage = await page.evaluate(() => ({
        local: JSON.stringify((globalThis as any).localStorage),
        session: JSON.stringify((globalThis as any).sessionStorage)
      }));
      for (const sentinel of NON_PERSISTENCE_SENTINELS) {
        expect(storage.local).not.toContain(sentinel);
        expect(storage.session).not.toContain(sentinel);
      }

      const requestsAfterFirstSession = runtime.requests().length;

      await running.close();
      running = null;

      // Every prompt, every raw and redacted completion, and the fake
      // credential: absent from stdout/stderr and from every file the
      // application itself wrote under the profile. The fake fixture's own
      // temporary evidence lives under `runtime.path`, not `profile`, so this
      // scan never touches the one place that is allowed to retain it.
      const appLogText = log.text();
      const profileFilesText = readAllFileContents(profile);
      for (const sentinel of NON_PERSISTENCE_SENTINELS) {
        expect(appLogText).not.toContain(sentinel);
        expect(profileFilesText).not.toContain(sentinel);
      }

      /* ---------------------------------------------------------------- */
      /* Restart: configuration-only persistence, no prior prompt/result,   */
      /* and no automatic runtime traffic.                                 */
      /* ---------------------------------------------------------------- */

      const second = await launch(profile, runtime.path);
      running = second.app;
      await second.page.getByRole('button', { name: 'Settings' }).click();
      const reopenedCard = card(second.page, /^Local inference$/);
      await reopenedCard.waitFor();
      expect(await reopenedCard.getByLabel(/^Enable local inference/).isChecked()).toBe(true);
      await reopenedCard.getByRole('button', { name: /Local model/ }).click();
      await reopenedCard.getByText(/^Editing: Local model/).waitFor();
      await expect
        .poll(async () => reopenedCard.getByLabel(/^Port/).inputValue())
        .toBe(String(port));

      // Opening the lifecycle panel performs only getState and listProfiles; it must not have probed,
      // launched, health-checked, inferred or started anything on its own. Nothing selects a profile on
      // restart either — "no profile selected" is the strongest possible proof nothing auto-started, and
      // the prompt/result from the previous session must be gone.
      const reopenedLifecycle = card(second.page, 'Local inference lifecycle');
      await reopenedLifecycle.waitFor();
      await expect.poll(async () => reopenedLifecycle.textContent()).toMatch(
        /No local-model profile is selected/
      );
      const reopenedText = await reopenedLifecycle.textContent();
      expect(reopenedText).not.toContain('Completion');
      expect(reopenedText).not.toContain(REDACTED_COMPLETION_TEXT);
      expect(await reopenedLifecycle.getByLabel(/^Test inference prompt/).inputValue()).toBe('');

      const evidenceAfterRestart = runtime.ran() ? runtime.evidence() : null;
      expect(evidenceAfterRestart?.requests.length ?? 0).toBe(requestsAfterFirstSession);

      await running.close();
      running = null;
    } finally {
      if (running) await running.close().catch(() => undefined);
      rmSync(profile, { recursive: true, force: true });
      await runtime.cleanup();
    }
  }, 90_000);
});
