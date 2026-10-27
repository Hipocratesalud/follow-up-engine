import { defineConfig } from 'vitest/config';

/**
 * End-to-end suite: the API and the worker in-process against a real
 * Postgres (`DATABASE_URL`), webhooks over real HTTP to a signing sink.
 * Skipped, with the reason in its title, when `DATABASE_URL` is unset.
 */
export default defineConfig({
  test: {
    name: '@follow-up-engine/api-e2e',
    include: ['e2e/**/*.e2e.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
