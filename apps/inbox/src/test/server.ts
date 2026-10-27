import { setupServer } from 'msw/node';

/** One MSW server for the whole suite; each test installs handlers over a fresh mock store. */
export const server = setupServer();
