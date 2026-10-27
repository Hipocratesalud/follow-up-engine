// @ts-check
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import root from '../../eslint.config.js';

/**
 * The inbox is the only browser app in the repo: it extends the root config
 * with browser globals and the React hooks rules. ESLint resolves the config
 * closest to each linted file, so this applies to apps/inbox only.
 */
export default defineConfig(root, globalIgnores(['public/mockServiceWorker.js']), {
  files: ['**/*.{ts,tsx}'],
  extends: [reactHooks.configs.flat['recommended-latest']],
  languageOptions: {
    globals: globals.browser,
  },
});
