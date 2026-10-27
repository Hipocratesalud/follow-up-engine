export type ApiMode = 'mock' | 'live';

export interface ApiConfig {
  /** Origin of apps/api, without the `/api` suffix. Empty in mock mode (same origin). */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly mode: ApiMode;
}

/** Key the mock API accepts. Not a secret: it only unlocks synthetic data in the browser. */
export const MOCK_API_KEY = 'demo-clinic-key';

interface InboxEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_API_KEY?: string;
}

/**
 * Live mode needs both `VITE_API_URL` and `VITE_API_KEY`; anything else falls
 * back to the in-browser mock so the inbox always opens.
 */
export function readApiConfig(env: InboxEnv): ApiConfig {
  const url = env.VITE_API_URL?.trim();
  const key = env.VITE_API_KEY?.trim();
  if (url && key) {
    return { baseUrl: url.replace(/\/+$/, ''), apiKey: key, mode: 'live' };
  }
  return { baseUrl: '', apiKey: MOCK_API_KEY, mode: 'mock' };
}
