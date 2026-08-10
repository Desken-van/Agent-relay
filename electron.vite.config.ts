import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

const root = import.meta.dirname;

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
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
