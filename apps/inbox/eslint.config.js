// @ts-check
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import root from '../../eslint.config.js';
import { noLiteralCopy } from './eslint/no-literal-copy.js';

/**
 * The inbox is the only browser app in the repo: it extends the root config
 * with browser globals and the React hooks rules. ESLint resolves the config
 * closest to each linted file, so this applies to apps/inbox only.
 */
export default defineConfig(
  root,
  globalIgnores(['public/mockServiceWorker.js']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat['recommended-latest']],
    languageOptions: {
      globals: globals.browser,
    },
  },
  // Every user-facing word comes from the i18n catalogs (src/i18n): a literal
  // in a component is an untranslated string. Tests may assert on words.
  {
    files: ['src/**/*.tsx'],
    ignores: ['src/**/*.test.tsx', 'src/test/**'],
    plugins: { inbox: { rules: { 'no-literal-copy': noLiteralCopy } } },
    rules: { 'inbox/no-literal-copy': 'error' },
  },
);
