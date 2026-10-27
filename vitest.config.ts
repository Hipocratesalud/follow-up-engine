import { defineConfig } from 'vitest/config';

/**
 * Root Vitest config. Every workspace package and app is its own Vitest
 * project, named after its package.json `name`, so `pnpm test --project
 * @follow-up-engine/core` runs a single package.
 */
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
  },
});
