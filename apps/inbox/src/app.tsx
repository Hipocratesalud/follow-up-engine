import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, StrictMode } from 'react';
import { RouterProvider, type createBrowserRouter } from 'react-router';
import type { ApiClient } from './api/client.ts';
import { isApiError } from './api/client.ts';
import { ApiContext } from './api/queries.ts';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: false,
        // Retry network and server errors, never client errors (404, 409, 422).
        retry: (failureCount, error) =>
          failureCount < 2 && !(isApiError(error) && error.status >= 400 && error.status < 500),
      },
    },
  });
}

export function App({
  api,
  queryClient,
  router,
}: {
  readonly api: ApiClient;
  readonly queryClient: QueryClient;
  readonly router: ReturnType<typeof createBrowserRouter>;
}): ReactNode {
  return (
    <StrictMode>
      <ApiContext.Provider value={api}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ApiContext.Provider>
    </StrictMode>
  );
}
