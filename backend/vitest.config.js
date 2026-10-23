import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    // API tests share one database; run files one at a time.
    fileParallelism: false,
  },
});
