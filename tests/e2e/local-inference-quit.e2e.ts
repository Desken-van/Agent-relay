/**
 * Quitting Agent Relay stops the local runtime it started.
 *
 * Launches the real built application on a disposable profile, starts the repository-owned fake
 * runtime through the real Settings UI until it is Healthy, then ends the application — by an ordinary
 * quit, and (POSIX) by SIGTERM — and proves the runtime this run started is gone afterwards: the fake
 * runtime process and the helper it spawned, by the PIDs the fixture itself records (`runtime.evidence()`),
 * on every platform. Only those processes are looked at and, on cleanup, only they are stopped. An
 * application killed outright (SIGKILL, a crash) gets no chance to stop anything; that is documented in
 * docs/local-inference.md, not asserted here.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import type { ChildProcess } from 'node:child_process';
import { _electron as electron, type ElectronApplication, type Locator, type Page } from 'playwright-core';
import { FakeLocalInferenceRuntime, freePort } from '../helpers/fake-local-inference';
import { defaultProfileDiffers, saveSettingsThroughUi } from '../helpers/settings-save';

const require = createRequire(import.meta.url);
const electronExecutable = require('electron') as string;
const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const builtMain = resolve(repositoryRoot, 'out/main/index.js');
const FAKE_LOCAL_INFERENCE_RUNTIME_PATH = resolve(import.meta.dirname, '..', 'fixtures', 'fake-local-inference-runtime.mjs');

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
  return page.locator('.card').filter({
    has: page.locator('.card__title', { hasText: title })
  }).first();
}

async function startLocalInference(page: Page, runtimePath: string, port: number): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click();
  const settingsCard = card(page, /^Local inference$/);
  await settingsCard.waitFor();

  await settingsCard.getByLabel(/^Enable local inference/).check();
  // Distinct from the feature-wide toggle above: this profile must also be individually enabled for
  // `tasks:create` to bind a new Ornith task to it below.
  await settingsCard.getByLabel(/^Enable "Local model" for new task selection$/).check();
  // The shipped default ships as one unopened profile row; open its editor before touching any of
  // its per-field controls below.
  await settingsCard.getByRole('button', { name: /Local model/ }).click();
  await settingsCard.getByText(/^Editing: Local model/).waitFor();
  await settingsCard.getByRole('combobox', { name: /^Executable/ }).selectOption('explicit_path');
  await settingsCard.getByRole('textbox', { name: 'Executable path', exact: true }).fill(runtimePath);
  await settingsCard.getByLabel(/^Model id/).fill('fake-model');
  await settingsCard.getByRole('combobox', { name: /^Model source/ }).selectOption('runtime_id');
  await settingsCard.getByLabel('Runtime model identifier').fill('fake-model');
  await settingsCard.getByLabel(/^Port/).fill(String(port));
  // The production Ornith path now reserves context for both the chat
  // template and one bounded JSON action. Keep this fixture explicit rather
  // than relying on the generic 4096/4096 manual-inference defaults. 12288,
  // not 8192: the protocol's read_file paging guidance raised the smallest
  // context the immutable prompt fits in from ~7.5K to ~8.3K tokens (the real
  // configuration uses 32768), and this fixture is not a minimal-window test.
  await settingsCard.getByLabel('Context size (tokens)').fill('12288');
  await settingsCard.getByLabel('Default max output tokens').fill('1024');
  await saveSettingsThroughUi(page, defaultProfileDiffers({
    adapterKind: 'llama_cpp', modelId: 'fake-model', port, contextLimitTokens: 12288, maxOutputTokens: 1024, profileEnabled: true
  }));

  const lifecycle = card(page, 'Local inference lifecycle');
  await lifecycle.waitFor();
  // Which profile the runtime acts on is a separate, explicit choice from saving Settings.
  await lifecycle.getByRole('combobox', { name: /^Active profile/ }).selectOption('default');
  await lifecycle.getByRole('button', { name: 'Check capabilities' }).click();
  await expect_(async () => lifecycle.textContent(), (text) => (text ?? '').includes('Executable available: yes'));
  await lifecycle.getByRole('button', { name: /Start runtime/ }).waitFor();
  await lifecycle.getByRole('button', { name: /Start runtime/ }).click();
  // Not a bare `/Healthy/` match: the panel's static "must be Healthy to run
  // a test inference" hint contains that word even while Stopped/Starting, so
  // only the "Current state" line itself is a reliable signal.
  await expect_(async () => lifecycle.textContent(), (text) => /Current state\s*Healthy/.test(text ?? ''));
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

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the application process has exited, within `timeoutMs`. It takes the ChildProcess saved at
 * launch: once the application is quitting, Playwright may already have torn down its own connection, and
 * `ElectronApplication.process()` then throws (as it did on Windows CI). An exit that already happened
 * counts; the listener is attached in the same tick as that check, so an exit cannot slip between them;
 * the timer and the listener are both removed whichever way it ends.
 */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const exited = (): boolean => child.exitCode !== null || child.signalCode !== null;
  if (exited()) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(exited());
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

/** Bounded: whether every one of these processes has gone within `timeoutMs`. */
async function allGone(pids: readonly number[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!pids.some(isAlive)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('quitting the application stops the local runtime it owns', () => {
  const endings = process.platform === 'win32' ? (['quit'] as const) : (['quit', 'SIGTERM'] as const);
  for (const ending of endings) {
    it(`by ${ending === 'quit' ? 'an ordinary quit' : 'SIGTERM to the application'}`, async () => {
      const profile = mkdtempSync(join(tmpdir(), 'agent-relay-quit-e2e-'));
      // The runtime spawns a helper of its own, so what is checked is the runtime's whole tree, not one process.
      const runtime = new FakeLocalInferenceRuntime().scenario({ health: 'ok', spawnDescendant: true });
      const port = await freePort();
      let applicationProcess: ChildProcess | null = null;
      let owned: number[] = [];
      try {
        const launched = await launch(profile, runtime.path);
        // Saved now, while the connection is certainly alive: everything after the quit uses this object.
        applicationProcess = launched.app.process();
        await startLocalInference(launched.page, FAKE_LOCAL_INFERENCE_RUNTIME_PATH, port);
        const evidence = runtime.evidence();
        owned = [evidence.pid, evidence.descendantPid].filter((pid): pid is number => typeof pid === 'number' && pid > 0);
        // Both exist before the quit: the runtime this test configured and the helper it spawned.
        expect(owned).toHaveLength(2);
        expect(owned.filter(isAlive)).toEqual(owned);
        expect(evidence.argv).toContain(String(port));

        if (ending === 'quit') void launched.app.evaluate(({ app: electronApp }) => { electronApp.quit(); }).catch(() => undefined);
        else applicationProcess.kill('SIGTERM');

        // Bounded: the profile's shutdown budget plus grace, never an open-ended wait.
        expect(await waitForExit(applicationProcess, 90_000)).toBe(true);
        // The application stops its runtime BEFORE it exits; this only leaves room for the operating system
        // to finish reaping what was already terminated.
        expect(await allGone(owned, 5_000)).toBe(true);
        expect(owned.filter(isAlive)).toEqual([]);
      } finally {
        // Only this test's own processes, and only those still running.
        for (const pid of owned.filter(isAlive)) process.kill(pid, 'SIGKILL');
        if (applicationProcess !== null && !(await waitForExit(applicationProcess, 1))) applicationProcess.kill('SIGKILL');
        rmSync(profile, { recursive: true, force: true });
        await runtime.cleanup();
      }
    }, 180_000);
  }
});
