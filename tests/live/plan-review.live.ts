/**
 * Opt-in live acceptance for the real external plan-review integration.
 *
 * This test is intentionally excluded from `npm run verify`: it contacts the
 * configured review provider and consumes that provider's quota. It uses a
 * synthetic Git repository, a fresh Agent Relay profile and an isolated copy
 * of the Coai data directory. Authentication remains owned by the provider.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { _electron as electron, type ElectronApplication, type Locator, type Page } from 'playwright-core';

const require = createRequire(import.meta.url);
const electronExecutable = require('electron') as string;
const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const builtMain = resolve(repositoryRoot, 'out/main/index.js');

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for live plan-review acceptance.`);
  return value;
};

const live = {
  mcpExecutable: required('AGENT_RELAY_LIVE_COAI_EXE'),
  coaiSettings: required('AGENT_RELAY_LIVE_COAI_SETTINGS'),
  conventionsRepository: required('AGENT_RELAY_LIVE_CONVENTIONS_REPO'),
  conventionsRevision: required('AGENT_RELAY_LIVE_CONVENTIONS_REV'),
  keepArtifacts: process.env.AGENT_RELAY_LIVE_KEEP_ARTIFACTS === '1',
  resumeRoot: process.env.AGENT_RELAY_LIVE_RESUME_ROOT?.trim() || null
};

const conventionPaths = [
  'common/durable-status.md',
  'common/coding-style.md',
  'typescript/doctrine.md',
  'common/reuse-first.md'
] as const;

const safeCoaiSettingNames = [
  'COAI_VENDORS',
  'COAI_PROMPTS_PER_ROUND',
  'COAI_ROUNDS_PLANCRITIQUE',
  'COAI_ROUNDS_SECURITYRELIABILITY',
  'COAI_ROUNDS_UXDXPERFORMANCE',
  'COAI_THRESHOLD_PLANCRITIQUE',
  'COAI_THRESHOLD_ARCHITECTURE',
  'COAI_THRESHOLD_SECURITYRELIABILITY',
  'COAI_THRESHOLD_UXDXPERFORMANCE',
  'COAI_ON_EXHAUSTED',
  'COAI_MAX_PER_PROVIDER',
  'COAI_ESCALATION_MINUTES'
] as const;

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function createSyntheticRepository(root: string): string {
  const repo = join(root, 'project');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(
    join(repo, 'AGENTS.md'),
    [
      '# Synthetic acceptance repository',
      '',
      '- Keep arithmetic functions pure and deterministic.',
      '- Reject division by zero with an explicit error.',
      '- Do not add dependencies, network access, credentials, or filesystem writes.',
      '- Tests must cover the successful path and the rejected zero-divisor path.',
      ''
    ].join('\n')
  );
  writeFileSync(join(repo, 'README.md'), '# Relay acceptance calculator\n');
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ name: 'relay-plan-review-acceptance', private: true, version: '0.0.0', type: 'module' }, null, 2) + '\n'
  );
  writeFileSync(
    join(repo, 'src', 'calculator.ts'),
    'export function add(left: number, right: number): number {\n  return left + right;\n}\n'
  );
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Agent Relay Acceptance');
  git(repo, 'config', 'user.email', 'acceptance@example.invalid');
  git(repo, 'add', '--', 'AGENTS.md', 'README.md', 'package.json', 'src/calculator.ts');
  git(repo, 'commit', '-m', 'Create synthetic review fixture');
  return repo;
}

function copySafeCoaiSettings(source: string, destination: string): void {
  const parsed = JSON.parse(readFileSync(source, 'utf8')) as Record<string, unknown>;
  const allowed = new Set<string>(safeCoaiSettingNames);
  const unexpected = Object.keys(parsed).filter((name) => !allowed.has(name));
  if (unexpected.length > 0) {
    throw new Error(`Refusing to copy unexpected Coai setting keys: ${unexpected.sort().join(', ')}`);
  }
  const safe = Object.fromEntries(safeCoaiSettingNames.flatMap((name) => (name in parsed ? [[name, parsed[name]]] : [])));
  writeFileSync(destination, JSON.stringify(safe, null, 2) + '\n');
}

function applicationEnvironment(profile: string, coaiData: string): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  env.AGENT_RELAY_DATA_DIR = profile;
  env.COAI_DATA_DIR = coaiData;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  delete env.AGENT_RELAY_DEVTOOLS;
  return env;
}

async function launch(profile: string, coaiData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    executablePath: electronExecutable,
    args: ['--disable-gpu', builtMain],
    cwd: repositoryRoot,
    env: applicationEnvironment(profile, coaiData),
    timeout: 30_000
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  return { app, page };
}

function card(page: Page, title: string): Locator {
  return page.locator('.card').filter({ has: page.locator('.card__title', { hasText: title }) }).first();
}

async function configure(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings' }).click();
  const review = card(page, 'External plan review');
  await review.getByRole('checkbox').check();
  await review.getByLabel('MCP executable').fill(live.mcpExecutable);
  await review.getByLabel('MCP arguments').fill('');
  await review.getByLabel('MCP working directory').fill('');
  await review.getByLabel('Conventions repository').fill(live.conventionsRepository);
  await review.getByLabel('Conventions revision').fill(live.conventionsRevision);
  await review.getByLabel('Selected convention files').fill(conventionPaths.join('\n'));
  const save = page.getByRole('button', { name: 'Save settings' });
  await expect.poll(async () => save.isEnabled()).toBe(true);
  await save.click();
  await expect.poll(async () => save.isDisabled()).toBe(true);
}

async function addProjectAndTask(page: Page, repo: string): Promise<void> {
  await page.getByRole('button', { name: 'Projects' }).click();
  const add = card(page, 'Add a project');
  const path = add.getByLabel('Repository folder');
  await path.fill(repo);
  await path.blur();
  await add.getByLabel('Display name').fill('Synthetic plan review');
  const addButton = add.getByRole('button', { name: /Add project/ });
  await expect.poll(async () => addButton.isEnabled()).toBe(true);
  await addButton.click();
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();

  const task = card(page, 'New task');
  await task.getByLabel('Title').fill('Add safe division');
  await task.getByLabel('What do you want done?').fill(
    'Add a pure divide(left, right) function beside add. Division by zero must throw an explicit error. Add deterministic tests for successful division and the zero-divisor rejection. Do not add dependencies or change unrelated files.'
  );
  const create = task.getByRole('button', { name: /Create task/ });
  await expect.poll(async () => create.isEnabled()).toBe(true);
  await create.click();
  await page.getByRole('button', { name: /Capture and bind rules/ }).waitFor();
}

async function resolveGate(panel: Locator): Promise<{ status: string; findings: number }> {
  const resolve = panel.getByRole('button', { name: 'Resolve all findings' });
  await resolve.waitFor({ timeout: 30 * 60_000 });

  const findings = panel.locator('.finding');
  const count = await findings.count();
  for (let index = 0; index < count; index += 1) {
    const finding = findings.nth(index);
    await finding.locator('select').selectOption('accept');
    await finding.locator('input').fill('Accepted for the synthetic integration acceptance record.');
  }
  await expect.poll(async () => resolve.isEnabled()).toBe(true);
  await resolve.click();

  const statusTag = panel.locator('.card__actions .tag');
  await expect
    .poll(async () => (await statusTag.textContent())?.trim(), { timeout: 10 * 60_000 })
    .toMatch(/^(proceeded|changes requested)$/);
  return { status: ((await statusTag.textContent()) ?? '').trim(), findings: count };
}

async function exerciseGate(page: Page): Promise<{ status: string; findings: number }> {
  const panel = card(page, 'External plan review');
  await panel.getByRole('button', { name: /Capture and bind rules/ }).click();
  await panel.getByText('Captured files and omissions').waitFor();
  await expect.poll(async () => panel.textContent()).toContain('AGENTS.md');
  for (const path of conventionPaths) {
    await expect.poll(async () => panel.textContent()).toContain(basename(path));
  }

  await page.getByRole('button', { name: 'Generate specification' }).click();
  await page.getByRole('button', { name: 'Regenerate specification' }).waitFor({ timeout: 10 * 60_000 });
  const prematureApproval = page.getByRole('button', { name: 'Approve specification' });
  await prematureApproval.click();
  await page.getByText(/has not passed its external plan review/i).waitFor();
  expect(await page.getByRole('button', { name: 'Specification approved ✓' }).count()).toBe(0);

  await panel.getByRole('button', { name: /Prepare isolated review branch/ }).click();
  await panel.getByRole('button', { name: 'Run external plan review' }).waitFor();
  await panel.getByRole('button', { name: 'Run external plan review' }).click();
  return resolveGate(panel);
}

async function openExistingTask(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Projects' }).click();
  await page.getByRole('button', { name: /Synthetic plan review/ }).click();
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: /Add safe division/ }).click();
  await page.getByRole('button', { name: 'Run' }).click();
  return card(page, 'External plan review');
}

interface PersistedEvidence {
  readonly profile: string;
  readonly repository: string;
  readonly taskCount: number;
  readonly evidenceCount: number;
  readonly gateCount: number;
  readonly gateStatus: string;
  readonly sessionId: string;
  readonly serverName: string;
  readonly serverVersion: string;
  readonly findings: number;
  readonly conventionRevision: string;
  readonly ruleFiles: string[];
}

function inspect(profile: string, repo: string): PersistedEvidence {
  const db = new DatabaseSync(join(profile, 'agent-relay.sqlite'), { readOnly: true });
  try {
    const scalar = (sql: string): number => Number((db.prepare(sql).get() as { n: number }).n);
    const gate = db.prepare(
      `SELECT status, session_id, server_name, server_version, findings_json
         FROM plan_review_gates ORDER BY created_at DESC, rowid DESC LIMIT 1`
    ).get() as {
      status: string;
      session_id: string;
      server_name: string;
      server_version: string;
      findings_json: string;
    };
    const snapshotRow = db.prepare('SELECT snapshot_json FROM task_rule_evidence LIMIT 1').get() as {
      snapshot_json: string;
    };
    const snapshot = JSON.parse(snapshotRow.snapshot_json) as {
      sources: Array<{ id: string; revision: string }>;
      files: Array<{ sourceId: string; path: string }>;
    };
    const convention = snapshot.sources.find((source) => source.id === 'conventions');
    if (!convention) throw new Error('The persisted rule snapshot has no conventions source.');
    return {
      profile,
      repository: repo,
      taskCount: scalar('SELECT COUNT(*) AS n FROM tasks'),
      evidenceCount: scalar('SELECT COUNT(*) AS n FROM task_rule_evidence'),
      gateCount: scalar('SELECT COUNT(*) AS n FROM plan_review_gates'),
      gateStatus: gate.status,
      sessionId: gate.session_id,
      serverName: gate.server_name,
      serverVersion: gate.server_version,
      findings: (JSON.parse(gate.findings_json) as unknown[]).length,
      conventionRevision: convention.revision,
      ruleFiles: snapshot.files.map((file) => `${file.sourceId}:${file.path}`)
    };
  } finally {
    db.close();
  }
}

describe('live external plan-review acceptance', () => {
  it('runs and persists one isolated real-provider plan-review round', async () => {
    for (const path of [live.mcpExecutable, live.coaiSettings, live.conventionsRepository]) {
      if (!existsSync(path)) throw new Error(`Required live input does not exist: ${path}`);
    }
    const root = live.resumeRoot ?? mkdtempSync(join(tmpdir(), 'agent-relay-live-plan-review-'));
    const profile = join(root, 'profile');
    const coaiData = join(root, 'coai');
    const repo = join(root, 'project');
    if (live.resumeRoot) {
      for (const path of [profile, coaiData, repo]) {
        if (!existsSync(path)) throw new Error(`Cannot resume live acceptance; missing path: ${path}`);
      }
    } else {
      mkdirSync(profile, { recursive: true });
      mkdirSync(coaiData, { recursive: true });
      copySafeCoaiSettings(live.coaiSettings, join(coaiData, 'settings.json'));
      createSyntheticRepository(root);
    }

    let running: ElectronApplication | null = null;
    let completed = false;
    try {
      const resumed = live.resumeRoot ? inspect(profile, repo) : null;
      let ui: { status: string; findings: number };
      if (resumed && resumed.gateStatus !== 'awaiting_resolve') {
        ui = { status: resumed.gateStatus.replace('_', ' '), findings: resumed.findings };
      } else {
        const first = await launch(profile, coaiData);
        running = first.app;
        ui = live.resumeRoot
          ? await resolveGate(await openExistingTask(first.page))
          : await (async () => {
              await configure(first.page);
              await addProjectAndTask(first.page, repo);
              return exerciseGate(first.page);
            })();
        await running.close();
        running = null;
      }

      const persisted = inspect(profile, repo);
      expect(persisted.taskCount).toBe(1);
      expect(persisted.evidenceCount).toBe(1);
      expect(persisted.gateCount).toBe(1);
      expect(persisted.gateStatus.replace('_', ' ')).toBe(ui.status);
      expect(persisted.findings).toBe(ui.findings);
      expect(persisted.sessionId.length).toBeGreaterThan(0);
      expect(persisted.serverName).toBe('connect-other-ais');
      expect(persisted.serverVersion.length).toBeGreaterThan(0);
      expect(persisted.conventionRevision).toBe(live.conventionsRevision);
      expect(persisted.ruleFiles).toContain('project:AGENTS.md');
      for (const path of conventionPaths) expect(persisted.ruleFiles).toContain(`conventions:${path}`);

      const second = await launch(profile, coaiData);
      running = second.app;
      const panel = await openExistingTask(second.page);
      await expect.poll(async () => panel.textContent()).toContain(ui.status);
      await running.close();
      running = null;

      writeFileSync(join(root, 'acceptance-evidence.json'), JSON.stringify(persisted, null, 2) + '\n');
      console.log(`LIVE_PLAN_REVIEW_EVIDENCE=${join(root, 'acceptance-evidence.json')}`);
      console.log(JSON.stringify({ ...persisted, profile: '<temporary>', repository: '<synthetic>' }, null, 2));
      completed = true;
    } finally {
      if (running) await running.close().catch(() => undefined);
      if (!live.keepArtifacts && completed) rmSync(root, { recursive: true, force: true });
      else console.log(`LIVE_PLAN_REVIEW_ARTIFACTS=${root}`);
    }
  });
});
