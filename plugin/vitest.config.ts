import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Conflict-copy names use local time; pin it so names are reproducible.
    env: { TZ: 'UTC' },
    pool: 'forks',
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['test/unit/**/*.test.ts'], testTimeout: 30_000 },
      },
      {
        extends: true,
        test: {
          name: 'server',
          include: ['test/server/**/*.test.ts'],
          globalSetup: ['test/helpers/global-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'convergence',
          include: ['test/convergence/**/*.test.ts'],
          globalSetup: ['test/helpers/global-setup.ts'],
          testTimeout: 120_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
