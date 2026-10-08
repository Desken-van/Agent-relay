import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ExecaProcessRunner } from '../../src/main/adapters/process/process-runner';
import { locateExecutable } from '../../src/main/adapters/process/executable-locator';
import { LocalWorktreeDependencyPreparer } from '../../src/main/services/worktree-dependencies';

let root: string;
let repositoryPath: string;
let worktreePath: string;
const runner = new ExecaProcessRunner();
const prepare = new LocalWorktreeDependencyPreparer(runner);

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, windowsHide: true });
}

/** Test-only bootstrap: same node/npm-cli.js resolution `installDependencies` itself uses. */
function npmCliInvocation(): { readonly node: string; readonly npmCli: string } {
  const node = locateExecutable('node');
  const npm = locateExecutable('npm');
  if (!node || !npm) throw new Error('Node.js and npm are required for this test.');
  const npmCli = process.platform === 'win32'
    ? join(dirname(npm.path), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : realpathSync(npm.path);
  return { node: node.path, npmCli };
}

/** Generates a real, guaranteed-valid lockfile for `cwd`'s package.json — never hand-crafted. */
async function npmInstall(cwd: string): Promise<void> {
  const { node, npmCli } = npmCliInvocation();
  const result = await runner.run(node, [npmCli, 'install'], { cwd, timeoutMs: 60_000, maxOutputBytes: 1_000_000 });
  if (result.failed || result.exitCode !== 0) {
    throw new Error(`npm install failed in test fixture: ${result.stderr || result.stdout}`);
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-relay-dependencies-'));
  repositoryPath = join(root, 'repository');
  worktreePath = join(root, 'worktree');
  mkdirSync(repositoryPath);
  git(repositoryPath, 'init', '-b', 'main');
  git(repositoryPath, 'config', 'user.email', 'test@example.invalid');
  git(repositoryPath, 'config', 'user.name', 'Test');
  writeFileSync(join(repositoryPath, 'package.json'), '{"scripts":{"verify":"echo ok"}}\n');
  writeFileSync(join(repositoryPath, 'package-lock.json'), '{"lockfileVersion":3}\n');
  writeFileSync(join(repositoryPath, '.gitignore'), 'node_modules/\nbuild/\n');
  git(repositoryPath, 'add', '--', 'package.json', 'package-lock.json', '.gitignore');
  git(repositoryPath, 'commit', '-m', 'fixture');
  git(repositoryPath, 'worktree', 'add', '-b', 'agent/test', worktreePath);
  mkdirSync(join(repositoryPath, 'node_modules'));
  writeFileSync(join(repositoryPath, 'node_modules', '.fixture'), 'installed');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('local worktree dependency preparation', () => {
  it('creates one ignored local link to compatible installed dependencies and is idempotent', async () => {
    if (process.platform === 'win32') {
      mkdirSync(join(repositoryPath, 'build', 'Release'), { recursive: true });
      writeFileSync(join(repositoryPath, 'build', 'Release', 'agent-relay-windows-job.exe'), 'fixture-launcher');
      writeFileSync(join(repositoryPath, 'build', 'Release', 'agent-relay-fs-guard.exe'), 'fixture-fs-guard');
    }
    if (process.platform === 'linux') {
      mkdirSync(join(repositoryPath, 'build', 'Release'), { recursive: true });
      writeFileSync(join(repositoryPath, 'build', 'Release', 'agent-relay-fs-guard'), 'fixture-fs-guard', { mode: 0o755 });
    }

    await prepare.prepare({ repositoryPath, worktreePath });
    await prepare.prepare({ repositoryPath, worktreePath });

    const target = join(worktreePath, 'node_modules');
    if (process.platform === 'win32') {
      expect(lstatSync(target).isSymbolicLink()).toBe(true);
      expect(readlinkSync(target)).toBeTruthy();
    } else {
      // A real directory, so the project's `node_modules/` rule ignores it, holding one link per entry.
      expect(lstatSync(target).isDirectory()).toBe(true);
      expect(lstatSync(join(target, '.fixture')).isSymbolicLink()).toBe(true);
      expect(realpathSync(join(target, '.fixture'))).toBe(realpathSync(join(repositoryPath, 'node_modules', '.fixture')));
    }
    if (process.platform === 'win32') {
      expect(readFileSync(join(worktreePath, 'build', 'Release', 'agent-relay-windows-job.exe'), 'utf8'))
        .toBe('fixture-launcher');
      expect(readFileSync(join(worktreePath, 'build', 'Release', 'agent-relay-fs-guard.exe'), 'utf8'))
        .toBe('fixture-fs-guard');
    }
    if (process.platform === 'linux') {
      const helper = join(worktreePath, 'build', 'Release', 'agent-relay-fs-guard');
      expect(readFileSync(helper, 'utf8')).toBe('fixture-fs-guard');
      // Still executable in the worktree, and still the only build output copied there.
      expect(lstatSync(helper).mode & 0o111).not.toBe(0);
      expect(readdirSync(join(worktreePath, 'build', 'Release'))).toEqual(['agent-relay-fs-guard']);
    }
    expect(execFileSync('git', ['status', '--short'], { cwd: worktreePath, encoding: 'utf8' })).toBe('');
  });

  describe.skipIf(process.platform === 'win32')('a linked node_modules directory (every platform but Windows)', () => {
    const source = (): string => join(repositoryPath, 'node_modules');
    const target = (): string => join(worktreePath, 'node_modules');

    it('replaces a whole-directory link from an earlier build without touching what it pointed to', async () => {
      symlinkSync(realpathSync(source()), target(), 'dir');
      expect((await prepare.checkStatus({ repositoryPath, worktreePath })).state).toBe('ready_linked');

      await prepare.prepare({ repositoryPath, worktreePath });

      expect(lstatSync(target()).isDirectory()).toBe(true);
      expect(readFileSync(join(source(), '.fixture'), 'utf8')).toBe('installed');
      expect(readFileSync(join(target(), '.fixture'), 'utf8')).toBe('installed');
      expect(execFileSync('git', ['status', '--short'], { cwd: worktreePath, encoding: 'utf8' })).toBe('');
    });

    it('follows the registered checkout: adds new entries, drops links it no longer has, keeps local caches', async () => {
      await prepare.prepare({ repositoryPath, worktreePath });
      mkdirSync(join(target(), '.vite'));
      mkdirSync(join(source(), 'new-package'));
      rmSync(join(source(), '.fixture'));

      await prepare.prepare({ repositoryPath, worktreePath });

      expect(realpathSync(join(target(), 'new-package'))).toBe(realpathSync(join(source(), 'new-package')));
      expect(() => lstatSync(join(target(), '.fixture'))).toThrow();
      expect(lstatSync(join(target(), '.vite')).isDirectory()).toBe(true);
      expect((await prepare.checkStatus({ repositoryPath, worktreePath })).state).toBe('ready_linked');
    });

    it('reports a foreign entry or a link elsewhere as broken, and prepare refuses it', async () => {
      await prepare.prepare({ repositoryPath, worktreePath });
      const elsewhere = join(root, 'elsewhere');
      mkdirSync(elsewhere);
      rmSync(join(target(), '.fixture'));
      symlinkSync(elsewhere, join(target(), '.fixture'), 'dir');
      expect((await prepare.checkStatus({ repositoryPath, worktreePath })).state).toBe('link_broken');
      await expect(prepare.prepare({ repositoryPath, worktreePath })).rejects.toThrow(/outside the registered project checkout/);

      rmSync(join(target(), '.fixture'));
      writeFileSync(join(target(), 'injected.js'), 'module.exports = 1;');
      expect((await prepare.checkStatus({ repositoryPath, worktreePath })).state).toBe('link_broken');
      expect(readFileSync(join(target(), 'injected.js'), 'utf8')).toBe('module.exports = 1;');
    });
  });

  it('refuses to reuse dependencies when the lockfile differs', async () => {
    writeFileSync(join(worktreePath, 'package-lock.json'), '{"lockfileVersion":2}\n');

    await expect(prepare.prepare({ repositoryPath, worktreePath })).rejects.toThrow(/manifest differs/);
    expect(() => lstatSync(join(worktreePath, 'node_modules'))).toThrow();
  });

  it('requires dependencies to be installed once in the registered checkout', async () => {
    rmSync(join(repositoryPath, 'node_modules'), { recursive: true, force: true });

    await expect(prepare.prepare({ repositoryPath, worktreePath })).rejects.toThrow(/not installed/);
  });
});

describe('checkStatus (non-throwing parity with prepare)', () => {
  it('reports not_node_project when the worktree has no package.json', async () => {
    rmSync(join(worktreePath, 'package.json'));
    const status = await prepare.checkStatus({ repositoryPath, worktreePath });
    expect(status.state).toBe('not_node_project');
  });

  it('reports ready_linked once prepare has linked, and agrees before linking too', async () => {
    const before = await prepare.checkStatus({ repositoryPath, worktreePath });
    expect(before.state).toBe('ready_linked');
    await prepare.prepare({ repositoryPath, worktreePath });
    const after = await prepare.checkStatus({ repositoryPath, worktreePath });
    expect(after.state).toBe('ready_linked');
  });

  it('reports ready_local for an existing worktree-local node_modules directory, and prepare leaves it alone', async () => {
    mkdirSync(join(worktreePath, 'node_modules'));
    writeFileSync(join(worktreePath, 'node_modules', '.fixture'), 'already installed');
    const status = await prepare.checkStatus({ repositoryPath, worktreePath });
    expect(status.state).toBe('ready_local');

    await prepare.prepare({ repositoryPath, worktreePath });
    expect(readFileSync(join(worktreePath, 'node_modules', '.fixture'), 'utf8')).toBe('already installed');
  });

  it('reports manifest_mismatch exactly where prepare refuses', async () => {
    writeFileSync(join(worktreePath, 'package-lock.json'), '{"lockfileVersion":2}\n');
    const status = await prepare.checkStatus({ repositoryPath, worktreePath });
    expect(status.state).toBe('manifest_mismatch');
  });

  it('reports registered_missing exactly where prepare refuses', async () => {
    rmSync(join(repositoryPath, 'node_modules'), { recursive: true, force: true });
    const status = await prepare.checkStatus({ repositoryPath, worktreePath });
    expect(status.state).toBe('registered_missing');
  });

  it('reports link_broken for a link pointing outside the registered checkout', async () => {
    await prepare.prepare({ repositoryPath, worktreePath });
    const target = join(worktreePath, 'node_modules');
    rmSync(target, { recursive: true, force: true });
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    execFileSync(
      process.platform === 'win32' ? 'cmd' : 'ln',
      process.platform === 'win32' ? ['/c', 'mklink', '/J', target, elsewhere] : ['-s', elsewhere, target],
      { windowsHide: true }
    );
    const status = await prepare.checkStatus({ repositoryPath, worktreePath });
    expect(status.state).toBe('link_broken');
  });

  it('reports unsupported_package_manager instead of manifest_mismatch when the worktree names a non-npm lockfile', async () => {
    rmSync(join(worktreePath, 'package-lock.json'));
    writeFileSync(join(worktreePath, 'yarn.lock'), '# yarn lockfile v1\n');
    const status = await prepare.checkStatus({ repositoryPath, worktreePath });
    expect(status.state).toBe('unsupported_package_manager');
    expect(status.detail).toContain('yarn.lock');
  });

  it('reports unsupported_package_manager instead of registered_missing when the worktree names a non-npm lockfile', async () => {
    rmSync(join(repositoryPath, 'node_modules'), { recursive: true, force: true });
    rmSync(join(worktreePath, 'package-lock.json'));
    writeFileSync(join(worktreePath, 'pnpm-lock.yaml'), 'lockfileVersion: 6\n');
    const status = await prepare.checkStatus({ repositoryPath, worktreePath });
    expect(status.state).toBe('unsupported_package_manager');
    expect(status.detail).toContain('pnpm-lock.yaml');
  });
});

describe('installDependencies', () => {
  it('refuses without spawning anything when there is nothing to install', async () => {
    // ready_linked (nothing installed yet, but the fast link is viable).
    const status = await prepare.installDependencies(
      { repositoryPath, worktreePath },
      new AbortController().signal,
      30_000,
      1_000_000,
      () => undefined
    );
    expect(status.kind).toBe('refused');
    expect(status.status.state).toBe('ready_linked');
    expect(() => lstatSync(join(worktreePath, 'node_modules'))).toThrow();
  });

  it('refuses for an unsupported package manager rather than running npm ci against it', async () => {
    rmSync(join(worktreePath, 'package-lock.json'));
    writeFileSync(join(worktreePath, 'yarn.lock'), '# yarn lockfile v1\n');
    const outcome = await prepare.installDependencies(
      { repositoryPath, worktreePath },
      new AbortController().signal,
      30_000,
      1_000_000,
      () => undefined
    );
    expect(outcome.kind).toBe('refused');
    expect(outcome.status.state).toBe('unsupported_package_manager');
  });

  it('installs a real, self-consistent local dependency graph with npm ci and leaves the registered checkout untouched', async () => {
    const localPkg = join(root, 'local-pkg');
    mkdirSync(localPkg);
    writeFileSync(join(localPkg, 'package.json'), JSON.stringify({ name: 'local-pkg', version: '1.0.0' }));

    // A self-consistent package.json/lockfile pair for the WORKTREE, generated
    // by really running npm — never hand-crafted — then reset to "missing" so
    // the fixture starts from exactly the state `manifest_mismatch` describes.
    writeFileSync(join(worktreePath, 'package.json'), JSON.stringify({
      name: 'probe', version: '1.0.0', dependencies: { 'local-pkg': 'file:../local-pkg' }
    }));
    rmSync(join(worktreePath, 'package-lock.json'), { force: true });
    await npmInstall(worktreePath);
    rmSync(join(worktreePath, 'node_modules'), { recursive: true, force: true });

    const before = await prepare.checkStatus({ repositoryPath, worktreePath });
    expect(before.state).toBe('manifest_mismatch');

    const repositoryPackageJsonBefore = readFileSync(join(repositoryPath, 'package.json'), 'utf8');
    const repositoryNodeModulesBefore = readFileSync(join(repositoryPath, 'node_modules', '.fixture'), 'utf8');

    const lines: string[] = [];
    const outcome = await prepare.installDependencies(
      { repositoryPath, worktreePath },
      new AbortController().signal,
      60_000,
      1_000_000,
      (event) => { if (event.type === 'log') lines.push(event.text); }
    );

    expect(outcome.kind).toBe('succeeded');
    expect(outcome.status.state).toBe('ready_local');
    expect(lines.some((line) => line.includes('npm ci'))).toBe(true);
    // `npm ci` installs a `file:` dependency as a symlink, not a copy —
    // `statSync` (follows it) rather than `lstatSync` proves it resolves to
    // real installed content.
    expect(statSync(join(worktreePath, 'node_modules', 'local-pkg')).isDirectory()).toBe(true);

    // The registered checkout is a completely different, dirty directory this
    // action must never mutate.
    expect(readFileSync(join(repositoryPath, 'package.json'), 'utf8')).toBe(repositoryPackageJsonBefore);
    expect(readFileSync(join(repositoryPath, 'node_modules', '.fixture'), 'utf8')).toBe(repositoryNodeModulesBefore);

    // Tracked files in the worktree are untouched by the install itself
    // (package.json/lockfile were already staged as uncommitted local edits
    // before installDependencies ran); node_modules must not appear as a
    // change since it is gitignored.
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: worktreePath, encoding: 'utf8' });
    expect(status).not.toContain('node_modules');
  });

  it('reports package_manager_failed, not a silent success, when npm ci cannot install', async () => {
    const localPkg = join(root, 'local-pkg-missing');
    // Deliberately do NOT create this directory: `file:` install must fail.
    writeFileSync(join(worktreePath, 'package.json'), JSON.stringify({
      name: 'probe', version: '1.0.0', dependencies: { 'local-pkg': `file:${localPkg}` }
    }));
    writeFileSync(join(worktreePath, 'package-lock.json'), JSON.stringify({
      name: 'probe', version: '1.0.0', lockfileVersion: 3, requires: true,
      packages: {
        '': { name: 'probe', version: '1.0.0', dependencies: { 'local-pkg': `file:${localPkg}` } },
        'node_modules/local-pkg': { name: 'local-pkg', version: '1.0.0', resolved: `file:${localPkg}` }
      }
    }));

    const before = await prepare.checkStatus({ repositoryPath, worktreePath });
    expect(before.state).toBe('manifest_mismatch');

    const outcome = await prepare.installDependencies(
      { repositoryPath, worktreePath },
      new AbortController().signal,
      30_000,
      1_000_000,
      () => undefined
    );
    expect(outcome.kind).not.toBe('succeeded');
    expect(['package_manager_failed', 'manifest_drift']).toContain(outcome.kind);
  });

  it('installs devDependencies whatever NODE_ENV the host application carries: npm ci never inherits it', async () => {
    // The live failure this guards against: Agent Relay started with `npm start` (electron-vite preview)
    // carries NODE_ENV=production; an `npm ci` that inherits it omits devDependencies, so node-gyp is
    // missing when the project's own postinstall needs it and the install fails after a green native build.
    // The fixture observes the effect — the devDependency is installed — not the flag.
    const localDev = join(root, 'local-dev');
    mkdirSync(localDev);
    writeFileSync(join(localDev, 'package.json'), JSON.stringify({ name: 'local-dev', version: '1.0.0' }));
    writeFileSync(join(worktreePath, 'package.json'), JSON.stringify({
      name: 'probe', version: '1.0.0', devDependencies: { 'local-dev': 'file:../local-dev' }
    }));
    rmSync(join(worktreePath, 'package-lock.json'), { force: true });
    // The lockfile is generated before NODE_ENV is set, so it lists the devDependency; the install under
    // test is the only step that runs with the host's production marker.
    await npmInstall(worktreePath);
    rmSync(join(worktreePath, 'node_modules'), { recursive: true, force: true });
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const outcome = await prepare.installDependencies(
        { repositoryPath, worktreePath },
        new AbortController().signal,
        60_000,
        1_000_000,
        () => undefined
      );
      expect(outcome.kind).toBe('succeeded');
      expect(statSync(join(worktreePath, 'node_modules', 'local-dev')).isDirectory()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
    }
  });

  it('is cancellable', async () => {
    const localPkg = join(root, 'local-pkg');
    mkdirSync(localPkg);
    writeFileSync(join(localPkg, 'package.json'), JSON.stringify({ name: 'local-pkg', version: '1.0.0' }));
    writeFileSync(join(worktreePath, 'package.json'), JSON.stringify({
      name: 'probe', version: '1.0.0', dependencies: { 'local-pkg': 'file:../local-pkg' }
    }));
    rmSync(join(worktreePath, 'package-lock.json'), { force: true });
    await npmInstall(worktreePath);
    rmSync(join(worktreePath, 'node_modules'), { recursive: true, force: true });

    // Already aborted before the call starts: deterministic, unlike racing a
    // real process shutdown against a live abort.
    const controller = new AbortController();
    controller.abort();
    const outcome = await prepare.installDependencies(
      { repositoryPath, worktreePath },
      controller.signal,
      30_000,
      1_000_000,
      () => undefined
    );
    expect(outcome.kind).toBe('cancelled');
    expect(() => lstatSync(join(worktreePath, 'node_modules'))).toThrow();
  });
});
