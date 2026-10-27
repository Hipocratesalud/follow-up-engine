import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';
import { createApiClient } from './api/client.ts';
import { App, createQueryClient } from './app.tsx';
import { readApiConfig } from './config.ts';
import { routes } from './routes.tsx';
import './styles.css';

async function bootstrap(): Promise<void> {
  const config = readApiConfig(import.meta.env);
  if (config.mode === 'mock') {
    try {
      const { startMockApi } = await import('./mocks/browser.ts');
      await startMockApi();
    } catch {
      // Without a service worker the mock cannot answer; the UI still renders and every view
      // shows its error state with a retry instead of a blank page.
    }
  }
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing #root element');
  createRoot(container).render(
    <App
      api={createApiClient(config)}
      queryClient={createQueryClient()}
      router={createBrowserRouter(routes)}
    />,
  );
}

void bootstrap();
