import {
  BarChart3,
  CalendarClock,
  FlaskConical,
  HeartPulse,
  Inbox,
  Stethoscope,
  UserRoundSearch,
  UsersRound,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import {
  useClinic,
  useDemoClock,
  useOpenShadowFindings,
  useRecovery,
  useStats,
} from '../api/queries.ts';
import { cx } from '../lib/cx.ts';
import { formatDate } from '../lib/format.ts';
import { REVIEW_COPY } from '../features/reviewer/copy.ts';
import { metricsCopy } from '../features/metrics/copy.ts';
import { ThemeToggle } from './theme.tsx';

interface NavItem {
  readonly to: string;
  readonly label: string;
  /** Shorter label for the phone's top bar. */
  readonly shortLabel?: string;
  readonly icon: typeof Inbox;
  readonly count?: number | undefined;
}

function navClass({ isActive }: { isActive: boolean }): string {
  return cx(
    'group flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors whitespace-nowrap',
    isActive ? 'bg-primary-soft text-primary' : 'text-muted hover:bg-surface-2 hover:text-fg',
  );
}

/** The top bar of a phone: tighter, and the icons only from `sm` up, so the three items fit at 375 px. */
function compactNavClass({ isActive }: { isActive: boolean }): string {
  return cx(navClass({ isActive }), 'shrink-0 justify-center gap-1.5 px-2.5 max-sm:flex-1 sm:px-3');
}

function NavLinks({
  items,
  compact = false,
}: {
  readonly items: readonly NavItem[];
  readonly compact?: boolean;
}): ReactNode {
  return (
    <>
      {items.map(({ to, label, shortLabel, icon: Icon, count }) => (
        <NavLink key={to} to={to} className={compact ? compactNavClass : navClass}>
          <Icon className={cx('size-4 shrink-0', compact && 'max-sm:hidden')} aria-hidden="true" />
          {compact && shortLabel ? (
            <>
              <span className="sm:hidden">{shortLabel}</span>
              <span className="max-sm:hidden">{label}</span>
            </>
          ) : (
            <span className={compact ? undefined : 'flex-1'}>{label}</span>
          )}
          {count === undefined ? null : (
            <span className="rounded-full bg-surface-2 px-1.5 text-xs tabular-nums text-muted group-aria-[current=page]:bg-surface">
              {count}
            </span>
          )}
        </NavLink>
      ))}
    </>
  );
}

function Brand(): ReactNode {
  const clinic = useClinic();
  return (
    <div className="flex items-center gap-2.5">
      <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-fg">
        <HeartPulse className="size-4.5" aria-hidden="true" />
      </span>
      <div className="leading-tight">
        <p className="text-sm font-semibold text-fg">Seguimiento</p>
        {clinic.data || clinic.isError ? (
          <p className="hidden max-w-[150px] truncate text-xs text-muted sm:block">
            {clinic.data?.name ?? 'Consultorio'}
          </p>
        ) : (
          <span aria-hidden="true" className="skeleton mt-1 hidden h-3 w-28 rounded sm:block" />
        )}
      </div>
    </div>
  );
}

function SimulatedDate({ now }: { readonly now: string }): ReactNode {
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-warning/30 bg-warning-soft px-2.5 py-1 text-xs font-medium text-warning"
      title="La API usa un reloj simulado para la demostración"
    >
      <CalendarClock className="size-3.5" aria-hidden="true" />
      <span className="hidden sm:inline">Fecha simulada:</span>
      <time dateTime={now}>{formatDate(now)}</time>
    </span>
  );
}

/**
 * The phone's horizontal nav keeps the current page in view (a narrow
 * screen may still scroll it).
 */
function MobileNav({ items }: { readonly items: readonly NavItem[] }): ReactNode {
  const nav = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  useEffect(() => {
    const active = nav.current?.querySelector<HTMLElement>('[aria-current="page"]');
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [pathname, items.length]);
  return (
    <nav
      ref={nav}
      aria-label="Principal"
      className="flex gap-1 overflow-x-auto border-t border-border px-3 py-2 lg:hidden"
    >
      <NavLinks items={items} compact />
    </nav>
  );
}

export function Shell(): ReactNode {
  const stats = useStats();
  const recovery = useRecovery();
  const clock = useDemoClock();
  const findings = useOpenShadowFindings();

  const items: NavItem[] = [
    { to: '/bandeja', label: 'Bandeja', icon: Inbox, count: stats.data?.activeCases },
    {
      to: '/por-recuperar',
      label: 'Por recuperar',
      icon: UserRoundSearch,
      count: recovery.data?.total,
    },
    {
      to: '/revision-clinica',
      label: REVIEW_COPY.nav.label,
      shortLabel: REVIEW_COPY.nav.shortLabel,
      icon: Stethoscope,
      count: findings.data?.counts.byStatus.open,
    },
  ];
  items.push({ to: '/metricas', label: metricsCopy().nav.label, icon: BarChart3 });
  if (clock.data) items.push({ to: '/demo', label: 'Demo', icon: FlaskConical });

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[232px_1fr]">
      <a
        href="#contenido"
        className="sr-only z-50 rounded-lg bg-primary px-3 py-2 text-primary-fg focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Saltar al contenido
      </a>

      {/*
        The column spans the whole page height (border and background never
        end mid-page); only its content sticks to the viewport.
      */}
      <aside className="hidden border-r border-border bg-surface lg:block">
        <div className="sticky top-0 flex h-dvh flex-col gap-6 overflow-y-auto px-4 py-5">
          <Brand />
          <nav aria-label="Principal" className="flex flex-col gap-1">
            <NavLinks items={items} />
          </nav>
          <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-4">
            <div className="flex min-w-0 items-center gap-2">
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-3 text-fg">
                <UsersRound className="size-4" aria-hidden="true" />
              </span>
              <div className="min-w-0 leading-tight">
                <p className="truncate text-sm font-medium text-fg">Tu equipo</p>
                <p className="truncate text-xs text-muted">
                  {clock.data ? 'Demostración' : 'Consultorio'}
                </p>
              </div>
            </div>
            <ThemeToggle />
          </div>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-30 border-b border-border bg-surface/90 backdrop-blur lg:bg-bg/80">
          <div className="flex h-14 items-center justify-between gap-3 px-4 lg:px-8">
            <div className="lg:hidden">
              <Brand />
            </div>
            <div className="ml-auto flex items-center gap-2">
              {clock.data ? <SimulatedDate now={clock.data.now} /> : null}
              <div className="lg:hidden">
                <ThemeToggle />
              </div>
            </div>
          </div>
          <MobileNav items={items} />
        </header>
        <main id="contenido" className="px-4 py-5 lg:px-8 lg:py-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
