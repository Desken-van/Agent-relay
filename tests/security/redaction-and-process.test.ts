import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ExecaProcessRunner,
  runOrThrow
} from '../../src/main/adapters/process/process-runner';
import { redactAndTruncate, redactSecrets, scrubEnvironment } from '../../src/shared/util/redact';
import {
  buildBranchName,
  buildWorktreeDirName,
  isValidBranchName,
  isValidGithubOwner,
  isValidRepoName,
  shortId,
  slugify
} from '../../src/shared/util/slug';
import { ipcInputSchemas, isIpcChannel } from '../../src/shared/ipc';

describe('credential redaction', () => {
  it.each([
    ['ghp_0123456789abcdefghijklmnopqrstuvwxyz', 'classic GitHub PAT'],
    ['gho_0123456789abcdefghijklmnopqrstuvwxyz', 'GitHub OAuth token'],
    ['ghs_0123456789abcdefghijklmnopqrstuvwxyz', 'GitHub App token'],
    ['github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz', 'fine-grained PAT'],
    ['sk-proj-abcdefghijklmnopqrstuvwxyz0123', 'OpenAI-style key'],
    ['sk-ant-api03-abcdefghijklmnopqrstuvwxyz', 'Anthropic-style key']
  ])('redacts %s (%s)', (token) => {
    const redacted = redactSecrets(`the token is ${token} ok`);
    expect(redacted).not.toContain(token);
    expect(redacted).toContain('[redacted]');
  });

  it('redacts a JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g';
    expect(redactSecrets(jwt)).not.toContain('eyJhbGciOi');
  });

  it('redacts Authorization headers', () => {
    expect(redactSecrets('Authorization: Bearer abcdef1234567890xyz')).not.toContain('abcdef1234567890xyz');
  });

  it('redacts credentials embedded in a URL but keeps the host readable', () => {
    const redacted = redactSecrets('remote: https://user:hunter2@github.com/acme/thing.git');
    expect(redacted).not.toContain('hunter2');
    expect(redacted).toContain('github.com/acme/thing.git');
  });

  it('redacts the value of a token-shaped environment variable', () => {
    const redacted = redactSecrets('GITHUB_TOKEN=supersecretvalue\nPATH=/usr/bin');
    expect(redacted).not.toContain('supersecretvalue');
    expect(redacted).toContain('GITHUB_TOKEN=[redacted]');
    expect(redacted).toContain('/usr/bin');
  });

  it('leaves innocent text alone', () => {
    const text = 'Added GET /health returning {"status":"ok"} — 12 tests passed.';
    expect(redactSecrets(text)).toBe(text);
  });

  it('is stable across repeated calls (global regex lastIndex is reset)', () => {
    const input = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
    const first = redactSecrets(input);
    const second = redactSecrets(input);
    expect(first).toBe(second);
    expect(second).not.toContain('ghp_');
  });

  it('redacts before truncating', () => {
    const output = redactAndTruncate(`ghp_0123456789abcdefghijklmnopqrstuvwxyz ${'x'.repeat(500)}`, 60);
    expect(output).not.toContain('ghp_');
    expect(output).toContain('truncated');
  });
});

describe('environment scrubbing', () => {
  it('drops token-shaped variables by default', () => {
    const scrubbed = scrubEnvironment({
      PATH: '/usr/bin',
      GITHUB_TOKEN: 'secret',
      MY_API_KEY: 'secret',
      DB_PASSWORD: 'secret',
      HOME: '/home/user'
    });

    expect(scrubbed.PATH).toBe('/usr/bin');
    expect(scrubbed.HOME).toBe('/home/user');
    expect(scrubbed.GITHUB_TOKEN).toBeUndefined();
    expect(scrubbed.MY_API_KEY).toBeUndefined();
    expect(scrubbed.DB_PASSWORD).toBeUndefined();
  });

  it('lets a tool keep the credential variable it actually owns', () => {
    const scrubbed = scrubEnvironment(
      { GH_TOKEN: 'gh-secret', ANTHROPIC_API_KEY: 'anthropic-secret' },
      ['GH_TOKEN']
    );

    // gh keeps its own token…
    expect(scrubbed.GH_TOKEN).toBe('gh-secret');
    // …but cannot see Anthropic's.
    expect(scrubbed.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('matches the passthrough list case-insensitively', () => {
    const scrubbed = scrubEnvironment({ gh_token: 'x' }, ['GH_TOKEN']);
    expect(scrubbed.gh_token).toBe('x');
  });
});

describe('process runner', () => {
  const runner = new ExecaProcessRunner();

  it('passes arguments as an array, never through a shell', async () => {
    // If this were interpolated into a shell string, the `&&` would run a second
    // command. As one argv entry it is simply printed back.
    const dangerous = 'hello && echo PWNED';
    const result = await runner.run(process.execPath, ['-e', 'console.log(process.argv[1])', dangerous]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(dangerous);
    expect(result.stdout).not.toContain('PWNED\n');
  });

  it('treats shell metacharacters in an argument as literal text', async () => {
    const result = await runner.run(process.execPath, [
      '-e',
      'console.log(process.argv[1])',
      '$(whoami); rm -rf /; `id`'
    ]);
    expect(result.stdout).toContain('$(whoami)');
  });

  it('rejects a non-string argument rather than coercing it', async () => {
    await expect(
      runner.run(process.execPath, ['-e', 'console.log(1)', 123 as unknown as string])
    ).rejects.toThrow(/must all be strings/i);
  });

  it('rejects an empty executable', async () => {
    await expect(runner.run('   ', [])).rejects.toThrow(/executable path is required/i);
  });

  it('reports a non-zero exit code without throwing', async () => {
    const result = await runner.run(process.execPath, ['-e', 'process.exit(3)']);
    expect(result.exitCode).toBe(3);
    expect(result.failed).toBe(true);
  });

  it('honours a timeout', async () => {
    const result = await runner.run(process.execPath, ['-e', 'setTimeout(()=>{}, 10000)'], {
      timeoutMs: 400
    });
    expect(result.timedOut).toBe(true);
  });

  it('honours an abort signal', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);

    const result = await runner.run(process.execPath, ['-e', 'setTimeout(()=>{}, 10000)'], {
      signal: controller.signal
    });
    expect(result.cancelled).toBe(true);
  });

  it('streams stdout and stderr lines in order', async () => {
    const lines: string[] = [];
    await runner.run(
      process.execPath,
      ['-e', 'console.log("one");console.error("two");console.log("three")'],
      { onLine: (line) => lines.push(line) }
    );

    expect(lines).toContain('one');
    expect(lines).toContain('two');
    expect(lines).toContain('three');
  });

  it('redacts secrets that appear in child output', async () => {
    const result = await runner.run(process.execPath, [
      '-e',
      'console.log("token ghp_0123456789abcdefghijklmnopqrstuvwxyz")'
    ]);
    expect(result.stdout).not.toContain('ghp_');
    expect(result.stdout).toContain('[redacted]');
  });

  it('does not leak a token-shaped variable from its own environment', async () => {
    process.env.AGENT_RELAY_TEST_TOKEN = 'must-not-leak';
    try {
      const result = await runner.run(process.execPath, [
        '-e',
        'console.log(process.env.AGENT_RELAY_TEST_TOKEN ?? "absent")'
      ]);
      expect(result.stdout.trim()).toBe('absent');
    } finally {
      delete process.env.AGENT_RELAY_TEST_TOKEN;
    }
  });

  it('caps retained output at the requested budget', async () => {
    const result = await runner.run(
      process.execPath,
      ['-e', 'for (let i = 0; i < 5000; i++) console.log("x".repeat(80))'],
      { onLine: () => undefined, maxOutputBytes: 2_000 }
    );
    expect(result.stdout.length).toBeLessThan(2_500);
    expect(result.stdout).toContain('omitted');
  });

  it('runOrThrow raises a domain error on failure', async () => {
    await expect(
      runOrThrow(runner, process.execPath, ['-e', 'process.exit(4)'], { what: 'the probe' })
    ).rejects.toThrow(/the probe failed \(exit code 4\)/i);
  });
});

describe('slug and name validation', () => {
  it('builds a safe branch name from an arbitrary title', () => {
    const branch = buildBranchName('0198fe3c-0a5e-78e3-9989-c74cbca0b9c6', 'Add /health endpoint!!');
    expect(branch).toMatch(/^agent-relay\/[a-z0-9]{1,8}-[a-z0-9-]+$/);
    expect(isValidBranchName(branch)).toBe(true);
  });

  it('strips characters that would be dangerous on a command line or path', () => {
    const branch = buildBranchName('id', 'rm -rf / && echo "pwned"; $(id)');
    expect(branch).not.toMatch(/[&;$"'|<>()]/);
    expect(isValidBranchName(branch)).toBe(true);
  });

  it('falls back to a usable slug when the title has nothing alphanumeric', () => {
    expect(slugify('!!!///')).toBe('task');
    expect(buildWorktreeDirName('abc', '???')).toContain('task');
  });

  it('handles accented characters', () => {
    expect(slugify('Café Ünïcode')).toBe('cafe-unicode');
  });

  it('shortens an id deterministically', () => {
    expect(shortId('0198fe3c-0a5e-78e3')).toBe('0198fe3c');
    expect(shortId('!!!')).toBe('task');
  });

  it('rejects invalid branch names', () => {
    for (const bad of ['', '-leading-dash', 'has space', 'ends/', 'double..dot', 'a@{b', 'x.lock']) {
      expect(isValidBranchName(bad)).toBe(false);
    }
  });

  it('validates GitHub owners and repository names', () => {
    expect(isValidGithubOwner('Desken-van')).toBe(true);
    expect(isValidGithubOwner('bad owner')).toBe(false);
    expect(isValidGithubOwner('-leading')).toBe(false);

    expect(isValidRepoName('agent-relay')).toBe(true);
    expect(isValidRepoName('..')).toBe(false);
    expect(isValidRepoName('has space')).toBe(false);
  });
});

describe('IPC contract', () => {
  it('recognises only declared channels', () => {
    expect(isIpcChannel('tasks:create')).toBe(true);
    expect(isIpcChannel('exec:anything')).toBe(false);
    expect(isIpcChannel('__proto__')).toBe(false);
    expect(isIpcChannel(42)).toBe(false);
  });

  it('exposes no channel that takes a command or executable to run', () => {
    // The invariant that actually matters is not what a channel is *called*
    // (`diagnostics:run` and `publish:execute` are both fine — they run a fixed,
    // named operation) but whether any channel lets the renderer supply the thing
    // to be executed. No input schema may carry a command-shaped field.
    const forbidden = new Set([
      'command',
      'cmd',
      'commandline',
      'args',
      'argv',
      'script',
      'shell',
      'executable',
      'exec',
      'binary',
      'program'
    ]);

    for (const [channel, schema] of Object.entries(ipcInputSchemas)) {
      const projected = z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as {
        properties?: Record<string, unknown>;
      };
      for (const property of Object.keys(projected.properties ?? {})) {
        expect(
          forbidden.has(property.toLowerCase()),
          `${channel} accepts a command-shaped field "${property}"`
        ).toBe(false);
      }
    }
  });

  it('makes every channel reject unknown properties', () => {
    // Proven structurally rather than by sampling: a Zod object that is `.strict()`
    // projects to `additionalProperties: false`. If any channel were left loose,
    // a renderer could smuggle an extra field past validation into a handler.
    for (const [channel, schema] of Object.entries(ipcInputSchemas)) {
      const projected = z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as {
        additionalProperties?: unknown;
      };
      expect(projected.additionalProperties, `${channel} accepts unknown properties`).toBe(false);
    }
  });

  it('rejects unknown properties on task creation', () => {
    const result = ipcInputSchemas['tasks:create'].safeParse({
      projectId: 'p',
      title: 't',
      originalRequest: 'r',
      sneaky: 'value'
    });
    expect(result.success).toBe(false);
  });

  it('rejects an out-of-range maxRounds', () => {
    expect(
      ipcInputSchemas['tasks:create'].safeParse({
        projectId: 'p',
        title: 't',
        originalRequest: 'r',
        maxRounds: 9999
      }).success
    ).toBe(false);
  });

  it('rejects a non-URL for openExternal', () => {
    expect(ipcInputSchemas['shell:openExternal'].safeParse({ url: 'not a url' }).success).toBe(false);
    expect(
      ipcInputSchemas['shell:openExternal'].safeParse({ url: 'https://github.com/a/b' }).success
    ).toBe(true);
  });

  it('rejects an empty task id', () => {
    expect(ipcInputSchemas['tasks:get'].safeParse({ taskId: '' }).success).toBe(false);
  });
});
