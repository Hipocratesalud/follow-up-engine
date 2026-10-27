import { QueryClient } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import type { HttpHandler } from 'msw';
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

export interface RenderOptions {
  /** Simulated API latency in ms (pending states). */
  readonly latencyMs?: number;
  /** Handlers that take precedence over the mock API (failures, smaller pages). */
  readonly handlers?: (store: MockStore) => HttpHandler[];
}

/** Renders the whole app at `path` against a fresh, stateful mock API. */
export function renderApp(path: string, options: RenderOptions = {}): RenderedApp {
  const store = createMockStore();
  server.use(
    ...(options.handlers?.(store) ?? []),
    ...createHandlers(store, { latencyMs: options.latencyMs ?? 0 }),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const api = createApiClient(readApiConfig({}));
  const result = render(<App api={api} queryClient={queryClient} router={router} />);
  return { ...result, store, user: userEvent.setup(), router };
}
