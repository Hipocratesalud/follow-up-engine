import { useIsMutating, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  FastForward,
  FlaskConical,
  Send,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { type MouseEvent, type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import type { DemoConsultationResponse, InboxStats, WebhookDelivery } from '../../api/contract.ts';
import {
  DEMO_CONSULTATION_MUTATION_KEY,
  queryKeys,
  useAdvanceClock,
  useDemoClock,
  useStats,
  useWebhooks,
} from '../../api/queries.ts';
import { EmptyState, ErrorState, InlineError } from '../../components/states.tsx';
import { Badge, Button, Card, SectionTitle, Skeleton } from '../../components/ui.tsx';
import { cx } from '../../lib/cx.ts';
import { formatDateTime, formatLongDate } from '../../lib/format.ts';
import { WEBHOOK_LABELS } from '../../lib/labels.ts';
import { ConsultationForm } from './consultation-form.tsx';
import { ExtractionPlaceholder, ExtractionResult } from './extraction-result.tsx';

const ADVANCE_OPTIONS = [7, 15, 30, 90] as const;

interface AdvanceSummary {
  readonly days: number;
  readonly before: number | undefined;
  readonly after: number | undefined;
}

function ClockPanel({
  now,
  onAdvanced,
}: {
  readonly now: string;
  readonly onAdvanced: (previousNow: string) => void;
}): ReactNode {
  const queryClient = useQueryClient();
  const stats = useStats();
  const advance = useAdvanceClock();
  const [summary, setSummary] = useState<AdvanceSummary>();
  const [pendingDays, setPendingDays] = useState<number>();

  function handleAdvance(event: MouseEvent<HTMLButtonElement>): void {
    const days = Number(event.currentTarget.value);
    const before = stats.data?.activeCases;
    setPendingDays(days);
    advance.mutate(days, {
      onSuccess: () => {
        const after = queryClient.getQueryData<InboxStats>(queryKeys.stats)?.activeCases;
        setSummary({ days, before, after });
        onAdvanced(now);
      },
      onSettled: () => {
        setPendingDays(undefined);
      },
    });
  }

  const delta =
    summary?.before !== undefined && summary.after !== undefined
      ? summary.after - summary.before
      : undefined;

  return (
    <Card className="flex flex-col gap-4 overflow-hidden p-0">
      <div className="flex flex-col gap-4 bg-gradient-to-br from-warning-soft to-surface p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-warning uppercase">
            <CalendarClock className="size-3.5" aria-hidden="true" />
            Fecha simulada
          </p>
          <p className="mt-1 text-2xl font-semibold tracking-tight text-fg first-letter:uppercase sm:text-3xl">
            <time dateTime={now}>{formatLongDate(now)}</time>
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-muted" id="advance-label">
            Avanzar el tiempo
          </p>
          <div role="group" aria-labelledby="advance-label" className="flex flex-wrap gap-2">
            {ADVANCE_OPTIONS.map((days) => (
              <Button
                key={days}
                value={days}
                size="sm"
                variant="secondary"
                loading={pendingDays === days}
                onClick={handleAdvance}
                icon={<FastForward className="size-3.5" aria-hidden="true" />}
              >
                +{days} días
              </Button>
            ))}
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-2 px-5 pb-4">
        <p aria-live="polite" className="text-sm text-muted">
          {summary ? (
            <>
              Pasaron {summary.days} días. El motor revisó los vencimientos y escaló los casos sin
              respuesta
              {delta === undefined ? (
                '.'
              ) : (
                <>
                  : casos activos {summary.before}{' '}
                  <ArrowRight className="inline size-3.5" aria-hidden="true" />{' '}
                  <strong className="font-semibold text-fg">{summary.after}</strong>
                  {delta > 0 ? ` (+${String(delta)})` : ''}.
                </>
              )}{' '}
              <Link to="/bandeja" className="font-medium text-primary hover:underline">
                Ver la bandeja
              </Link>
            </>
          ) : (
            'Cada salto ejecuta lo que el motor haría con el paso de los días: vencer expectativas, abrir o agrupar casos y escalarlos.'
          )}
        </p>
        <InlineError error={advance.error} />
      </div>
    </Card>
  );
}

function WebhookItem({
  item,
  isNew,
}: {
  readonly item: WebhookDelivery;
  readonly isNew: boolean;
}): ReactNode {
  return (
    <li className={cx('flex flex-col gap-1.5 px-4 py-2.5', isNew && 'bg-primary-soft/40')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg">
          <Send className="size-3.5 text-primary" aria-hidden="true" />
          {WEBHOOK_LABELS[item.type] ?? item.type}
          <code className="font-mono text-[11px] font-normal text-subtle">{item.type}</code>
          {isNew ? <Badge tone="primary">Nuevo</Badge> : null}
        </span>
        <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
          {item.signatureValid ? (
            <Badge tone="success" icon={<ShieldCheck className="size-3" aria-hidden="true" />}>
              Firma válida
            </Badge>
          ) : (
            <Badge tone="danger" icon={<XCircle className="size-3" aria-hidden="true" />}>
              Firma inválida
            </Badge>
          )}
          {item.delivered ? (
            <Badge tone="success" icon={<CheckCircle2 className="size-3" aria-hidden="true" />}>
              Entregado
            </Badge>
          ) : (
            <Badge tone="warning">Pendiente de entrega</Badge>
          )}
          <time dateTime={item.at}>{formatDateTime(item.at)}</time>
        </span>
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted hover:text-fg">Ver contenido</summary>
        <pre className="mt-2 max-h-56 overflow-auto rounded-lg bg-surface-2 p-2.5 font-mono text-[11px] text-fg">
          {JSON.stringify(item.payload, null, 2)}
        </pre>
      </details>
    </li>
  );
}

function WebhookFeed({ newSince }: { readonly newSince: string | undefined }): ReactNode {
  const webhooks = useWebhooks(true);
  function handleRetry(): void {
    void webhooks.refetch();
  }
  return (
    <Card className="flex flex-col" aria-labelledby="webhooks-title">
      <div className="border-b border-border px-4 py-3">
        <SectionTitle id="webhooks-title" count={webhooks.data?.items.length}>
          Eventos enviados al sistema del consultorio
        </SectionTitle>
        <p className="mt-1 text-xs text-muted">
          Webhooks firmados: así el sistema del consultorio se entera de cada caso y decide cómo
          contactar al paciente.
        </p>
      </div>
      {webhooks.isPending ? (
        <div className="flex flex-col gap-2 p-4" aria-busy="true" aria-label="Cargando eventos">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : webhooks.isError ? (
        <ErrorState
          error={webhooks.error}
          onRetry={handleRetry}
          className="m-4"
          title="No pudimos cargar los eventos"
        />
      ) : webhooks.data.items.length === 0 ? (
        <EmptyState
          icon={<Send className="size-5" aria-hidden="true" />}
          title="Aún no hay eventos"
        >
          Aparecen cuando el motor abre, escala o cierra un caso.
        </EmptyState>
      ) : (
        <ul className="max-h-[560px] divide-y divide-border overflow-y-auto">
          {webhooks.data.items.map((item, index) => (
            <WebhookItem
              key={`${item.at}-${item.type}-${String(index)}`}
              item={item}
              isNew={newSince !== undefined && item.at > newSince}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

export function DemoPage(): ReactNode {
  const clock = useDemoClock();
  const consulting = useIsMutating({ mutationKey: DEMO_CONSULTATION_MUTATION_KEY }) > 0;
  const [result, setResult] = useState<{ response: DemoConsultationResponse; noteText: string }>();
  const [newSince, setNewSince] = useState<string>();

  function handleResult(response: DemoConsultationResponse, noteText: string): void {
    setResult({ response, noteText });
  }

  function handleAdvanced(previousNow: string): void {
    setNewSince(previousNow);
  }

  function handleRetry(): void {
    void clock.refetch();
  }

  if (clock.isPending) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Cargando demostración">
        <Skeleton className="h-32 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }
  if (clock.isError) {
    return (
      <ErrorState
        error={clock.error}
        onRetry={handleRetry}
        title="No pudimos consultar el reloj de la API"
      />
    );
  }
  if (!clock.data) {
    return (
      <EmptyState
        icon={<FlaskConical className="size-5" aria-hidden="true" />}
        title="Demostración no disponible"
      >
        El panel de demostración solo funciona cuando la API usa el reloj simulado.{' '}
        <Link to="/bandeja" className="font-medium text-primary hover:underline">
          Ir a la bandeja
        </Link>
      </EmptyState>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight text-fg">Demostración</h1>
        <p className="text-sm text-muted">
          De la consulta al caso: guarda una nota, mira lo que lee la IA y adelanta el reloj para
          ver cómo el motor abre y escala casos.
        </p>
      </header>
      <ClockPanel now={clock.data.now} onAdvanced={handleAdvanced} />
      <div className="grid items-start gap-5 xl:grid-cols-2">
        <ConsultationForm onResult={handleResult} />
        {result && !consulting ? (
          <ExtractionResult result={result.response} noteText={result.noteText} />
        ) : (
          <ExtractionPlaceholder pending={consulting} />
        )}
      </div>
      <WebhookFeed newSince={newSince} />
    </div>
  );
}
