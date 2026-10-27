import type { ReactNode } from 'react';
import { Navigate, useParams, useSearchParams, type RouteObject } from 'react-router';
import { Shell } from './components/shell.tsx';
import { CaseDetailPanel } from './features/case/case-detail.tsx';
import { DemoPage } from './features/demo/demo-page.tsx';
import { InboxPage } from './features/inbox/inbox-page.tsx';
import { NotFoundPage, PatientPage } from './features/patient/patient-page.tsx';
import { RecoveryPage, StandaloneCasePage } from './features/recovery/recovery-page.tsx';

function InboxCaseRoute(): ReactNode {
  const { caseId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const search = searchParams.toString();
  return (
    <CaseDetailPanel
      key={caseId}
      caseId={caseId}
      backTo={`/bandeja${search ? `?${search}` : ''}`}
    />
  );
}

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <Shell />,
    children: [
      { index: true, element: <Navigate to="/bandeja" replace /> },
      {
        path: 'bandeja',
        element: <InboxPage />,
        children: [{ path: ':caseId', element: <InboxCaseRoute /> }],
      },
      { path: 'casos/:caseId', element: <StandaloneCasePage /> },
      { path: 'pacientes/:patientId', element: <PatientPage /> },
      { path: 'por-recuperar', element: <RecoveryPage /> },
      { path: 'demo', element: <DemoPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
