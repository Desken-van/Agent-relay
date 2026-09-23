import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultSettings } from '../../src/main/container';
import { closeDatabase, openDatabase } from '../../src/main/db/database';
import { MIGRATIONS, runMigrations } from '../../src/main/db/migrations';
import { SqliteSettingsRepository } from '../../src/main/db/repositories/settings-repository';
import { createSqliteDatabase } from '../../src/main/db/sqlite';
import {
  defaultLocalInferenceSettings,
  type LocalInferenceProfilesSettings
} from '../../src/shared/domain/local-inference';

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

/** The shipped default with its one profile's runtime config patched, leaving id/displayName alone. */
function withDefaultProfile(
  patch: Partial<LocalInferenceProfilesSettings['profiles'][number]>
): LocalInferenceProfilesSettings {
  const base = defaultLocalInferenceSettings();
  return {
    ...base,
    profiles: base.profiles.map((profile) =>
      profile.id === base.defaultProfileId ? { ...profile, ...patch } : profile
    )
  };
}

describe('migrations 9 and 11 through 22', () => {
  it('are appended after unchanged migrations and preserve the local-inference row', () => {
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
      { version: 10, name: 'task-continuations' },
      { version: 11, name: 'local-inference-request-defaults' },
      { version: 12, name: 'ornith-provider' },
      { version: 13, name: 'review-limit-status' },
      { version: 14, name: 'review-blocked-status' },
      { version: 15, name: 'ornith-provider-version-collision-repair' },
      { version: 16, name: 'coai-contract-fingerprint' },
      { version: 17, name: 'plan-review-triage' },
      { version: 18, name: 'code-review-triage' },
      { version: 19, name: 'plan-auto-decisions-and-corrections' },
      { version: 20, name: 'plan-review-isolated-subjects' },
      { version: 21, name: 'local-inference-profiles' },
      { version: 22, name: 'ornith-model-profile' }
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

    // A row already in the current (profile) shape: 9, 11 and 21 all leave it untouched — 21's own
    // upgrade function returns an already-valid row unchanged rather than re-wrapping it.
    const existing = withDefaultProfile({ port: 23456 });
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
      'localInference',
      JSON.stringify(existing)
    );
    expect(runMigrations(db)).toBe(14);
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

  it('upgrades a genuine pre-B2 legacy row while preserving unrelated settings', () => {
    const db = createSqliteDatabase(':memory:');
    db.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
    )`);
    for (const migration of MIGRATIONS.slice(0, 10)) {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        '2026-09-11T00:00:00.000Z'
      );
    }

    const legacy = {
      version: 1,
      executable: { kind: 'explicit_path', path: 'C:\\tools\\llama-server.exe' },
      model: { id: 'legacy-model', source: { kind: 'path', path: 'C:\\models\\legacy.gguf' } },
      fixedArguments: ['--threads', '4'],
      port: 18080,
      contextLimitTokens: 2048,
      startupTimeoutMs: 10_000,
      healthTimeoutMs: 2_000,
      inferenceTimeoutMs: 20_000,
      shutdownTimeoutMs: 5_000
    };
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(
      JSON.stringify(legacy),
      'localInference'
    );
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
      'githubOwner',
      JSON.stringify('kept-across-migration')
    );

    expect(runMigrations(db)).toBe(12);

    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('localInference') as {
      value: string;
    };
    const upgraded = JSON.parse(row.value) as LocalInferenceProfilesSettings;
    const profile = upgraded.profiles.find((candidate) => candidate.id === upgraded.defaultProfileId);
    expect(profile).toBeDefined();
    expect(profile?.executable).toEqual(legacy.executable);
    expect(profile?.model).toEqual(legacy.model);
    expect(profile?.fixedArguments).toEqual(legacy.fixedArguments);
    expect(profile?.port).toBe(legacy.port);
    expect(profile?.contextLimitTokens).toBe(legacy.contextLimitTokens);
    expect(profile?.startupTimeoutMs).toBe(legacy.startupTimeoutMs);
    expect(upgraded.enabled).toBe(false);
    expect(profile?.requestDefaults).toEqual({ maxOutputTokens: 2048, chatTemplateParameters: {} });

    const owner = db.prepare('SELECT value FROM settings WHERE key = ?').get('githubOwner') as {
      value: string;
    };
    expect(JSON.parse(owner.value)).toBe('kept-across-migration');
    db.close();
  });

  it('falls back to the shipped default for a malformed legacy row rather than leaving it broken', () => {
    const db = createSqliteDatabase(':memory:');
    db.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
    )`);
    for (const migration of MIGRATIONS.slice(0, 10)) {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        '2026-09-11T00:00:00.000Z'
      );
    }
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('{not valid json', 'localInference');

    expect(runMigrations(db)).toBe(12);
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('localInference') as {
      value: string;
    };
    const upgraded = JSON.parse(row.value) as LocalInferenceProfilesSettings;
    const profile = upgraded.profiles.find((candidate) => candidate.id === upgraded.defaultProfileId);
    expect(profile).toBeDefined();
    // Every runtime-config field matches the shipped single-config default; only the display name differs
    // — migration 21's upgrade path derives it from the (fallback) model id rather than the shipped label.
    const shippedProfile = defaultLocalInferenceSettings().profiles[0];
    expect({ ...profile, displayName: shippedProfile?.displayName }).toEqual(shippedProfile);
    db.close();
  });
});

describe('local-inference Settings persistence', () => {
  it('returns shipped defaults and falls back only the malformed local field', () => {
    const db = openDatabase({ file: ':memory:' });
    const repository = new SqliteSettingsRepository(db, defaults());
    expect(repository.get().localInference).toEqual(defaultLocalInferenceSettings());

    repository.update({ githubOwner: 'kept-owner', localInference: withDefaultProfile({ port: 18080 }) });
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('{bad json', 'localInference');
    expect(repository.get().localInference).toEqual(defaultLocalInferenceSettings());
    expect(repository.get().githubOwner).toBe('kept-owner');

    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(
      JSON.stringify(withDefaultProfile({ port: 0 })),
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
        localInference: withDefaultProfile({ port: 0 })
      })
    ).toThrow(/not valid/i);
    expect(repository.get().githubOwner).toBe(defaults().githubOwner);
    expect(repository.get().localInference).toEqual(defaultLocalInferenceSettings());
    closeDatabase(db);
  });

  it.each([
    {
      label: 'explicit executable and path model',
      localInference: withDefaultProfile({
        executable: { kind: 'explicit_path' as const, path: 'C:\\tools\\llama-server.exe' },
        model: { id: 'path-model', source: { kind: 'path' as const, path: 'C:\\models\\model.gguf' } },
        fixedArguments: ['--threads', '3'],
        port: 19001
      })
    },
    {
      label: 'discovered executable and runtime-id model',
      localInference: withDefaultProfile({
        model: {
          id: 'runtime-model',
          source: { kind: 'runtime_id' as const, runtimeModelId: 'runtime-model-q4' }
        },
        fixedArguments: ['--threads=4'],
        port: 19002
      })
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
