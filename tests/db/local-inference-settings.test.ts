import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSettings } from '../../src/main/container';
import { closeDatabase, openDatabase } from '../../src/main/db/database';
import { MIGRATIONS, runMigrations } from '../../src/main/db/migrations';
import { SqliteSettingsRepository } from '../../src/main/db/repositories/settings-repository';
import { createSqliteDatabase } from '../../src/main/db/sqlite';
import { defaultLocalInferenceSettings } from '../../src/shared/domain/local-inference';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDatabase(): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), 'agent-relay-local-settings-'));
  roots.push(root);
  return { root, file: join(root, 'agent-relay.sqlite') };
}

const defaults = () => defaultSettings({ dataDir: 'C:\\data', documentsDir: 'C:\\docs' });

describe('migration 9', () => {
  it('is appended after unchanged migrations 1 through 8 and seeds only an absent row', () => {
    expect(MIGRATIONS.map(({ version, name }) => ({ version, name }))).toEqual([
      { version: 1, name: 'initial-schema' },
      { version: 2, name: 'task-model-selection' },
      { version: 3, name: 'operations-targets' },
      { version: 4, name: 'plan-review-gate' },
      { version: 5, name: 'plan-review-external-reconciliation' },
      { version: 6, name: 'plan-review-gate-revision' },
      { version: 7, name: 'code-review-evidence' },
      { version: 8, name: 'task-provider-routing' },
      { version: 9, name: 'local-inference-settings' },
      { version: 10, name: 'task-continuations' }
    ]);

    const db = createSqliteDatabase(':memory:');
    db.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
    )`);
    for (const migration of MIGRATIONS.slice(0, 8)) {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        '2026-09-11T00:00:00.000Z'
      );
    }

    const existing = { ...defaultLocalInferenceSettings(), port: 23456 };
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
      'localInference',
      JSON.stringify(existing)
    );
    expect(runMigrations(db)).toBe(2);
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('localInference') as {
      value: string;
    };
    expect(JSON.parse(row.value)).toEqual(existing);
    db.close();

    const fresh = openDatabase({ file: ':memory:' });
    const seeded = fresh.prepare('SELECT value FROM settings WHERE key = ?').get('localInference') as {
      value: string;
    };
    expect(JSON.parse(seeded.value)).toEqual(defaultLocalInferenceSettings());
    closeDatabase(fresh);
  });
});

describe('local-inference Settings persistence', () => {
  it('returns shipped defaults and falls back only the malformed local field', () => {
    const db = openDatabase({ file: ':memory:' });
    const repository = new SqliteSettingsRepository(db, defaults());
    expect(repository.get().localInference).toEqual(defaultLocalInferenceSettings());

    repository.update({ githubOwner: 'kept-owner', localInference: { ...defaultLocalInferenceSettings(), port: 18080 } });
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('{bad json', 'localInference');
    expect(repository.get().localInference).toEqual(defaultLocalInferenceSettings());
    expect(repository.get().githubOwner).toBe('kept-owner');

    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(
      JSON.stringify({ ...defaultLocalInferenceSettings(), port: 0 }),
      'localInference'
    );
    expect(repository.get().localInference).toEqual(defaultLocalInferenceSettings());
    expect(repository.get().githubOwner).toBe('kept-owner');
    closeDatabase(db);
  });

  it('rejects a mixed valid/invalid patch without writing any part', () => {
    const db = openDatabase({ file: ':memory:' });
    const repository = new SqliteSettingsRepository(db, defaults());
    expect(() =>
      repository.update({
        githubOwner: 'must-not-land',
        localInference: { ...defaultLocalInferenceSettings(), port: 0 }
      })
    ).toThrow(/not valid/i);
    expect(repository.get().githubOwner).toBe(defaults().githubOwner);
    expect(repository.get().localInference).toEqual(defaultLocalInferenceSettings());
    closeDatabase(db);
  });

  it.each([
    {
      label: 'explicit executable and path model',
      localInference: {
        ...defaultLocalInferenceSettings(),
        executable: { kind: 'explicit_path' as const, path: 'C:\\tools\\llama-server.exe' },
        model: { id: 'path-model', source: { kind: 'path' as const, path: 'C:\\models\\model.gguf' } },
        fixedArguments: ['--threads', '3'],
        port: 19001
      }
    },
    {
      label: 'discovered executable and runtime-id model',
      localInference: {
        ...defaultLocalInferenceSettings(),
        model: {
          id: 'runtime-model',
          source: { kind: 'runtime_id' as const, runtimeModelId: 'runtime-model-q4' }
        },
        fixedArguments: ['--threads=4'],
        port: 19002
      }
    }
  ])('round-trips $label across SQLite reopen', ({ localInference }) => {
    const { file } = tempDatabase();
    let db = openDatabase({ file });
    new SqliteSettingsRepository(db, defaults()).update({ localInference });
    closeDatabase(db);

    db = openDatabase({ file });
    expect(new SqliteSettingsRepository(db, defaults()).get().localInference).toEqual(localInference);
    closeDatabase(db);
  });
});
