import { defineProject } from 'vitest/config';

/**
 * Acceptance scenarios replay whole clinics through the engine; on Postgres a
 * scenario takes seconds, and under a loaded machine it crossed Vitest's 5 s
 * default although no assertion failed. Same project name as without a config.
 */
export default defineProject({
  test: {
    name: '@follow-up-engine/acceptance',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
