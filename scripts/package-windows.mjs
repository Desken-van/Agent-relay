#!/usr/bin/env node
/** Build a portable Windows folder; native helpers remain ordinary executable files. */
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { packager } from '@electron/packager';

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('The portable package currently supports Windows x64 only.');
}

const root = resolve(import.meta.dirname, '..');
for (const asset of [
  'out/main/index.js', 'out/preload/index.cjs', 'out/renderer/index.html',
  'out/main/sqlite-probe.mjs', 'out/main/agent-relay-windows-job.exe',
  'out/main/agent-relay-fs-guard.exe'
]) {
  await access(resolve(root, asset));
}
const electron = JSON.parse(await readFile(resolve(root, 'node_modules/electron/package.json'), 'utf8'));
const paths = await packager({
  dir: root,
  out: resolve(root, 'release'),
  name: 'Agent Relay',
  executableName: 'Agent Relay',
  platform: 'win32',
  arch: 'x64',
  electronVersion: electron.version,
  // The Job Object launcher, filesystem guard and SQLite probe run separately.
  asar: false,
  prune: true,
  overwrite: true,
  // Include only built assets, the manifest and production dependencies. Packager
  // also applies its defaults (including excluding Electron and devDependencies).
  ignore: /^\/(?!(?:out|node_modules)(?:\/|$)|package\.json$)/
});
for (const path of paths) console.log(`Portable package: ${path}`);
