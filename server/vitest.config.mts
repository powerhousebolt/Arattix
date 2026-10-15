import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Tests share ports, temp dirs and (optionally) one Redis; keep them serial and deterministic.
    fileParallelism: false,
  },
});
