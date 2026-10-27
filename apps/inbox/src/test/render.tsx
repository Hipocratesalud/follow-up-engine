import { QueryClient } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { createApiClient } from '../api/client.ts';
import { App } from '../app.tsx';
import { readApiConfig } from '../config.ts';
import { createHandlers } from '../mocks/handlers.ts';
import { createMockStore, type MockStore } from '../mocks/store.ts';
import { routes } from '../routes.tsx';
import { server } from './server.ts';

export interface RenderedApp extends RenderResult {
  readonly store: MockStore;
  readonly user: UserEvent;
  readonly router: ReturnType<typeof createMemoryRouter>;
}

/** Renders the whole app at `path` against a fresh, stateful mock API. */
export function renderApp(path: string): RenderedApp {
  const store = createMockStore();
  server.use(...createHandlers(store));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const api = createApiClient(readApiConfig({}));
  const result = render(<App api={api} queryClient={queryClient} router={router} />);
  return { ...result, store, user: userEvent.setup(), router };
}
