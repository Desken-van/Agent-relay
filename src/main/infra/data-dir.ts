/**
 * Resolution of the `AGENT_RELAY_DATA_DIR` override.
 *
 * The override exists so a test run can be pointed at a throwaway directory
 * instead of the real profile. For that to mean anything it has to redirect
 * *everything* the application writes — not only Agent Relay's own SQLite
 * database and worktrees, but Electron's Chromium profile too, which otherwise
 * keeps writing `Preferences`, `Network`, storage and the single-instance lock
 * into the default `userData` directory.
 *
 * There is deliberately one resolver, used both for `app.setPath('userData')`
 * and for the database path. Two resolvers could disagree — for example about a
 * relative path — and the run would end up split across two locations.
 */

import { mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { AgentRelayError } from '../../shared/domain/errors';

export const DATA_DIR_ENV_VAR = 'AGENT_RELAY_DATA_DIR';

/**
 * The override as an absolute path, or null when it is unset or blank.
 *
 * Pure: no filesystem access, so it is safe to call before the app is ready and
 * straightforward to test.
 */
export function resolveDataDirOverride(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[DATA_DIR_ENV_VAR];
  if (typeof raw !== 'string') return null;

  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // A relative value is resolved against the working directory rather than
  // rejected: it is a developer convenience, and leaving it relative would let
  // two callers resolve it differently. `resolve` also normalises an absolute
  // path, so both cases go through the same call.
  return resolve(trimmed);
}

/**
 * Resolve the override and make sure it is usable as a directory.
 *
 * @returns the absolute directory, or null when no override is set.
 * @throws {AgentRelayError} when the override is set but cannot be used. This is
 *   deliberately loud: silently falling back to the default profile would write
 *   test data into the user's real one, which is the exact thing the override
 *   exists to prevent.
 */
export function prepareDataDirOverride(env: NodeJS.ProcessEnv = process.env): string | null {
  const target = resolveDataDirOverride(env);
  if (target === null) return null;

  try {
    mkdirSync(target, { recursive: true });
  } catch (error) {
    throw new AgentRelayError(
      'VALIDATION_FAILED',
      `${DATA_DIR_ENV_VAR} could not be created: ${target}`,
      {
        remediation: `Point ${DATA_DIR_ENV_VAR} at a writable directory, or unset it to use the default profile.`,
        details: error instanceof Error ? error.message : String(error),
        cause: error
      }
    );
  }

  // `mkdirSync(…, { recursive: true })` succeeds silently when the path is
  // already a directory, but a path that exists as a *file* fails above on some
  // platforms and not others. Check explicitly so the message is the same
  // everywhere.
  if (!statSync(target).isDirectory()) {
    throw new AgentRelayError(
      'VALIDATION_FAILED',
      `${DATA_DIR_ENV_VAR} is not a directory: ${target}`,
      {
        remediation: `Point ${DATA_DIR_ENV_VAR} at a directory, or unset it to use the default profile.`
      }
    );
  }

  return target;
}
