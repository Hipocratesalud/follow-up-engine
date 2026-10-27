import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@follow-up-engine/api',
    include: ['src/**/*.test.ts'],
  },
});
