import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

const root = import.meta.dirname;

/**
 * Put the SQLite probe script next to the built main bundle.
 *
 * It is deliberately not bundled: it is the entry point of a *separate*
 * process, spawned so a synchronous SQLite query can be killed on a timeout.
 * The adapter looks for it beside its own module, which is the source
 * directory in development and `out/main` in a build — so this copy is what
 * makes the same lookup correct in both, with no environment check anywhere.
 */
function copySqliteProbe(): Plugin {
  const name = 'sqlite-probe.mjs';
  return {
    name: 'agent-relay:copy-sqlite-probe',
    closeBundle() {
      const destination = resolve(root, 'out/main');
      mkdirSync(destination, { recursive: true });
      copyFileSync(
        resolve(root, 'src/main/adapters/operations', name),
        resolve(destination, name)
      );
    }
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copySqliteProbe()],
    resolve: {
      alias: {
        '@shared': resolve(root, 'src/shared'),
        '@main': resolve(root, 'src/main')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(root, 'src/main/index.ts') },
        // Electron supplies `electron/main` at runtime; it must never be bundled.
        external: ['electron', 'electron/main', 'electron/common', 'electron/utility']
      }
    }
  },
  preload: {
    // The preload bundle runs inside a sandboxed renderer process, so it must not
    // depend on anything that has to be `require`d from node_modules at runtime.
    // Everything it needs is either `electron` (provided by the runtime) or inlined.
    resolve: {
      alias: {
        '@shared': resolve(root, 'src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(root, 'src/preload/index.ts') },
        external: ['electron'],
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    root: resolve(root, 'src/renderer'),
    resolve: {
      alias: {
        '@shared': resolve(root, 'src/shared'),
        '@renderer': resolve(root, 'src/renderer/src')
      }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: resolve(root, 'src/renderer/index.html') }
      }
    }
  }
});
