import {
  resolveVerificationConfig,
  type RuleProblem,
  type VerificationConfigProblem
} from '../../../shared/domain/claude-tool-rules';
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

    // The schema checks each field on its own. Whether the verification rules
    // can actually be used is a question about two fields together, and it has
    // to be answered here rather than in the form: the renderer is a
    // convenience, and a configuration that no round could ever satisfy should
    // not be reachable by any path that writes to this table.
    const configured = resolveVerificationConfig(
      next.data.claudeAllowedTools,
      next.data.claudeVerificationTools
    );
    if (!configured.ok) {
      throw new AgentRelayError(
        'VALIDATION_FAILED',
        'The Claude verification commands cannot be used.',
        {
          remediation:
            'Each rule must be Bash(...) or PowerShell(...), may end in a single *, and must ' +
            'also appear in the pre-approved list.',
          details: configured.problems.map(describeVerificationProblem).join(' ')
        }
      );
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

/** One verification-configuration problem, phrased as something to change. */
function describeVerificationProblem(problem: VerificationConfigProblem): string {
  if (problem.code === 'empty') {
    return 'At least one verification command is required.';
  }
  const rule = problem.rule ?? 'A rule';
  if (problem.code === 'not_allowed') {
    return rule + ' is not in the pre-approved list.';
  }
  return rule + ' ' + RULE_PROBLEMS[problem.detail ?? 'syntax'];
}

/** A total record, so a new kind of bad rule must be given something to say. */
const RULE_PROBLEMS: Record<RuleProblem, string> = {
  syntax: 'is not written as Tool(command).',
  unsupported_tool: 'uses a tool other than Bash(...) or PowerShell(...).',
  empty_body: 'names no command.',
  wildcard: 'may only use a single * as its final character.',
  compound: 'chains commands, which never counts as verification.',
  wrapper: 'runs another command, which cannot be verified.'
};
