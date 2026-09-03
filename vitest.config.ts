import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const root = import.meta.dirname;

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(root, 'src/shared'),
      '@main': resolve(root, 'src/main')
    }
  },
  test: {
    globals: true,
    // Node by default: the process, SQLite and Git suites must keep running in
    // a real Node environment. The renderer tests opt into jsdom per file with
    // an `@vitest-environment` docblock, which keeps the choice next to the
    // tests that need it instead of in a glob nobody reads.
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Git integration tests create real temporary repositories on disk; give them room.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    reporters: ['default']
  }
});
