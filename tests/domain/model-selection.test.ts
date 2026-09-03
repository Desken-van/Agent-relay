import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ThreadOptions } from '@openai/codex-sdk';
import {
  buildThreadOptions,
  openThread,
  type CodexThreadOpener
} from '../../src/main/adapters/codex/codex-adapter';
import { defaultSettings } from '../../src/main/container';
import { openDatabase, closeDatabase, type Db } from '../../src/main/db/database';
import { MIGRATIONS, runMigrations } from '../../src/main/db/migrations';
import { SqliteTaskRepository } from '../../src/main/db/repositories/task-repository';
import { SystemClock } from '../../src/main/infra/clock';
import { CLAUDE_MODEL_ALIASES, modelIdSchema, type Settings } from '../../src/shared/domain/models';
import { ipcInputSchemas } from '../../src/shared/ipc';

/** Control characters built at runtime — never embed raw bytes in a source file. */
const NUL = String.fromCharCode(0);
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const TAB = String.fromCharCode(9);

const DEFAULTS: Settings = defaultSettings({ dataDir: 'C:\\data', documentsDir: 'C:\\docs' });

/* -------------------------------------------------------------------------- */
/* Migration                                                                   */
/* -------------------------------------------------------------------------- */

describe('migration v2 — task-model-selection', () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-relay-migrate-'));
    db = openDatabase({ file: join(dir, 'test.sqlite') });
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('is registered as version 2 and applied on top of version 1', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    // Forward-only: later migrations may be appended, but 1 and 2 keep their
    // places and their names.
    expect(versions.slice(0, 2)).toEqual([1, 2]);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(MIGRATIONS[1]?.name).toBe('task-model-selection');
  });

  it('adds both columns to a database that only has version 1', () => {
    // Simulate an existing install: apply v1 only, insert a task the old way,
    // then let the migration runner catch it up.
    db.exec('DELETE FROM schema_migrations WHERE version = 2');
    db.exec('ALTER TABLE tasks DROP COLUMN codex_model');
    db.exec('ALTER TABLE tasks DROP COLUMN claude_model');

    db.prepare(
      `INSERT INTO projects (id, name, local_path, project_type, default_branch,
                             github_owner, github_repo, github_visibility, created_at, updated_at)
       VALUES ('p1','Old','C:\\old','existing','main',NULL,NULL,'private','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, project_id, title, original_request, status, current_round, max_rounds,
                          created_at, updated_at)
       VALUES ('t1','p1','Legacy task','do it','DRAFT',0,3,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`
    ).run();

    expect(runMigrations(db)).toBe(1);

    const repo = new SqliteTaskRepository(db, new SystemClock());
    const legacy = repo.findById('t1');

    // The whole point: an old task still loads, with no override recorded.
    expect(legacy).not.toBeNull();
    expect(legacy?.title).toBe('Legacy task');
    expect(legacy?.codexModel).toBeNull();
    expect(legacy?.claudeModel).toBeNull();
  });

  it('is idempotent when run again', () => {
    expect(runMigrations(db)).toBe(0);
    const applied = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
    expect(applied).toHaveLength(MIGRATIONS.length);
  });
});

/* -------------------------------------------------------------------------- */
/* Persistence                                                                 */
/* -------------------------------------------------------------------------- */

describe('task model persistence', () => {
  let dir: string;
  let db: Db;
  let repo: SqliteTaskRepository;

  const seed = (codexModel: string | null, claudeModel: string | null): string => {
    db.prepare(
      `INSERT OR IGNORE INTO projects (id, name, local_path, project_type, default_branch,
                                       github_owner, github_repo, github_visibility, created_at, updated_at)
       VALUES ('p1','P','C:\\p','existing','main',NULL,NULL,'private','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`
    ).run();
    const id = `t${Math.random().toString(36).slice(2, 10)}`;
    repo.create({
      id,
      projectId: 'p1',
      title: 'T',
      originalRequest: 'r',
      status: 'DRAFT',
      currentRound: 0,
      maxRounds: 3,
      codexThreadId: null,
      claudeSessionId: null,
      worktreePath: null,
      branchName: null,
      baseBranch: null,
      specificationJson: null,
      specificationApprovedAt: null,
      lastReviewJson: null,
      lastError: null,
      codexModel,
      claudeModel
    });
    return id;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-relay-models-'));
    db = openDatabase({ file: join(dir, 'test.sqlite') });
    repo = new SqliteTaskRepository(db, new SystemClock());
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips both models', () => {
    const id = seed('gpt-5.6-sol', 'opus');
    const task = repo.findById(id);
    expect(task?.codexModel).toBe('gpt-5.6-sol');
    expect(task?.claudeModel).toBe('opus');
  });

  it('round-trips nulls as nulls, not empty strings', () => {
    const task = repo.findById(seed(null, null));
    expect(task?.codexModel).toBeNull();
    expect(task?.claudeModel).toBeNull();
  });

  it('supports a mixed pair', () => {
    const task = repo.findById(seed(null, 'fable'));
    expect(task?.codexModel).toBeNull();
    expect(task?.claudeModel).toBe('fable');
  });

  it('keeps the models across an unrelated update', () => {
    const id = seed('gpt-5.5', 'sonnet');
    repo.update(id, { status: 'SPECIFYING', codexThreadId: 'thread-1' });

    const task = repo.findById(id);
    expect(task?.codexModel).toBe('gpt-5.5');
    expect(task?.claudeModel).toBe('sonnet');
    expect(task?.codexThreadId).toBe('thread-1');
  });

  it('lists models through listByProject', () => {
    seed('gpt-5.4', 'haiku');
    const [task] = repo.listByProject('p1');
    expect(task?.codexModel).toBe('gpt-5.4');
    expect(task?.claudeModel).toBe('haiku');
  });

  it('survives close and reopen', () => {
    const file = join(dir, 'durable.sqlite');
    const first = openDatabase({ file });
    const firstRepo = new SqliteTaskRepository(first, new SystemClock());
    first.prepare(
      `INSERT INTO projects (id, name, local_path, project_type, default_branch,
                             github_owner, github_repo, github_visibility, created_at, updated_at)
       VALUES ('p1','P','C:\\p','existing','main',NULL,NULL,'private','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`
    ).run();
    firstRepo.create({
      id: 'durable',
      projectId: 'p1',
      title: 'T',
      originalRequest: 'r',
      status: 'DRAFT',
      currentRound: 0,
      maxRounds: 3,
      codexThreadId: null,
      claudeSessionId: null,
      worktreePath: null,
      branchName: null,
      baseBranch: null,
      specificationJson: null,
      specificationApprovedAt: null,
      lastReviewJson: null,
      lastError: null,
      codexModel: 'gpt-5.6-terra',
      claudeModel: 'opus'
    });
    closeDatabase(first);

    const second = openDatabase({ file });
    const reopened = new SqliteTaskRepository(second, new SystemClock()).findById('durable');
    expect(reopened?.codexModel).toBe('gpt-5.6-terra');
    expect(reopened?.claudeModel).toBe('opus');
    closeDatabase(second);
  });
});

/* -------------------------------------------------------------------------- */
/* Normalisation and IPC validation                                            */
/* -------------------------------------------------------------------------- */

describe('model id normalisation', () => {
  const parse = (value: unknown): unknown => modelIdSchema.parse(value);

  it('trims surrounding whitespace', () => {
    expect(parse('  gpt-5.6-sol  ')).toBe('gpt-5.6-sol');
  });

  it('turns an empty or whitespace-only value into null', () => {
    expect(parse('')).toBeNull();
    expect(parse('   ')).toBeNull();
  });

  it('passes null through', () => {
    expect(parse(null)).toBeNull();
  });

  it('rejects a value longer than 200 characters', () => {
    expect(() => parse('x'.repeat(201))).toThrow();
    expect(parse('x'.repeat(200))).toBe('x'.repeat(200));
  });

  it('rejects an interior control character', () => {
    expect(() => parse(`gpt${NUL}sol`)).toThrow();
    expect(() => parse('gptsol')).toThrow();
  });

  it('rejects a leading or trailing newline rather than trimming it away', () => {
    // The ordering trap: trimming first would strip these and then declare
    // the value clean, so a control character at the edge would be accepted.
    expect(() => parse(LF + 'gpt-5.5')).toThrow();
    expect(() => parse('gpt-5.5' + LF)).toThrow();
    expect(() => parse(CR + LF + 'gpt-5.5' + CR + LF)).toThrow();
  });

  it('rejects a leading or trailing tab', () => {
    expect(() => parse(TAB + 'gpt-5.5')).toThrow();
    expect(() => parse('gpt-5.5' + TAB)).toThrow();
  });

  it('still trims and accepts ordinary spaces around a valid id', () => {
    expect(parse('   gpt-5.5   ')).toBe('gpt-5.5');
  });

  it('accepts a full model id for a model it has never heard of', () => {
    expect(parse('claude-something-9')).toBe('claude-something-9');
  });
});

describe('tasks:create IPC contract', () => {
  const schema = ipcInputSchemas['tasks:create'];
  const base = { projectId: 'p1', title: 'T', originalRequest: 'r' };

  it('keeps an omitted model undefined, so the service can inherit a default', () => {
    const parsed = schema.parse({ ...base });
    expect('codexModel' in parsed).toBe(false);
    expect(parsed.codexModel).toBeUndefined();
    expect(parsed.claudeModel).toBeUndefined();
  });

  it('keeps an explicit null distinct from an omitted field', () => {
    const parsed = schema.parse({ ...base, codexModel: null, claudeModel: null });
    expect(parsed.codexModel).toBeNull();
    expect(parsed.claudeModel).toBeNull();
  });

  it('trims and normalises supplied values', () => {
    const parsed = schema.parse({ ...base, codexModel: ' gpt-5.5 ', claudeModel: '   ' });
    expect(parsed.codexModel).toBe('gpt-5.5');
    expect(parsed.claudeModel).toBeNull();
  });

  it('rejects a control character and an over-long id', () => {
    expect(() => schema.parse({ ...base, codexModel: `a${NUL}b` })).toThrow();
    expect(() => schema.parse({ ...base, claudeModel: 'x'.repeat(201) })).toThrow();
  });

  it('is strict about unknown fields', () => {
    expect(() => schema.parse({ ...base, modelo: 'typo' })).toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* Codex thread options                                                        */
/* -------------------------------------------------------------------------- */

describe('Codex thread options', () => {
  it('includes the model when the task has one', () => {
    const options = buildThreadOptions('gpt-5.6-sol', { sandboxMode: 'read-only' });
    expect(options.model).toBe('gpt-5.6-sol');
    expect(options.sandboxMode).toBe('read-only');
    expect(options.skipGitRepoCheck).toBe(true);
  });

  it('omits the key entirely when the task has no override', () => {
    const options = buildThreadOptions(null, { sandboxMode: 'read-only' });
    expect('model' in options).toBe(false);
    expect(options.sandboxMode).toBe('read-only');
  });

  it('never lets a model override the read-only sandbox', () => {
    const options = buildThreadOptions('gpt-5.5', {
      sandboxMode: 'read-only',
      networkAccessEnabled: false
    });
    expect(options.sandboxMode).toBe('read-only');
    expect(options.networkAccessEnabled).toBe(false);
  });

});

describe('opening a Codex thread', () => {
  /** Records which method was called, with what. */
  function fakeClient(): {
    client: CodexThreadOpener<string>;
    started: ThreadOptions[];
    resumed: { id: string; options: ThreadOptions }[];
  } {
    const started: ThreadOptions[] = [];
    const resumed: { id: string; options: ThreadOptions }[] = [];
    return {
      started,
      resumed,
      client: {
        startThread(options) {
          started.push(options);
          return 'started';
        },
        resumeThread(id, options) {
          resumed.push({ id, options });
          return 'resumed';
        }
      }
    };
  }

  it('starts a thread exactly once, with the model, when there is no thread id', () => {
    const { client, started, resumed } = fakeClient();
    const options = buildThreadOptions('gpt-5.6-sol', { sandboxMode: 'read-only' });

    expect(openThread(client, null, options)).toBe('started');
    expect(started).toHaveLength(1);
    expect(started[0]?.model).toBe('gpt-5.6-sol');
    expect(started[0]?.sandboxMode).toBe('read-only');
    expect(resumed).toHaveLength(0);
  });

  it('resumes exactly once, with the same model, when a thread id exists', () => {
    const { client, started, resumed } = fakeClient();
    const options = buildThreadOptions('gpt-5.6-sol', { sandboxMode: 'read-only' });

    expect(openThread(client, 'thread-42', options)).toBe('resumed');
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.id).toBe('thread-42');
    expect(resumed[0]?.options.model).toBe('gpt-5.6-sol');
    expect(resumed[0]?.options.sandboxMode).toBe('read-only');
    expect(started).toHaveLength(0);
  });

  it('sends no model key at all on either path when the task has none', () => {
    const fresh = fakeClient();
    openThread(fresh.client, null, buildThreadOptions(null, { sandboxMode: 'read-only' }));
    expect('model' in (fresh.started[0] ?? {})).toBe(false);

    const resumedRun = fakeClient();
    openThread(resumedRun.client, 't1', buildThreadOptions(null, { sandboxMode: 'read-only' }));
    expect('model' in (resumedRun.resumed[0]?.options ?? {})).toBe(false);
  });

  it('keeps the read-only sandbox on a resumed review', () => {
    const { client, resumed } = fakeClient();
    openThread(
      client,
      't1',
      buildThreadOptions('gpt-5.5', { sandboxMode: 'read-only', networkAccessEnabled: false })
    );

    expect(resumed[0]?.options.sandboxMode).toBe('read-only');
    expect(resumed[0]?.options.networkAccessEnabled).toBe(false);
  });
});

describe('Claude model aliases', () => {
  it('offers exactly the four documented aliases, lowercase', () => {
    expect(CLAUDE_MODEL_ALIASES.map((a) => a.value)).toEqual([
      'opus',
      'sonnet',
      'haiku',
      'fable'
    ]);
  });

  it('is a convenience list, not a validation allow-list', () => {
    // A full model id must pass validation even though it is not an alias.
    expect(modelIdSchema.parse('claude-opus-5')).toBe('claude-opus-5');
  });
});

describe('settings defaults', () => {
  it('default to no override for both tools', () => {
    expect(DEFAULTS.codexModel).toBeNull();
    expect(DEFAULTS.claudeModel).toBeNull();
  });
});
