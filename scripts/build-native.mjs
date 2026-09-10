#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

if (process.platform !== 'win32') process.exit(0);

const nodeGyp = resolve('node_modules', 'node-gyp', 'bin', 'node-gyp.js');
const result = spawnSync(process.execPath, [nodeGyp, 'rebuild'], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
  windowsHide: true,
  shell: false
});

if (result.error) {
  console.error('Failed to start the Agent Relay native build.');
  process.exit(1);
}
process.exit(result.status ?? 1);
