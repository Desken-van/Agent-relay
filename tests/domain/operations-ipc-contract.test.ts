/**
 * The Operations IPC surface.
 *
 * The renderer names a channel and supplies a payload; it never supplies work.
 * These tests are mostly about the second half of that sentence — every shape
 * through which a statement, a command or an executable path could arrive is
 * checked, and every one of them is refused before a handler body could run.
 */

import { describe, expect, it } from 'vitest';
import { IPC_CHANNELS, ipcInputSchemas, isIpcChannel } from '../../src/shared/ipc';
import { OPERATION_CONFIG_VERSION } from '../../src/shared/domain/operations';
import { DIAGNOSTIC_LIMITS, DIAGNOSTIC_PROBE_IDS } from '../../src/shared/domain/operations-diagnostics';

const OPERATIONS_CHANNELS = [
  'operations:listTargets',
  'operations:getTarget',
  'operations:createTarget',
  'operations:updateTarget',
  'operations:deleteTarget',
  'operations:listDiagnostics',
  'operations:runDiagnostic'
] as const;

const validConfig = {
  version: OPERATION_CONFIG_VERSION,
  adapterType: 'local_sqlite',
  databasePath: 'C:\\data\\reports.sqlite'
};

/**
 * Absolute paths that happen to point at a program.
 *
 * Kept as named constants because the two tests below disagree about them on
 * purpose: they are valid paths, and the schema says so — what makes that safe
 * is that nothing ever executes the value.
 */
const EXECUTABLE_WINDOWS_PATH = 'C:\\Windows\\System32\\cmd.exe';
const EXECUTABLE_POSIX_PATH = '/bin/sh';

/** Things that would each be a way to send work rather than name it. */
const SMUGGLING_ATTEMPTS = [
  'SELECT * FROM users',
  "'; DROP TABLE invoices; --",
  'PRAGMA writable_schema = ON',
  'ATTACH DATABASE "/etc/passwd" AS leak',
  'node -e "require(\'child_process\').exec(\'whoami\')"',
  EXECUTABLE_WINDOWS_PATH,
  EXECUTABLE_POSIX_PATH,
  '../../../etc/passwd',
  '$(whoami)',
  '`id`'
];

describe('the Operations channels', () => {
  it('are all registered and all validated', () => {
    for (const channel of OPERATIONS_CHANNELS) {
      expect(IPC_CHANNELS).toContain(channel);
      expect(isIpcChannel(channel)).toBe(true);
      expect(ipcInputSchemas[channel]).toBeDefined();
    }
  });

  it('are the only Operations channels there are', () => {
    const registered = IPC_CHANNELS.filter((channel) => channel.startsWith('operations:'));
    expect(registered.sort()).toEqual([...OPERATIONS_CHANNELS].sort());
  });

  it('name no arbitrary-execution operation, anywhere in the contract', () => {
    // Two existing channels are deliberately not counted. `publish:execute`
    // performs one of four *named* actions the user has approved, and
    // `diagnostics:run` refreshes the tool diagnostics — neither runs anything
    // the renderer supplied. What must not exist is an operation whose whole
    // purpose is to execute input.
    for (const channel of IPC_CHANNELS) {
      expect(channel).not.toMatch(/:(exec|eval|sql|query|runCommand|shell|spawn)$/i);
    }
  });
});

describe('operations:createTarget', () => {
  const schema = ipcInputSchemas['operations:createTarget'];

  it('accepts a well-formed target', () => {
    const parsed = schema.parse({ name: 'Reports', environment: 'local', config: validConfig });
    expect(parsed.config.adapterType).toBe('local_sqlite');
  });

  it('refuses an adapter type outside the enum, however it is spelled', () => {
    for (const adapterType of ['postgres', './adapter.js', 'local_sqlite;drop', 'LOCAL_SQLITE']) {
      expect(
        schema.safeParse({
          name: 'Reports',
          environment: 'local',
          config: { ...validConfig, adapterType }
        }).success
      ).toBe(false);
    }
  });

  it('refuses a credential value, and a credential reference this adapter has no use for', () => {
    const token = ['gh', 'p', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
    for (const credentialRef of [token, 'PASSWORD=hunter2', 'postgres://u:p@h/db', 'vault:anything']) {
      expect(
        schema.safeParse({ name: 'Reports', environment: 'local', config: validConfig, credentialRef })
          .success
      ).toBe(false);
    }
  });

  it('refuses any extra field, so a secret cannot ride along', () => {
    for (const extra of [
      { password: 'hunter2' },
      { connectionString: 'postgres://u:p@h/db' },
      { command: 'rm -rf /' },
      { adapterModule: './evil.js' }
    ]) {
      expect(
        schema.safeParse({ name: 'Reports', environment: 'local', config: validConfig, ...extra }).success
      ).toBe(false);
      expect(
        schema.safeParse({ name: 'Reports', environment: 'local', config: { ...validConfig, ...extra } })
          .success
      ).toBe(false);
    }
  });

  it('will not accept a statement or a shell fragment where a path belongs', () => {
    const notPaths = SMUGGLING_ATTEMPTS.filter(
      (attempt) => attempt !== EXECUTABLE_WINDOWS_PATH && attempt !== EXECUTABLE_POSIX_PATH
    );

    for (const databasePath of notPaths) {
      expect(
        schema.safeParse({
          name: 'Reports',
          environment: 'local',
          config: { ...validConfig, databasePath }
        }).success
      ).toBe(false);
    }
  });

  it('accepts an absolute path to anything, because a path is all it ever is', () => {
    // A path to an executable is a valid absolute path, and the schema says so.
    // That is not a hole: the only thing done with this value is to hand it to
    // SQLite to open read-only. Nothing anywhere executes it, and the probe
    // request has no field that could carry an executable — see the probe suite,
    // which asserts the spawned argv is the fixed script and nothing else.
    for (const databasePath of [EXECUTABLE_WINDOWS_PATH, EXECUTABLE_POSIX_PATH]) {
      expect(
        schema.safeParse({
          name: 'Reports',
          environment: 'local',
          config: { ...validConfig, databasePath }
        }).success
      ).toBe(true);
    }
  });
});

describe('operations:updateTarget', () => {
  const schema = ipcInputSchemas['operations:updateTarget'];

  it('accepts a patch to a target by id', () => {
    expect(schema.parse({ targetId: 't1', patch: { enabled: false } })).toEqual({
      targetId: 't1',
      patch: { enabled: false }
    });
  });

  it('refuses an empty patch, an unknown field, and a changed identity', () => {
    expect(schema.safeParse({ targetId: 't1', patch: {} }).success).toBe(false);
    expect(schema.safeParse({ targetId: 't1', patch: { id: 't2' } }).success).toBe(false);
    expect(schema.safeParse({ targetId: 't1', patch: { adapterType: 'local_sqlite' } }).success).toBe(false);
    expect(schema.safeParse({ targetId: '', patch: { enabled: true } }).success).toBe(false);
  });
});

describe('operations:runDiagnostic', () => {
  const schema = ipcInputSchemas['operations:runDiagnostic'];

  it('accepts a registered probe id', () => {
    for (const probeId of DIAGNOSTIC_PROBE_IDS) {
      expect(schema.parse({ targetId: 't1', probeId }).probeId).toBe(probeId);
    }
  });

  it('refuses anything that is not one, including every shape of smuggled work', () => {
    for (const probeId of [...SMUGGLING_ATTEMPTS, 'row_dump', '', 'connection_health ']) {
      expect(schema.safeParse({ targetId: 't1', probeId }).success).toBe(false);
    }
  });

  it('has no field for a statement, a command or an executable', () => {
    for (const extra of [
      { sql: 'SELECT 1' },
      { query: 'SELECT 1' },
      { command: 'whoami' },
      { executablePath: '/bin/sh' },
      { adapterType: 'local_sqlite' },
      { databasePath: '/var/lib/x.sqlite' }
    ]) {
      expect(schema.safeParse({ targetId: 't1', probeId: 'connection_health', ...extra }).success).toBe(
        false
      );
    }
  });

  it('bounds the options a caller may choose, in both directions', () => {
    expect(
      schema.parse({ targetId: 't1', probeId: 'schema_summary', options: { maxTables: 10 } }).options
    ).toEqual({ maxTables: 10 });

    for (const options of [
      { maxTables: 0 },
      { maxTables: DIAGNOSTIC_LIMITS.maxTables.max + 1 },
      { timeoutMs: 1 },
      { timeoutMs: DIAGNOSTIC_LIMITS.timeoutMs.max + 1 },
      { maxOutputBytes: DIAGNOSTIC_LIMITS.maxOutputBytes.max + 1 },
      { unlimited: true },
      { maxTables: null }
    ]) {
      expect(schema.safeParse({ targetId: 't1', probeId: 'connection_health', options }).success).toBe(
        false
      );
    }
  });
});

describe('the read-only channels', () => {
  it('take an id and nothing else', () => {
    for (const channel of ['operations:getTarget', 'operations:deleteTarget'] as const) {
      const schema = ipcInputSchemas[channel];
      expect(schema.parse({ targetId: 't1' })).toEqual({ targetId: 't1' });
      expect(schema.safeParse({ targetId: 't1', force: true }).success).toBe(false);
      expect(schema.safeParse({}).success).toBe(false);
    }
  });

  it('bound the history a caller may pull back', () => {
    const schema = ipcInputSchemas['operations:listDiagnostics'];
    expect(schema.parse({ targetId: 't1', limit: 10 }).limit).toBe(10);
    expect(schema.safeParse({ targetId: 't1', limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ targetId: 't1', limit: 100_000 }).success).toBe(false);
  });

  it('takes no input at all for the list', () => {
    expect(ipcInputSchemas['operations:listTargets'].parse({})).toEqual({});
    expect(ipcInputSchemas['operations:listTargets'].safeParse({ all: true }).success).toBe(false);
  });
});
