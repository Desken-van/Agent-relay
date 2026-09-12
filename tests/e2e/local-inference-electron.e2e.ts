/**
 * LOCAL-B2 as an automated Electron acceptance test.
 *
 * Launches the built application against a brand-new profile and the
 * repository-owned fake local-inference runtime (never a real llama.cpp, never
 * a real model). Drives the real renderer/preload/IPC/database/service/adapter
 * path: an invalid edit is rejected, a valid configuration is saved, the five
 * lifecycle operations run against the fake runtime, and a restart proves
 * settings persisted and nothing was probed, launched or started automatically.
 *
 * The fake runtime fixture reads its scenario from its **working directory**.
 * Local-inference settings do not expose a working-directory override (LOCAL-B2
 * deliberately adds no such field), so this suite launches Electron itself with
 * `cwd` set to the scenario directory — the managed process a settings-driven
 * adapter spawns inherits that cwd exactly as it would inherit any other
 * unconfigured cwd in production.
 */

import { mkdtempSync, rmSync } from 'node:fs';
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

/** `hasText` does substring matching, so "Local inference" also matches the
 * "Local inference lifecycle" card — callers that mean the settings card
 * specifically must pass an end-anchored pattern. */
function card(page: Page, title: string | RegExp): Locator {
  return page.locator('.card').filter({
    has: page.locator('.card__title', { hasText: title })
  }).first();
}

function inspectProfile(profile: string): { localInference: unknown } {
  const db = new DatabaseSync(join(profile, 'agent-relay.sqlite'), { readOnly: true });
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('localInference') as
      | { value: string }
      | undefined;
    return { localInference: row ? JSON.parse(row.value) : null };
  } finally {
    db.close();
  }
}

describe('Local inference Electron acceptance', () => {
  it('saves settings, rejects an invalid edit, runs the fake lifecycle, and proves restart is passive', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'agent-relay-local-inference-e2e-'));
    const runtime = new FakeLocalInferenceRuntime().scenario({ health: 'ok' });
    const port = await freePort();

    let running: ElectronApplication | null = null;
    try {
      const first = await launch(profile, runtime.path);
      running = first.app;
      const page = first.page;

      await page.getByRole('button', { name: 'Settings' }).click();
      const settingsCard = card(page, /^Local inference$/);
      await settingsCard.waitFor();
      const saveButton = page.getByRole('button', { name: 'Save settings' });

      // Invalid edit first: a reserved fixed argument must disable Save and
      // send no update.
      await settingsCard.getByLabel(/^Fixed runtime arguments/).fill('--port\n9999');
      expect(await saveButton.isDisabled()).toBe(true);
      await settingsCard.getByLabel(/^Fixed runtime arguments/).fill('');

      // A complete, valid configuration pointed at the fake runtime.
      await settingsCard.getByLabel(/^Enable local inference/).check();
      await settingsCard.getByRole('combobox', { name: /^Executable/ }).selectOption('explicit_path');
      await settingsCard
        .getByRole('textbox', { name: 'Executable path', exact: true })
        .fill(FAKE_LOCAL_INFERENCE_RUNTIME_PATH);
      await settingsCard.getByRole('combobox', { name: /^Model source/ }).selectOption('runtime_id');
      await settingsCard.getByLabel('Runtime model identifier').fill('fake-model');
      await settingsCard.getByLabel(/^Port/).fill(String(port));

      expect(await saveButton.isDisabled()).toBe(false);
      await saveButton.click();
      await page.getByText('Settings saved').waitFor();

      const lifecycle = card(page, 'Local inference lifecycle');
      await lifecycle.waitFor();
      await lifecycle.getByRole('button', { name: 'Check capabilities' }).click();
      await expect.poll(async () => lifecycle.textContent()).toMatch(/Executable available: yes/);
      await lifecycle.getByRole('button', { name: /Start runtime/ }).waitFor();
      await lifecycle.getByRole('button', { name: /Start runtime/ }).click();
      await expect.poll(async () => lifecycle.textContent()).toMatch(/Healthy/);
      await lifecycle.getByRole('button', { name: 'Check health' }).click();
      await expect.poll(async () => lifecycle.textContent()).toContain('Checked health.');
      await lifecycle.getByRole('button', { name: /^Stop/ }).click();
      await expect.poll(async () => lifecycle.textContent()).toMatch(/Stopped/);

      const evidence = runtime.evidence();
      const healthRequests = evidence.requests.filter((request) => request.path === '/health');
      const completionRequests = evidence.requests.filter(
        (request) => request.path === '/v1/chat/completions'
      );
      expect(healthRequests.length).toBeGreaterThan(0);
      expect(completionRequests).toHaveLength(0);
      const requestsAfterFirstSession = evidence.requests.length;

      await running.close();
      running = null;

      const persistedFirst = inspectProfile(profile);
      expect(persistedFirst.localInference).toMatchObject({
        enabled: true,
        executable: { kind: 'explicit_path', path: FAKE_LOCAL_INFERENCE_RUNTIME_PATH },
        model: { source: { kind: 'runtime_id', runtimeModelId: 'fake-model' } },
        port
      });

      // Restart against the same profile and scenario directory.
      const second = await launch(profile, runtime.path);
      running = second.app;
      await second.page.getByRole('button', { name: 'Settings' }).click();
      const reopenedCard = card(second.page, /^Local inference$/);
      await reopenedCard.waitFor();
      await expect
        .poll(async () => reopenedCard.getByLabel(/^Port/).inputValue())
        .toBe(String(port));
      expect(await reopenedCard.getByLabel(/^Enable local inference/).isChecked()).toBe(true);

      // Opening the lifecycle panel performs only getState; it must not have
      // probed, launched, health-checked or started anything on its own.
      const reopenedLifecycle = card(second.page, 'Local inference lifecycle');
      await reopenedLifecycle.waitFor();
      await expect.poll(async () => reopenedLifecycle.textContent()).toMatch(/Stopped/);

      const evidenceAfterRestart = runtime.ran() ? runtime.evidence() : null;
      expect(evidenceAfterRestart?.requests.length ?? 0).toBe(requestsAfterFirstSession);

      await running.close();
      running = null;
    } finally {
      if (running) await running.close().catch(() => undefined);
      rmSync(profile, { recursive: true, force: true });
      await runtime.cleanup();
    }
  });
});
