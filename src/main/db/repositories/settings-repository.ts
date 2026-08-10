import { AgentRelayError } from '../../../shared/domain/errors';
import { settingsSchema, type Settings } from '../../../shared/domain/models';
import type { SettingsRepository } from '../../ports';
import type { Db } from '../database';

/**
 * Settings live in a key/value table rather than a single JSON blob so that a
 * schema addition does not invalidate a user's existing configuration: unknown
 * keys are ignored and missing keys fall back to the supplied defaults.
 *
 * Nothing secret is ever stored here. Authentication for Codex, Claude and
 * GitHub is owned by those tools; Agent Relay only records *where* their
 * executables are.
 */
export class SqliteSettingsRepository implements SettingsRepository {
  constructor(
    private readonly db: Db,
    private readonly defaults: Settings
  ) {}

  get(): Settings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as {
      key: string;
      value: string;
    }[];

    const shape = settingsSchema.shape as Record<string, { safeParse(value: unknown): { success: boolean } }>;

    const stored: Record<string, unknown> = {};
    for (const row of rows) {
      let value: unknown;
      try {
        value = JSON.parse(row.value);
      } catch {
        // A corrupted value falls back to the default rather than bricking startup.
        continue;
      }

      // Validate key by key, so one unusable value — a hand-edited row, or a
      // field whose rules tightened in a later version — costs the user that
      // single setting instead of every setting they have ever changed.
      const field = shape[row.key];
      if (!field || !field.safeParse(value).success) continue;

      stored[row.key] = value;
    }

    const merged = { ...this.defaults, ...stored };
    const parsed = settingsSchema.safeParse(merged);

    // If anything stored is out of range (e.g. hand-edited database), fall back
    // to defaults for the whole object rather than running with a bad config.
    return parsed.success ? parsed.data : this.defaults;
  }

  update(patch: Partial<Settings>): Settings {
    const next = settingsSchema.safeParse({ ...this.get(), ...patch });
    if (!next.success) {
      throw new AgentRelayError('VALIDATION_FAILED', 'Those settings are not valid.', {
        details: next.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
      });
    }

    const upsert = this.db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    );

    const write = this.db.transaction((settings: Settings) => {
      for (const [key, value] of Object.entries(settings)) {
        upsert.run(key, JSON.stringify(value));
      }
    });
    write(next.data);

    return next.data;
  }
}
