import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30_000,
    coverage: {
      thresholds: {
        statements: 65,
        branches: 65,
        functions: 70,
        lines: 65,
      },
    },
  },
});
