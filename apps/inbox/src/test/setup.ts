import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { resetLocale } from '../i18n/index.ts';
import { server } from './server.ts';

beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
});

afterEach(() => {
  cleanup();
  server.resetHandlers();
  sessionStorage.clear();
  // Every test starts in the default language (English) unless it picks another.
  localStorage.clear();
  resetLocale();
});

afterAll(() => {
  server.close();
});
