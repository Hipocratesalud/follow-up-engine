import { CalendarClock, FlaskConical, HeartPulse, Inbox, UserRoundSearch } from 'lucide-react';
import type { ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router';
import { useDemoClock, useRecovery, useStats } from '../api/queries.ts';
import { cx } from '../lib/cx.ts';
import { formatDate } from '../lib/format.ts';
import { ThemeToggle } from './theme.tsx';

interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly icon: typeof Inbox;
  readonly count?: number | undefined;
}

function navClass({ isActive }: { isActive: boolean }): string {
  return cx(
    'group flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors whitespace-nowrap',
    isActive ? 'bg-primary-soft text-primary' : 'text-muted hover:bg-surface-2 hover:text-fg',
  );
}

function NavLinks({ items }: { readonly items: readonly NavItem[] }): ReactNode {
  return (
    <>
      {items.map(({ to, label, icon: Icon, count }) => (
        <NavLink key={to} to={to} className={navClass}>
          <Icon className="size-4 shrink-0" aria-hidden="true" />
          <span className="flex-1">{label}</span>
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
  return (
    <div className="flex items-center gap-2.5">
      <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-fg">
        <HeartPulse className="size-4.5" aria-hidden="true" />
      </span>
      <div className="leading-tight">
        <p className="text-sm font-semibold text-fg">Seguimiento</p>
        <p className="hidden text-xs text-muted sm:block">Centro Médico Los Álamos</p>
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

export function Shell(): ReactNode {
  const stats = useStats();
  const recovery = useRecovery();
  const clock = useDemoClock();

  const items: NavItem[] = [
    { to: '/bandeja', label: 'Bandeja', icon: Inbox, count: stats.data?.activeCases },
    {
      to: '/por-recuperar',
      label: 'Por recuperar',
      icon: UserRoundSearch,
      count: recovery.data?.total,
    },
  ];
  if (clock.data) items.push({ to: '/demo', label: 'Demo', icon: FlaskConical });

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[232px_1fr]">
      <a
        href="#contenido"
        className="sr-only z-50 rounded-lg bg-primary px-3 py-2 text-primary-fg focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Saltar al contenido
      </a>

      <aside className="hidden border-r border-border bg-surface lg:sticky lg:top-0 lg:flex lg:h-dvh lg:flex-col lg:gap-6 lg:px-4 lg:py-5">
        <Brand />
        <nav aria-label="Principal" className="flex flex-col gap-1">
          <NavLinks items={items} />
        </nav>
        <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-4">
          <div className="flex min-w-0 items-center gap-2">
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-3 text-xs font-semibold text-fg">
              LP
            </span>
            <div className="min-w-0 leading-tight">
              <p className="truncate text-sm font-medium text-fg">Dra. Lucía Paredes</p>
              <p className="truncate text-xs text-muted">Diabetología</p>
            </div>
          </div>
          <ThemeToggle />
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
          <nav
            aria-label="Principal"
            className="flex gap-1 overflow-x-auto border-t border-border px-3 py-2 lg:hidden"
          >
            <NavLinks items={items} />
          </nav>
        </header>
        <main id="contenido" className="px-4 py-5 lg:px-8 lg:py-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
