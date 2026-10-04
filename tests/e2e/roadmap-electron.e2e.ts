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

const require = createRequire(import.meta.url);
const electronExecutable = require('electron') as string;
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
    executablePath: electronExecutable,
    args: ['--disable-gpu', builtMain],
    cwd: repositoryRoot,
    env: environment(profile),
    timeout: 30_000
  });
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

      await page.getByRole('tab', { name: 'Dependencies' }).click();
      await page.getByRole('combobox', { name: 'Dependent' }).selectOption({ label: 'task: Task B' });
      await page.getByRole('combobox', { name: 'Waits for' }).selectOption({ label: 'task: Task A' });
      await page.getByRole('button', { name: 'Add dependency' }).click();
      await page.getByText('Dependencies (1)').waitFor();

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
      await resumed.getByRole('tab', { name: 'Dependencies' }).click();
      await resumed.getByText('Dependencies (1)').waitFor();
      const tasks = await invoke<Array<{ id: string; status: string }>>(resumed, 'tasks:list', { projectId: project.id });
      expect(tasks.filter((task) => task.id === taskA.id || task.id === taskB.id).map((task) => task.status)).toEqual(['DRAFT', 'DRAFT']);

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
      await running?.close();
      rmSync(profile, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
