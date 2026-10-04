#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const env = {
  ...process.env,
  AGENT_RELAY_E2E_EXECUTABLE: resolve(root, 'release/Agent Relay-win32-x64/Agent Relay.exe')
};
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(process.execPath, [
  resolve(root, 'node_modules/vitest/vitest.mjs'), 'run',
  '--config', 'vitest.e2e.config.ts', 'tests/e2e/roadmap-electron.e2e.ts'
], { cwd: root, env, stdio: 'inherit' });
child.on('error', (error) => { console.error(error); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
