/**
 * Milestone 13E: the built Electron app's Roadmap path through renderer, preload, IPC and SQLite.
 * The profile and Git project are synthetic and removed after the test. No AI provider or GitHub is used.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { createSqliteDatabase } from '../../src/main/db/sqlite';
import { MIGRATIONS } from '../../src/main/db/migrations';
import { TASK_STATUSES } from '../../src/shared/domain/workflow';

const require = createRequire(import.meta.url);
const electronExecutable = require('electron') as string;
const packagedExecutable = process.env.AGENT_RELAY_E2E_EXECUTABLE;
const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const builtMain = resolve(repositoryRoot, 'out/main/index.js');

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

function environment(profile: string): Record<string, string> {
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
    executablePath: packagedExecutable ?? electronExecutable,
    args: packagedExecutable ? ['--disable-gpu'] : ['--disable-gpu', builtMain],
    cwd: repositoryRoot,
    env: environment(profile),
    timeout: 30_000
  });
  // A packaged acceptance must exercise production startup/CSP, not Electron's
  // default app loading a source checkout. Close on a bad launch assertion too.
  try {
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(Boolean(packagedExecutable));
  } catch (error) {
    await app.close();
    throw error;
  }
  const page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  return { app, page };
}

async function invoke<T>(page: Page, channel: string, input: unknown): Promise<T> {
  const result = await page.evaluate(
    async ({ channel, input }) => (globalThis as any).agentRelay.invoke(channel, input),
    { channel, input }
  );
  if (!result.ok) throw new Error(`${channel}: ${JSON.stringify(result.error)}`);
  return result.data as T;
}

async function openRoadmap(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Projects' }).click();
  await page.locator('.card').filter({ hasText: 'Projects (' }).getByRole('button', { name: 'Refresh' }).click();
  await page.getByRole('button', { name: /13E fixture/ }).click();
  await page.locator('.rail__nav').getByRole('button', { name: 'Roadmap', exact: true }).click();
  await page.getByRole('heading', { name: 'Roadmap' }).waitFor();
}

describe('Roadmap Electron acceptance', () => {
  it('authors a hierarchy, places tasks, records a dependency, refreshes and persists across restart', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'agent-relay-roadmap-e2e-profile-'));
    const repo = mkdtempSync(join(tmpdir(), 'agent-relay-roadmap-e2e-repo-'));
    let running: ElectronApplication | null = null;
    try {
      git(repo, ['init', '-b', 'main']);
      git(repo, ['config', 'user.name', 'Roadmap E2E Fixture']);
      git(repo, ['config', 'user.email', 'fixture@example.invalid']);
      writeFileSync(join(repo, 'README.md'), 'Roadmap acceptance fixture.\n');
      git(repo, ['add', '--', 'README.md']);
      git(repo, ['commit', '-m', 'fixture']);

      const first = await launch(profile);
      running = first.app;
      const page = first.page;
      const project = await invoke<{ id: string }>(page, 'projects:addExisting', {
        localPath: repo, name: '13E fixture', defaultBranch: 'main'
      });
      const taskA = await invoke<{ id: string }>(page, 'tasks:create', {
        projectId: project.id, title: 'Task A', originalRequest: 'First synthetic task.'
      });
      const taskB = await invoke<{ id: string }>(page, 'tasks:create', {
        projectId: project.id, title: 'Task B', originalRequest: 'Second synthetic task.'
      });
      await openRoadmap(page);

      await page.getByText('No goals yet').waitFor();
      await page.getByRole('button', { name: '+ Goal' }).click();
      await page.getByRole('textbox', { name: 'New goal title' }).fill('Ship roadmap');
      await page.getByRole('button', { name: 'Create goal' }).click();
      await page.getByRole('button', { name: 'Ship roadmap' }).waitFor();
      await page.getByRole('button', { name: '+ Criterion' }).click();
      await page.getByRole('textbox', { name: 'Criterion 1' }).fill('The path works in Electron');
      await page.getByRole('button', { name: 'Save details' }).click();
      await expect.poll(async () => page.getByRole('textbox', { name: 'Criterion 1' }).inputValue()).toBe('The path works in Electron');

      await page.getByRole('button', { name: '+ phase' }).click();
      await page.getByRole('textbox', { name: 'New phase title' }).fill('Build');
      await page.getByRole('button', { name: 'Create phase' }).click();
      await page.getByRole('button', { name: 'Build' }).click();
      await page.getByRole('button', { name: '+ epic' }).click();
      await page.getByRole('textbox', { name: 'New epic title' }).fill('Renderer');
      await page.getByRole('button', { name: 'Create epic' }).click();

      await page.getByRole('tab', { name: 'Kanban' }).click();
      await page.getByRole('combobox', { name: 'Place Task A' }).selectOption({ label: 'Renderer' });
      await expect.poll(async () => page.getByRole('combobox', { name: 'Place Task A' }).inputValue()).not.toBe('');
      await page.getByRole('combobox', { name: 'Place Task B' }).selectOption({ label: 'Renderer' });
      await expect.poll(async () => page.getByRole('combobox', { name: 'Place Task B' }).inputValue()).not.toBe('');
      expect(await page.locator('.roadmap__column').filter({ has: page.getByRole('heading', { name: 'Renderer' }) }).textContent())
        .toMatch(/Task A[\s\S]*Task B/);
      const rendererColumn = page.locator('.roadmap__column').filter({ has: page.getByRole('heading', { name: 'Renderer' }) });
      await rendererColumn.locator('.roadmap__task').filter({ has: page.getByRole('button', { name: 'Task B', exact: true }) })
        .getByRole('button', { name: 'Up', exact: true }).click();
      await expect.poll(async () => rendererColumn.locator('.roadmap__task-title').allTextContents()).toEqual(['Task B', 'Task A']);

      await page.getByRole('tab', { name: 'Dependencies' }).click();
      await page.getByRole('combobox', { name: 'Dependent' }).selectOption({ label: 'task: Task B' });
      await page.getByRole('combobox', { name: 'Waits for' }).selectOption({ label: 'task: Task A' });
      await page.getByRole('button', { name: 'Add dependency' }).click();
      await page.getByText('Dependencies (1)').waitFor();
      await page.getByRole('tab', { name: 'Kanban' }).click();
      const dependent = page.locator('.roadmap__task').filter({ has: page.getByRole('button', { name: 'Task B', exact: true }) });
      await expect.poll(async () => dependent.locator('.roadmap__task-meta .roadmap__readiness').textContent()).toBe('pending');
      // Synthetic workflow facts only; real task execution is outside this Roadmap acceptance.
      const workflowDb = new DatabaseSync(join(profile, 'agent-relay.sqlite'));
      try { workflowDb.prepare("UPDATE tasks SET status = 'FAILED' WHERE id = ?").run(taskA.id); }
      finally { workflowDb.close(); }
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect.poll(async () => dependent.locator('.roadmap__task-meta .roadmap__readiness').textContent()).toBe('blocked');
      const completeDb = new DatabaseSync(join(profile, 'agent-relay.sqlite'));
      try { completeDb.prepare("UPDATE tasks SET status = 'COMPLETED' WHERE id = ?").run(taskA.id); }
      finally { completeDb.close(); }
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect.poll(async () => dependent.locator('.roadmap__task-meta .roadmap__readiness').textContent()).toBe('ready');

      // A second writer changes the revision while a local draft is open. The event must refresh
      // the view and keep the draft until the person explicitly discards or reapplies it.
      await page.getByRole('tab', { name: 'Roadmap' }).click();
      await page.getByRole('button', { name: 'Ship roadmap' }).click();
      await page.getByRole('textbox', { name: 'Title' }).fill('Unsaved local title');
      const before = await invoke<{ revision: number }>(page, 'roadmap:get', { projectId: project.id });
      await invoke(page, 'roadmap:createNode', {
        projectId: project.id, expectedRevision: before.revision, kind: 'goal', parentId: null, title: 'Another goal'
      });
      await page.getByText(/Your unsaved draft is from revision/).waitFor();
      expect(await page.getByRole('textbox', { name: 'Title' }).inputValue()).toBe('Unsaved local title');
      await page.getByRole('button', { name: 'Discard draft' }).click();
      expect(await page.getByRole('textbox', { name: 'Title' }).inputValue()).toBe('Ship roadmap');

      await running.close();
      running = null;
      const second = await launch(profile);
      running = second.app;
      const resumed = second.page;
      await openRoadmap(resumed);
      await resumed.getByRole('button', { name: 'Ship roadmap' }).waitFor();
      await resumed.getByRole('button', { name: 'Build' }).waitFor();
      await resumed.getByRole('button', { name: 'Renderer' }).waitFor();
      await resumed.getByRole('button', { name: 'Ship roadmap' }).click();
      expect(await resumed.getByRole('textbox', { name: 'Criterion 1' }).inputValue()).toBe('The path works in Electron');
      await resumed.getByRole('tab', { name: 'Kanban' }).click();
      expect(await resumed.getByRole('combobox', { name: 'Place Task A' }).inputValue()).not.toBe('');
      expect(await resumed.getByRole('combobox', { name: 'Place Task B' }).inputValue()).not.toBe('');
      const resumedColumn = resumed.locator('.roadmap__column').filter({ has: resumed.getByRole('heading', { name: 'Renderer' }) });
      expect(await resumedColumn.locator('.roadmap__task-title').allTextContents()).toEqual(['Task B', 'Task A']);
      expect(await resumedColumn.locator('.roadmap__task').filter({ has: resumed.getByRole('button', { name: 'Task B', exact: true }) })
        .locator('.roadmap__task-meta .roadmap__readiness').textContent()).toBe('ready');
      await resumed.getByRole('tab', { name: 'Dependencies' }).click();
      await resumed.getByText('Dependencies (1)').waitFor();
      const tasks = await invoke<Array<{ id: string; status: string }>>(resumed, 'tasks:list', { projectId: project.id });
      expect(tasks.find((task) => task.id === taskA.id)?.status).toBe('COMPLETED');
      expect(tasks.find((task) => task.id === taskB.id)?.status).toBe('DRAFT');
      for (const width of [1040, 1440, 1920]) {
        await running.evaluate(({ BrowserWindow }, width) => { BrowserWindow.getAllWindows()[0]!.setSize(width, 940); }, width);
        for (const tab of ['Roadmap', 'Kanban', 'Dependencies']) {
          await resumed.getByRole('tab', { name: tab, exact: true }).click();
          expect(await resumed.evaluate(() => {
            const browser = globalThis as unknown as { document: { documentElement: { scrollWidth: number } }; innerWidth: number };
            return browser.document.documentElement.scrollWidth <= browser.innerWidth;
          })).toBe(true);
          const box = await resumed.getByRole('tab', { name: tab, exact: true }).boundingBox();
          expect(box && box.width > 0 && box.x >= 0 && box.x + box.width <= width).toBeTruthy();
        }
      }

      // Corrupt only the disposable profile after closing Electron. A damaged roadmap must
      // fail closed while the project's existing tasks remain reachable from the screen.
      await running.close();
      running = null;
      const db = new DatabaseSync(join(profile, 'agent-relay.sqlite'));
      try {
        db.prepare("UPDATE roadmap_nodes SET acceptance_criteria_json = 'not-json' WHERE title = 'Ship roadmap'").run();
      } finally {
        db.close();
      }
      const third = await launch(profile);
      running = third.app;
      await openRoadmap(third.page);
      await third.page.getByText('Tasks remain available').waitFor();
      await third.page.getByRole('button', { name: /Task A/ }).click();
      expect(await third.page.locator('.topbar__title').textContent()).toBe('Run');
    } finally {
      try { await running?.close(); }
      finally {
        rmSync(profile, { recursive: true, force: true });
        rmSync(repo, { recursive: true, force: true });
      }
    }
  });

  it('upgrades a pre-Roadmap profile and keeps every stable legacy task reachable and unchanged', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'agent-relay-roadmap-e2e-legacy-'));
    const repo = mkdtempSync(join(tmpdir(), 'agent-relay-roadmap-e2e-repo-'));
    const file = join(profile, 'agent-relay.sqlite');
    const busy = new Set(['SPECIFYING', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'PUBLISHING']);
    const statuses = TASK_STATUSES.filter((status) => !busy.has(status));
    let running: ElectronApplication | null = null;
    try {
      git(repo, ['init', '-b', 'main']);
      const db = createSqliteDatabase(file);
      let before: unknown[];
      try {
        db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
        for (const migration of MIGRATIONS.filter((entry) => entry.version <= 23)) {
          db.transaction(() => {
            migration.up(db);
            db.prepare('INSERT INTO schema_migrations VALUES (?,?,?)').run(migration.version, migration.name, '2026-09-29T10:00:00.000Z');
          })();
        }
        db.prepare(`INSERT INTO projects(id,name,local_path,project_type,default_branch,github_visibility,created_at,updated_at)
          VALUES ('legacy','13E fixture',?,'existing','main','private',?,?)`).run(repo, '2026-09-29T10:00:00.000Z', '2026-09-29T10:00:00.000Z');
        for (const status of statuses) {
          db.prepare(`INSERT INTO tasks(id,project_id,title,original_request,status,created_at,updated_at)
            VALUES (?,'legacy',?,'Original request',?,?,?)`).run(status, `Legacy ${status}`, status, '2026-09-29T10:00:00.000Z', '2026-09-29T10:00:00.000Z');
        }
        before = db.prepare('SELECT * FROM tasks ORDER BY id').all();
      } finally { db.close(); }
      const launched = await launch(profile);
      running = launched.app;
      await openRoadmap(launched.page);
      await launched.page.getByRole('tab', { name: 'Kanban' }).click();
      expect(await launched.page.locator('.roadmap__task-title').allTextContents()).toEqual([...statuses].sort().map((status) => `Legacy ${status}`));
      for (const status of statuses) {
        await launched.page.getByRole('button', { name: `Legacy ${status}`, exact: true }).click();
        expect(await launched.page.locator('.topbar__title').textContent()).toBe('Run');
        await launched.page.locator('.rail__nav').getByRole('button', { name: 'Roadmap', exact: true }).click();
        await launched.page.getByRole('tab', { name: 'Kanban' }).click();
      }
      await running.close();
      running = null;
      const persisted = new DatabaseSync(file, { readOnly: true });
      try {
        expect(persisted.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(before);
        expect(persisted.prepare('SELECT version FROM schema_migrations WHERE version = 24').get()).toEqual({ version: 24 });
        expect(persisted.prepare('SELECT * FROM roadmap_task_placements').all()).toEqual([]);
      } finally { persisted.close(); }
    } finally {
      try { await running?.close(); }
      finally {
        rmSync(profile, { recursive: true, force: true });
        rmSync(repo, { recursive: true, force: true });
      }
    }
  });
});
