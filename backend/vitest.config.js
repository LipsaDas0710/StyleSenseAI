import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    // API tests share one database; run files one at a time.
    fileParallelism: false,
    // API tests make many round trips; a hosted database (e.g. Neon) is far slower than localhost.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
