import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { resetLocale } from '../i18n/index.ts';
import { server } from './server.ts';

// The patient card loads the patient, then the open case (HIP-141): under a
// full parallel run that can take longer than the 1 s default to settle.
configure({ asyncUtilTimeout: 3000 });

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
