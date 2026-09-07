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
    environment: 'node',
    include: ['tests/live/**/*.live.ts'],
    testTimeout: 40 * 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    maxWorkers: 1,
    reporters: ['default']
  }
});
