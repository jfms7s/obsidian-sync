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
    ],
  },
});
