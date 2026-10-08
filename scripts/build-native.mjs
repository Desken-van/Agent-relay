#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// Windows builds the Job Object launcher and the Ornith filesystem-mutation
// guard; Linux builds the guard. Elsewhere there is nothing native to build,
// and the guard reports itself unavailable at run time instead.
if (process.platform !== 'win32' && process.platform !== 'linux') process.exit(0);

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
if (result.status !== 0 && process.platform === 'linux') {
  console.error(
    'The Agent Relay native build failed. Ornith file edits need build/Release/agent-relay-fs-guard: ' +
      'install a C++ compiler, make and Python 3, then run "npm run build:native".'
  );
}
process.exit(result.status ?? 1);
