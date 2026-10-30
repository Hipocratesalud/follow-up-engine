import { useCallback, useEffect, useRef } from 'react';
import { useLocation } from 'react-router';
import type { ClientEvaluatorEvent, TrackedPage } from './contract.ts';
import { useApi, useEvaluator } from './queries.ts';

/**
 * The evaluator log (docs/deploy.md#hosted-demo) for what only the browser
 * sees: page views and the agent page's selects. Only with an evaluator
 * identity (the hosted demo's access gate); best effort, never in the way.
 */
export function useTrackEvaluatorEvent(): (event: ClientEvaluatorEvent) => void {
  const api = useApi();
  const evaluator = useEvaluator();
  const signedIn = evaluator.data?.email !== undefined;
  return useCallback(
    (event: ClientEvaluatorEvent) => {
      if (!signedIn) return;
      api.trackEvaluatorEvent(event).catch(ignoreTrackingError);
    },
    [api, signedIn],
  );
}

function ignoreTrackingError(): void {
  // Tracking never interrupts the evaluator: a lost page view is acceptable.
}

const PAGES: readonly (readonly [prefix: string, page: TrackedPage])[] = [
  ['/inbox', 'inbox'],
  ['/lab', 'lab'],
  ['/agent', 'agent'],
  ['/value', 'value'],
  ['/engine-tests', 'engine_tests'],
  ['/clinical-review', 'clinical_review'],
  ['/metrics', 'metrics'],
  ['/demo', 'demo'],
  ['/evaluators', 'evaluators'],
  ['/recovery', 'recovery'],
];

/** The tracked page a path shows, with the patient of a patient page. */
export function trackedPageOf(
  pathname: string,
): { readonly page: TrackedPage; readonly patientId?: string } | undefined {
  const patient = /^\/patients\/([^/]+)/.exec(pathname);
  if (patient?.[1] !== undefined) {
    return { page: 'patient', patientId: decodeURIComponent(patient[1]) };
  }
  const match = PAGES.find(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`));
  return match === undefined ? undefined : { page: match[1] };
}

/**
 * One `page_viewed` per page opened (a case or finding opened inside a
 * page is not a new page view: the server logs `case_viewed` itself).
 */
export function usePageViewTracking(): void {
  const { pathname } = useLocation();
  const api = useApi();
  const evaluator = useEvaluator();
  const signedIn = evaluator.data?.email !== undefined;
  const last = useRef<string | undefined>(undefined);
  useEffect(() => {
    // Sent once the identity is known (the effect runs again when it is).
    if (!signedIn) return;
    const view = trackedPageOf(pathname);
    if (view === undefined) return;
    const key = `${view.page}:${view.patientId ?? ''}`;
    if (last.current === key) return;
    last.current = key;
    api
      .trackEvaluatorEvent({
        action: 'page_viewed',
        page: view.page,
        ...(view.patientId === undefined ? {} : { patientId: view.patientId }),
      })
      .catch(ignoreTrackingError);
  }, [pathname, api, signedIn]);
}
