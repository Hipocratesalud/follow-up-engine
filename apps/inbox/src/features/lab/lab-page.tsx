import type { ReactNode } from 'react';
import { useT } from '../../i18n/index.ts';
import { useSessionState } from '../../lib/session-state.ts';
import { ImpactPanel } from './impact-panel.tsx';
import { PatientPicker } from './patient-picker.tsx';
import { LabWorkspace } from './lab-workspace.tsx';

/**
 * The evaluator lab (docs/deploy.md#hosted-demo): a per-evaluator sandbox
 * clinic, isolated from the shared demo and from every other evaluator.
 * Pick or create a lab patient, add documents and structured records to
 * their record, and see the impact on a date.
 */
export function LabPage(): ReactNode {
  const t = useT();
  const [patientId, setPatientId] = useSessionState<string>('lab-selected-patient');

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight text-fg">{t.lab.title}</h1>
        <p className="text-sm text-muted">{t.lab.intro}</p>
      </header>
      <div className="grid grid-cols-1 items-start gap-5 *:min-w-0 xl:grid-cols-[320px_1fr]">
        <PatientPicker patientId={patientId} onSelect={setPatientId} />
        <div className="flex flex-col gap-5">
          {patientId ? (
            <LabWorkspace key={patientId} patientId={patientId} />
          ) : (
            <p className="rounded-xl border border-dashed border-border-strong px-6 py-10 text-center text-sm text-muted">
              {t.lab.noPatientSelected}
            </p>
          )}
        </div>
      </div>
      <ImpactPanel />
    </div>
  );
}
