import { ArrowLeft, Info, PartyPopper } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { useRecovery } from '../../api/queries.ts';
import { EmptyState, ErrorState } from '../../components/states.tsx';
import { CaseDetailPanel } from '../case/case-detail.tsx';
import { CaseRow, CaseRowSkeleton } from '../inbox/case-row.tsx';

export function RecoveryPage(): ReactNode {
  const recovery = useRecovery();
  function handleRetry(): void {
    void recovery.refetch();
  }
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight text-fg">Pacientes por recuperar</h1>
        <p className="text-sm text-muted">
          Pacientes que perdieron su seguimiento antes de que el consultorio usara el motor.
        </p>
      </header>

      <div
        role="note"
        className="flex gap-3 rounded-xl border border-info/30 bg-info-soft p-4 text-sm text-fg"
      >
        <Info className="mt-0.5 size-4 shrink-0 text-info" aria-hidden="true" />
        <div className="flex flex-col gap-1">
          <p className="font-medium">No son notificaciones.</p>
          <p className="text-muted">
            Salieron de revisar el historial del consultorio. Nadie recibe avisos por ellos todavía:
            entran a la bandeja poco a poco, por prioridad y con un tope diario por responsable,
            para que el equipo pueda atenderlos sin saturarse.
          </p>
        </div>
      </div>

      {recovery.isPending ? (
        <div aria-busy="true" aria-label="Cargando pacientes" className="flex flex-col gap-1">
          {[0, 1, 2, 3].map((key) => (
            <CaseRowSkeleton key={key} />
          ))}
        </div>
      ) : recovery.isError ? (
        <ErrorState
          error={recovery.error}
          onRetry={handleRetry}
          title="No pudimos cargar la lista"
        />
      ) : recovery.data.items.length === 0 ? (
        <EmptyState
          icon={<PartyPopper className="size-5" aria-hidden="true" />}
          title="No quedan pacientes por recuperar"
        >
          Todos los pacientes del historial ya están en la bandeja.
        </EmptyState>
      ) : (
        <section aria-labelledby="recovery-list-title" className="flex flex-col gap-2">
          <h2 id="recovery-list-title" className="text-sm font-semibold text-fg">
            {recovery.data.total} {recovery.data.total === 1 ? 'paciente' : 'pacientes'} en espera,
            por prioridad
          </h2>
          <ul className="flex flex-col gap-1 rounded-xl border border-border bg-surface p-1.5 shadow-card">
            {recovery.data.items.map((item) => (
              <li key={item.id}>
                <CaseRow item={item} to={`/casos/${item.id}`} showRelease />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** A case outside the inbox split view (for example, one still waiting to be released). */
export function StandaloneCasePage(): ReactNode {
  const { caseId = '' } = useParams();
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <h1 className="sr-only">Detalle del caso</h1>
      <Link
        to="/por-recuperar"
        className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-muted hover:text-fg"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Pacientes por recuperar
      </Link>
      <CaseDetailPanel key={caseId} caseId={caseId} />
    </div>
  );
}
