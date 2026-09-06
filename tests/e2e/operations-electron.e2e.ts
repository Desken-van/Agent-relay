/**
 * Phase 7C-C as an automated Electron acceptance test.
 *
 * This launches the built application with a brand-new data directory and
 * drives the real renderer, preload bridge, IPC handlers, repositories and
 * SQLite probe process. Every target is synthetic and every path is inside the
 * test's temporary directory. The user's real Agent Relay profile is never
 * opened.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { _electron as electron, type ElectronApplication, type Locator, type Page } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronExecutable = require('electron') as string;
const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const builtMain = resolve(repositoryRoot, 'out/main/index.js');

interface FileEvidence {
  readonly sha256: string;
  readonly size: number;
  readonly modifiedMs: number;
}

function evidence(path: string): FileEvidence {
  const contents = readFileSync(path);
  const stats = statSync(path);
  return {
    sha256: createHash('sha256').update(contents).digest('hex'),
    size: stats.size,
    modifiedMs: stats.mtimeMs
  };
}

function createFixture(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode = DELETE');
    db.exec('CREATE TABLE invoices (id INTEGER PRIMARY KEY, customer TEXT NOT NULL, total REAL)');
    db.exec('CREATE TABLE payments (id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL)');
    db.exec("INSERT INTO invoices (customer, total) VALUES ('E2E-ROW-CANARY', 1234.56)");
  } finally {
    db.close();
  }
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

async function launch(profile: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    executablePath: electronExecutable,
    // CI and agent sandboxes may not expose a usable Windows GPU process. The
    // acceptance is about DOM/IPC/SQLite behaviour, so software-free rendering
    // is the deterministic choice and does not weaken the path being tested.
    args: ['--disable-gpu', builtMain],
    cwd: repositoryRoot,
    env: applicationEnvironment(profile),
    timeout: 30_000
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  return { app, page };
}

function card(page: Page, title: string): Locator {
  return page.locator('.card').filter({
    has: page.locator('.card__title', { hasText: title })
  }).first();
}

async function registerTarget(page: Page, name: string, databasePath: string): Promise<void> {
  const form = card(page, 'Register a target');
  await form.getByLabel('Name').fill(name);
  await form.getByLabel('Environment').selectOption('local');
  await form.getByLabel('Database path').fill(databasePath);
  await form.getByRole('button', { name: 'Register target' }).click();
  await page.getByRole('button', { name: new RegExp(name) }).waitFor();
}

async function selectTarget(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await card(page, 'Run a diagnostic').waitFor();
}

async function runDiagnostic(page: Page, probeId: 'connection_health' | 'schema_summary'): Promise<Locator> {
  const run = card(page, 'Run a diagnostic');
  await run.getByLabel('Diagnostic').selectOption(probeId);
  await run.getByRole('button', { name: 'Run diagnostic' }).click();

  const latest = card(page, 'Latest result');
  await latest.waitFor();
  await expect.poll(async () => latest.textContent()).toContain(probeId);
  await expect.poll(async () => latest.textContent()).not.toContain('running');
  return latest;
}

function inspectProfile(profile: string): {
  targets: number;
  runs: number;
  failedRuns: number;
  storedResults: string;
} {
  const db = new DatabaseSync(join(profile, 'agent-relay.sqlite'), { readOnly: true });
  try {
    const scalar = (sql: string): number => {
      const row = db.prepare(sql).get() as { n: number };
      return Number(row.n);
    };
    const results = db
      .prepare('SELECT structured_result FROM operation_diagnostic_runs WHERE structured_result IS NOT NULL')
      .all() as Array<{ structured_result: string }>;
    return {
      targets: scalar('SELECT COUNT(*) AS n FROM operation_targets'),
      runs: scalar('SELECT COUNT(*) AS n FROM operation_diagnostic_runs'),
      failedRuns: scalar("SELECT COUNT(*) AS n FROM operation_diagnostic_runs WHERE status = 'failed'"),
      storedResults: results.map((row) => row.structured_result).join('\n')
    };
  } finally {
    db.close();
  }
}

describe('Operations Electron acceptance', () => {
  it('completes the isolated read-only diagnostic journey without touching row data', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'agent-relay-operations-e2e-'));
    const fixture = join(profile, 'fixture.sqlite');
    const missing = join(profile, 'missing.sqlite');
    const invalid = join(profile, 'not-a-database.sqlite');
    createFixture(fixture);
    writeFileSync(invalid, 'This is deliberately not a SQLite database.');
    const before = evidence(fixture);

    let running: ElectronApplication | null = null;
    try {
      const first = await launch(profile);
      running = first.app;
      const page = first.page;

      await page.getByRole('button', { name: 'Operations' }).click();
      await page.getByText('No targets registered').waitFor();
      expect(await page.locator('.topbar').textContent()).toBe('Operations');

      const form = card(page, 'Register a target');
      await form.getByLabel('Name').fill('7CC fixture');
      expect(await form.getByRole('button', { name: 'Register target' }).isDisabled()).toBe(true);
      await form.getByLabel('Environment').selectOption('local');
      await form.getByLabel('Database path').fill('fixture.sqlite');
      expect(await form.getByRole('button', { name: 'Register target' }).isDisabled()).toBe(true);
      expect(await form.textContent()).toMatch(/absolute path/i);
      await form.getByLabel('Database path').fill(fixture);
      expect(await form.getByRole('button', { name: 'Register target' }).isEnabled()).toBe(true);
      await form.getByRole('button', { name: 'Register target' }).click();
      await page.getByRole('button', { name: /7CC fixture/ }).waitFor();
      expect(await form.getByLabel('Name').inputValue()).toBe('');
      expect(await form.getByLabel('Database path').inputValue()).toBe('');

      await selectTarget(page, '7CC fixture');
      const health = await runDiagnostic(page, 'connection_health');
      const healthText = (await health.textContent()) ?? '';
      expect(healthText).toMatch(/Opened\s*yes/);
      expect(healthText).toMatch(/Read-only\s*yes/);
      expect(healthText).toMatch(/query_only\s*yes/);
      expect(healthText).toMatch(/File exists\s*yes/);
      expect(healthText).toContain(`${before.size} bytes`);

      const schema = await runDiagnostic(page, 'schema_summary');
      const schemaText = (await schema.textContent()) ?? '';
      expect(schemaText).toContain('invoices');
      expect(schemaText).toContain('payments');
      expect(schemaText).toContain('customer');
      expect(schemaText).not.toContain('E2E-ROW-CANARY');
      expect(schemaText).not.toContain('1234.56');

      const history = card(page, 'History');
      const refreshHistory = history.getByRole('button', { name: 'Refresh' });
      await refreshHistory.click();
      await expect.poll(async () => refreshHistory.isEnabled()).toBe(true);
      await page.getByRole('button', { name: 'Projects' }).click();
      await page.getByRole('button', { name: 'Operations' }).click();
      await page.getByRole('button', { name: /7CC fixture/ }).waitFor();
      await selectTarget(page, '7CC fixture');

      const target = card(page, '7CC fixture');
      await target.getByRole('button', { name: 'Disable' }).click();
      await target.getByRole('button', { name: 'Enable' }).waitFor();
      expect(await card(page, 'Run a diagnostic').getByRole('button', { name: 'Run diagnostic' }).isDisabled()).toBe(true);
      await target.getByRole('button', { name: 'Remove registration' }).click();
      await target.getByRole('button', { name: 'Yes, remove the registration' }).click();
      await page.getByText(/diagnostic run\(s\) on record/).waitFor();
      expect(await page.locator('body').textContent()).toMatch(/Disable the target instead/);

      await registerTarget(page, 'Missing database', missing);
      await selectTarget(page, 'Missing database');
      const missingHealth = await runDiagnostic(page, 'connection_health');
      expect(await missingHealth.textContent()).toMatch(/File exists\s*no/);
      expect(await missingHealth.textContent()).toMatch(/Opened\s*no/);

      await registerTarget(page, 'Not a database', invalid);
      await selectTarget(page, 'Not a database');
      const invalidHealth = await runDiagnostic(page, 'connection_health');
      expect(await invalidHealth.textContent()).toMatch(/Opened\s*no/);
      const invalidSchema = await runDiagnostic(page, 'schema_summary');
      expect(await invalidSchema.textContent()).toMatch(/failed/);
      expect(await invalidSchema.textContent()).not.toContain('invoices');

      await running.close();
      running = null;

      const persisted = inspectProfile(profile);
      expect(persisted.targets).toBe(3);
      expect(persisted.runs).toBe(5);
      expect(persisted.failedRuns).toBe(1);
      expect(persisted.storedResults).not.toContain('E2E-ROW-CANARY');
      expect(persisted.storedResults).not.toContain('1234.56');
      expect(evidence(fixture)).toEqual(before);
      expect(existsSync(`${fixture}-wal`)).toBe(false);
      expect(existsSync(`${fixture}-shm`)).toBe(false);

      const second = await launch(profile);
      running = second.app;
      await second.page.getByRole('button', { name: 'Operations' }).click();
      await second.page.getByText('Targets (3)').waitFor();
      await selectTarget(second.page, '7CC fixture');
      expect(await card(second.page, 'History').locator('details').count()).toBe(2);
      await running.close();
      running = null;
      expect(inspectProfile(profile).runs).toBe(5);
    } finally {
      if (running) await running.close().catch(() => undefined);
      rmSync(profile, { recursive: true, force: true });
    }
  });
});
