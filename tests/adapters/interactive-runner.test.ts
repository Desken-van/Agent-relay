import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ExecaProcessRunner,
  type InteractiveSessionController
} from '../../src/main/adapters/process/process-runner';

/**
 * These drive a real child process, because the whole point of the interactive
 * runner is behaviour a fake cannot exhibit: stdin staying open, a reply
 * arriving only after a write, and the tree actually dying on timeout.
 *
 * The child is a tiny Node script written to a temp directory — no shell, no
 * third-party helper.
 */
let dir: string;
let echoScript: string;
let noisyScript: string;
let ignoreScript: string;
let secretScript: string;
let envScript: string;

const runner = new ExecaProcessRunner();

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-relay-interactive-'));

  // Replies to each line, and only when a line arrives.
  echoScript = join(dir, 'echo.mjs');
  writeFileSync(
    echoScript,
    [
      'let n = 0;',
      'process.stdin.setEncoding("utf8");',
      'let buf = "";',
      'process.stdin.on("data", (chunk) => {',
      '  buf += chunk;',
      '  let i;',
      '  while ((i = buf.indexOf("\\n")) >= 0) {',
      '    const line = buf.slice(0, i); buf = buf.slice(i + 1);',
      '    n += 1;',
      '    process.stdout.write(JSON.stringify({ n, echo: line }) + "\\n");',
      '  }',
      '});',
      'process.stdin.on("end", () => { process.stdout.write("bye\\n"); process.exit(0); });'
    ].join('\n')
  );

  // Writes to both streams so the split can be observed.
  noisyScript = join(dir, 'noisy.mjs');
  writeFileSync(
    noisyScript,
    [
      'process.stderr.write("warning: something\\n");',
      'process.stdout.write("out-1\\n");',
      'process.stderr.write("warning: again\\n");',
      'process.stdout.write("out-2\\n");',
      'process.stdin.resume();',
      'process.stdin.on("end", () => process.exit(0));'
    ].join('\n')
  );

  // Never exits on its own and ignores stdin EOF: only a kill stops it.
  ignoreScript = join(dir, 'ignore.mjs');
  writeFileSync(
    ignoreScript,
    [
      'process.stdout.write("ready\\n");',
      'setInterval(() => {}, 1000);'
    ].join('\n')
  );

  // Emits something that must be redacted before the caller sees it.
  secretScript = join(dir, 'secret.mjs');
  writeFileSync(
    secretScript,
    [
      'process.stdout.write("token ghp_0123456789abcdefghijklmnopqrstuvwxyz\\n");',
      'process.stdin.resume();',
      'process.stdin.on("end", () => process.exit(0));'
    ].join('\n')
  );

  // Reports whether a token-shaped variable survived the scrub.
  envScript = join(dir, 'env.mjs');
  writeFileSync(
    envScript,
    [
      'process.stdout.write(JSON.stringify({',
      '  secret: process.env.AGENT_RELAY_TEST_TOKEN ?? null,',
      '  ordinary: process.env.AGENT_RELAY_TEST_PLAIN ?? null',
      '}) + "\\n");',
      'process.stdin.resume();',
      'process.stdin.on("end", () => process.exit(0));'
    ].join('\n')
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('interactive process runner', () => {
  it('keeps stdin open, so a reply can trigger the next write', async () => {
    const seen: string[] = [];

    const result = await runner.runInteractive(process.execPath, [echoScript], {
      timeoutMs: 20_000,
      onStart(controller) {
        controller.writeLine('first');
      },
      onStdoutLine(line, controller) {
        if (line === 'bye') return;
        seen.push(line);
        // The reply is what drives the conversation forward — impossible with
        // `run({ input })`, which closes stdin before any answer arrives.
        if (seen.length === 1) controller.writeLine('second');
        else if (seen.length === 2) controller.writeLine('third');
        else controller.closeInput();
      }
    });

    expect(result.exitCode).toBe(0);
    expect(seen.map((line) => JSON.parse(line).echo)).toEqual(['first', 'second', 'third']);
  });

  it('never closes stdin behind the caller: EOF only follows closeInput', async () => {
    // The one-shot `run()` closes a child's stdin immediately. This path must
    // not: the whole point is a conversation, and an early EOF would end it
    // before the first reply. `echoScript` writes "bye" only when its stdin
    // ends, so where that marker appears is the whole assertion.
    const seen: string[] = [];

    const result = await runner.runInteractive(process.execPath, [echoScript], {
      timeoutMs: 20_000,
      onStart(controller) {
        controller.writeLine('first');
      },
      onStdoutLine(line, controller) {
        seen.push(line);
        if (line === 'bye') return;
        // Still no EOF, two exchanges in.
        expect(seen).not.toContain('bye');
        if (seen.length === 1) controller.writeLine('second');
        else controller.closeInput();
      }
    });

    expect(seen.slice(0, 2).map((line) => JSON.parse(line).echo)).toEqual(['first', 'second']);
    expect(seen[seen.length - 1]).toBe('bye');
    expect(result.exitCode).toBe(0);
  });

  it('closing stdin ends the child', async () => {
    const result = await runner.runInteractive(process.execPath, [echoScript], {
      timeoutMs: 20_000,
      onStart(controller) {
        controller.closeInput();
      },
      onStdoutLine() {
        /* the child says goodbye and exits */
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('keeps stdout and stderr separate', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const result = await runner.runInteractive(process.execPath, [noisyScript], {
      timeoutMs: 20_000,
      onStdoutLine(line, controller) {
        stdout.push(line);
        if (stdout.length === 2) controller.closeInput();
      },
      onStderrLine(line) {
        stderr.push(line);
      }
    });

    expect(stdout).toEqual(['out-1', 'out-2']);
    expect(stderr.join(' ')).toContain('warning');
    // A warning must never reach the line handler that parses protocol replies.
    expect(stdout.join(' ')).not.toContain('warning');
    expect(result.stderr).toContain('warning');
  });

  it('kills a child that outlives its timeout', async () => {
    const result = await runner.runInteractive(process.execPath, [ignoreScript], {
      timeoutMs: 1_500,
      onStdoutLine() {
        /* deliberately never closes input */
      }
    });

    expect(result.failed).toBe(true);
    expect(result.timedOut || result.exitCode !== 0).toBe(true);
  });

  it('cancels on an AbortSignal', async () => {
    const abort = new AbortController();
    const result = await runner.runInteractive(process.execPath, [ignoreScript], {
      timeoutMs: 20_000,
      signal: abort.signal,
      onStdoutLine() {
        abort.abort();
      }
    });

    expect(result.failed).toBe(true);
  });

  it('refuses a write after the input is closed', async () => {
    let error: unknown;

    await runner.runInteractive(process.execPath, [echoScript], {
      timeoutMs: 20_000,
      onStart(controller) {
        controller.closeInput();
        // Idempotent: a second close is fine, a write is not.
        controller.closeInput();
        try {
          controller.writeLine('too late');
        } catch (caught) {
          error = caught;
        }
      },
      onStdoutLine() {
        /* nothing */
      }
    });

    expect((error as { code?: string })?.code).toBe('VALIDATION_FAILED');
    expect((error as Error)?.message).toMatch(/already closed/i);
  });

  it('refuses a line containing a newline, because framing is one record per line', async () => {
    const errors: unknown[] = [];

    await runner.runInteractive(process.execPath, [echoScript], {
      timeoutMs: 20_000,
      onStart(controller) {
        for (const bad of [`a${String.fromCharCode(10)}b`, `a${String.fromCharCode(13)}b`]) {
          try {
            controller.writeLine(bad);
          } catch (caught) {
            errors.push(caught);
          }
        }
        controller.closeInput();
      },
      onStdoutLine() {
        /* nothing */
      }
    });

    expect(errors).toHaveLength(2);
    expect((errors[0] as Error).message).toMatch(/newline/i);
  });

  it('enforces the input message budget', async () => {
    let error: unknown;

    await runner.runInteractive(process.execPath, [echoScript], {
      timeoutMs: 20_000,
      maxInputMessages: 2,
      onStart(controller) {
        try {
          controller.writeLine('one');
          controller.writeLine('two');
          controller.writeLine('three');
        } catch (caught) {
          error = caught;
        }
        controller.closeInput();
      },
      onStdoutLine() {
        /* nothing */
      }
    });

    expect((error as Error)?.message).toMatch(/at most 2 messages/);
  });

  it('enforces the input byte budget', async () => {
    let error: unknown;

    await runner.runInteractive(process.execPath, [echoScript], {
      timeoutMs: 20_000,
      maxInputBytes: 32,
      onStart(controller) {
        try {
          controller.writeLine('x'.repeat(64));
        } catch (caught) {
          error = caught;
        }
        controller.closeInput();
      },
      onStdoutLine() {
        /* nothing */
      }
    });

    expect((error as Error)?.message).toMatch(/at most 32 bytes/);
  });

  it('ends the session when a diagnostic callback throws, without abandoning the drain', async () => {
    // The same contract as the streaming path: the failure ends the session,
    // but the stderr reader keeps going. Dropping it would leave the child free
    // to block on a full pipe, which is the failure mode draining exists for.
    const diagnostics: string[] = [];

    const result = await runner.runInteractive(process.execPath, [noisyScript], {
      timeoutMs: 20_000,
      onStdoutLine(line, controller) {
        if (line === 'out-2') controller.closeInput();
      },
      onStderrLine(line) {
        diagnostics.push(line);
        throw new Error('diagnostic handler exploded');
      }
    });

    // Called once, then skipped — and the warning after it was still retained.
    expect(diagnostics).toEqual(['warning: something']);
    expect(result.stderr).toContain('again');
    expect(result.failed).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  it('turns a callback throw into a controlled failure, leaving no child behind', async () => {
    const result = await runner.runInteractive(process.execPath, [echoScript], {
      timeoutMs: 20_000,
      onStart(controller) {
        controller.writeLine('hello');
      },
      onStdoutLine() {
        throw new Error('handler exploded');
      }
    });

    // A controlled result, not a rejected promise.
    expect(result.failed).toBe(true);
    expect(result.command).toContain('echo.mjs');
  });

  it('bounds retained output', async () => {
    const result = await runner.runInteractive(process.execPath, [echoScript], {
      timeoutMs: 20_000,
      maxOutputBytes: 40,
      onStart(controller) {
        controller.writeLine('y'.repeat(200));
      },
      onStdoutLine(_line, controller) {
        controller.closeInput();
      }
    });

    expect(result.stdout).toContain('more bytes omitted');
    expect(result.stdout.length).toBeLessThan(200);
  });

  it('redacts secrets before the caller sees them', async () => {
    const lines: string[] = [];

    const result = await runner.runInteractive(process.execPath, [secretScript], {
      timeoutMs: 20_000,
      onStdoutLine(line, controller) {
        lines.push(line);
        controller.closeInput();
      }
    });

    expect(lines.join(' ')).not.toContain('ghp_0123456789abcdefghijklmnopqrstuvwxyz');
    expect(result.stdout).not.toContain('ghp_0123456789abcdefghijklmnopqrstuvwxyz');
  });

  it('scrubs token-shaped environment variables but keeps ordinary ones', async () => {
    process.env.AGENT_RELAY_TEST_TOKEN = 'super-secret';
    process.env.AGENT_RELAY_TEST_PLAIN = 'ordinary';

    try {
      let payload: { secret: string | null; ordinary: string | null } | null = null;

      await runner.runInteractive(process.execPath, [envScript], {
        timeoutMs: 20_000,
        onStdoutLine(line, controller) {
          payload = JSON.parse(line);
          controller.closeInput();
        }
      });

      expect(payload).not.toBeNull();
      expect(payload!.secret).toBeNull();
      expect(payload!.ordinary).toBe('ordinary');
    } finally {
      delete process.env.AGENT_RELAY_TEST_TOKEN;
      delete process.env.AGENT_RELAY_TEST_PLAIN;
    }
  });

  it('never interprets the command through a shell', async () => {
    // If a shell were involved this would expand; with shell:false it is one
    // literal argument the script simply echoes back.
    const seen: string[] = [];

    await runner.runInteractive(process.execPath, [echoScript], {
      timeoutMs: 20_000,
      onStart(controller: InteractiveSessionController) {
        controller.writeLine('$(echo pwned) && whoami');
      },
      onStdoutLine(line, controller) {
        if (line !== 'bye') seen.push(JSON.parse(line).echo);
        controller.closeInput();
      }
    });

    expect(seen[0]).toBe('$(echo pwned) && whoami');
  });

  it('does not put stdin content into the command label', async () => {
    const result = await runner.runInteractive(process.execPath, [echoScript], {
      timeoutMs: 20_000,
      onStart(controller) {
        controller.writeLine('a-very-private-payload');
        controller.closeInput();
      },
      onStdoutLine() {
        /* nothing */
      }
    });

    expect(result.command).not.toContain('a-very-private-payload');
  });
});
