#!/usr/bin/env node
/**
 * Launcher for `npm run dev` / `npm start`.
 *
 * Exists for one reason: VS Code's extension host sets `ELECTRON_RUN_AS_NODE=1`
 * in its environment, and any terminal spawned from it inherits that variable.
 * Electron honours it by running electron.exe as a plain Node process — no
 * window, no `app`, no `BrowserWindow` — which surfaces as a baffling
 * "The requested module 'electron' does not provide an export named
 * 'BrowserWindow'" at startup.
 *
 * Deleting the variable here means the Electron child process electron-vite
 * spawns never sees it, so `npm run dev` works from a VS Code terminal, an
 * external terminal, and CI alike.
 */

import { spawn } from 'node:child_process';

const mode = process.argv[2] ?? 'dev';
const passthrough = process.argv.slice(3);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

// Resolve electron-vite through npm's bin shim so this works on every platform
// without hard-coding a path into node_modules/.bin.
const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const child = spawn(command, ['electron-vite', mode, ...passthrough], {
  env,
  stdio: 'inherit',
  // npx is a .cmd shim on Windows; it must go through the shell to be executable.
  // Nothing user-supplied is interpolated here — the argument list is fixed.
  shell: process.platform === 'win32'
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

child.on('error', (error) => {
  console.error(`Failed to start electron-vite: ${error.message}`);
  process.exit(1);
});
