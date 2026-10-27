import type { ReactNode } from 'react';
import { Navigate, useLocation, useParams, useSearchParams, type RouteObject } from 'react-router';
import { Shell } from './components/shell.tsx';
import { DemoPage } from './features/demo/demo-page.tsx';
import { InboxPage } from './features/inbox/inbox-page.tsx';
import { MetricsPage } from './features/metrics/metrics-page.tsx';
import { NotFoundPage, PatientPage } from './features/patient/patient-page.tsx';
import { PatientCasesPanel } from './features/patient-queue/patient-panel.tsx';
import { RecoveryPage, StandaloneCasePage } from './features/recovery/recovery-page.tsx';
import { FindingDetailPanel } from './features/reviewer/finding-detail.tsx';
import { FlagsPage } from './features/reviewer/flags-page.tsx';
import { ReviewPage } from './features/reviewer/review-page.tsx';

/** Links to another case of the open patient card, keeping the inbox filters. */
function caseLinkWith(search: string): (caseId: string) => string {
  return (caseId) => `/inbox/${caseId}${search ? `?${search}` : ''}`;
}

function InboxCaseRoute(): ReactNode {
  const { caseId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const search = searchParams.toString();
  return (
    <PatientCasesPanel
      key={caseId}
      caseId={caseId}
      backTo={`/inbox${search ? `?${search}` : ''}`}
      caseLink={caseLinkWith(search)}
    />
  );
}

function ReviewFindingRoute(): ReactNode {
  const { findingId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const search = searchParams.toString();
  return (
    <FindingDetailPanel
      key={findingId}
      findingId={findingId}
      backTo={`/clinical-review${search ? `?${search}` : ''}`}
    />
  );
}

/**
 * Links saved before the paths were English (`/bandeja/…`, `/pacientes/…`)
 * keep working: the same place under its English path.
 */
const LEGACY_PREFIXES: readonly (readonly [string, string])[] = [
  ['/revision-clinica/categorias', '/clinical-review/categories'],
  ['/revision-clinica', '/clinical-review'],
  ['/por-recuperar', '/recovery'],
  ['/pacientes', '/patients'],
  ['/bandeja', '/inbox'],
  ['/casos', '/cases'],
];

function LegacyRedirect(): ReactNode {
  const { pathname } = useLocation();
  const match = LEGACY_PREFIXES.find(([from]) => pathname.startsWith(from));
  return <Navigate to={match ? match[1] + pathname.slice(match[0].length) : '/inbox'} replace />;
}

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <Shell />,
    children: [
      { index: true, element: <Navigate to="/inbox" replace /> },
      {
        path: 'inbox',
        element: <InboxPage />,
        children: [{ path: ':caseId', element: <InboxCaseRoute /> }],
      },
      { path: 'cases/:caseId', element: <StandaloneCasePage /> },
      { path: 'patients/:patientId', element: <PatientPage /> },
      { path: 'recovery', element: <RecoveryPage /> },
      { path: 'clinical-review/categories', element: <FlagsPage /> },
      {
        path: 'clinical-review',
        element: <ReviewPage />,
        children: [{ path: ':findingId', element: <ReviewFindingRoute /> }],
      },
      { path: 'metrics', element: <MetricsPage /> },
      { path: 'demo', element: <DemoPage /> },
      ...LEGACY_PREFIXES.map(([from]) => ({
        path: `${from.slice(1)}/*`,
        element: <LegacyRedirect />,
      })),
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
