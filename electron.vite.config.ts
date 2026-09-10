import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

const root = import.meta.dirname;

/**
 * Put separately executed Agent Relay assets next to the built main bundle.
 *
 * They are deliberately not bundled. The SQLite probe is a separate process
 * so a synchronous query can be killed on timeout. The Windows launcher is a
 * native executable that owns the Job Object for managed inference runtimes.
 * Their adapters look beside their own module: the source tree in development
 * and `out/main` in a build. These copies make the lookup identical in both.
 */
function copyMainProcessAssets(): Plugin {
  return {
    name: 'agent-relay:copy-main-process-assets',
    closeBundle() {
      const destination = resolve(root, 'out/main');
      mkdirSync(destination, { recursive: true });
      const name = 'sqlite-probe.mjs';
      copyFileSync(
        resolve(root, 'src/main/adapters/operations', name),
        resolve(destination, name)
      );
      if (process.platform === 'win32') {
        const launcher = 'agent-relay-windows-job.exe';
        copyFileSync(
          resolve(root, 'build/Release', launcher),
          resolve(destination, launcher)
        );
      }
    }
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyMainProcessAssets()],
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
