import {
  BarChart3,
  Beaker,
  Bot,
  CalendarClock,
  ClipboardCheck,
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
  useEvaluator,
  useLabClock,
  useOpenShadowFindings,
  useRecovery,
  useStats,
} from '../api/queries.ts';
import { cx } from '../lib/cx.ts';
import { useT } from '../i18n/index.ts';
import { formatDate, formatShortDate } from '../lib/format.ts';
import { EvaluatorBanner } from './evaluator-banner.tsx';
import { LanguageSwitch } from './language-switch.tsx';
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
  const t = useT();
  const clinic = useClinic();
  return (
    <div className="flex items-center gap-2.5">
      <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-fg">
        <HeartPulse className="size-4.5" aria-hidden="true" />
      </span>
      <div className="leading-tight">
        <p className="text-sm font-semibold whitespace-nowrap text-fg">{t.common.appName}</p>
        {clinic.data || clinic.isError ? (
          <p className="hidden max-w-[150px] truncate text-xs text-muted sm:block">
            {clinic.data?.name ?? t.common.clinicFallback}
          </p>
        ) : (
          <span aria-hidden="true" className="skeleton mt-1 hidden h-3 w-28 rounded sm:block" />
        )}
      </div>
    </div>
  );
}

function SimulatedDate({ now }: { readonly now: string }): ReactNode {
  const t = useT();
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-warning/30 bg-warning-soft px-2.5 py-1 text-xs font-medium text-warning"
      title={t.nav.simulatedDateTitle}
    >
      <CalendarClock className="size-3.5" aria-hidden="true" />
      <span className="hidden sm:inline">{t.nav.simulatedDate}</span>
      <time dateTime={now}>
        <span className="sm:hidden">{formatShortDate(now)}</span>
        <span className="max-sm:hidden">{formatDate(now)}</span>
      </time>
    </span>
  );
}

/**
 * The phone's horizontal nav keeps the current page in view (a narrow
 * screen may still scroll it).
 */
function MobileNav({ items }: { readonly items: readonly NavItem[] }): ReactNode {
  const t = useT();
  const nav = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  useEffect(() => {
    const active = nav.current?.querySelector<HTMLElement>('[aria-current="page"]');
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [pathname, items.length]);
  return (
    <nav
      ref={nav}
      aria-label={t.common.mainNav}
      className="flex gap-1 overflow-x-auto border-t border-border px-3 py-2 lg:hidden"
    >
      <NavLinks items={items} compact />
    </nav>
  );
}

export function Shell(): ReactNode {
  const t = useT();
  const stats = useStats();
  const recovery = useRecovery();
  const clock = useDemoClock();
  const evaluator = useEvaluator();
  const { pathname } = useLocation();
  // The agent runs in the evaluator's sandbox clinic, on its own clock: show that date there.
  const onAgent = pathname.startsWith('/agent');
  const labClock = useLabClock({ enabled: onAgent && Boolean(clock.data) });
  const shownNow = onAgent ? labClock.data?.now : clock.data?.now;
  const findings = useOpenShadowFindings();

  const items: NavItem[] = [
    { to: '/inbox', label: t.nav.inbox, icon: Inbox, count: stats.data?.activePatients },
  ];
  // Lab is the evaluator's primary action: right after Inbox.
  if (clock.data) {
    items.push({ to: '/lab', label: t.nav.lab, icon: Beaker });
    items.push({ to: '/agent', label: t.nav.agent, icon: Bot });
  }
  items.push(
    {
      to: '/recovery',
      label: t.nav.recovery,
      icon: UserRoundSearch,
      count: recovery.data?.total,
    },
    {
      to: '/clinical-review',
      label: t.nav.review,
      shortLabel: t.nav.reviewShort,
      icon: Stethoscope,
      count: findings.data?.counts.byStatus.open,
    },
  );
  items.push({ to: '/metrics', label: t.nav.metrics, icon: BarChart3 });
  if (clock.data) {
    items.push({ to: '/demo', label: t.nav.demo, icon: FlaskConical });
    items.push({ to: '/engine-tests', label: t.nav.engineTests, icon: ClipboardCheck });
    if (evaluator.data?.email !== undefined) {
      items.push({ to: '/evaluators', label: t.nav.evaluators, icon: UsersRound });
    }
  }

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[232px_1fr]">
      <a
        href="#content"
        className="sr-only z-50 rounded-lg bg-primary px-3 py-2 text-primary-fg focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        {t.common.skipToContent}
      </a>

      {/*
        The column spans the whole page height (border and background never
        end mid-page); only its content sticks to the viewport.
      */}
      <aside className="hidden border-r border-border bg-surface lg:block">
        <div className="sticky top-0 flex h-dvh flex-col gap-6 overflow-y-auto px-4 py-5">
          <Brand />
          <nav aria-label={t.common.mainNav} className="flex flex-col gap-1">
            <NavLinks items={items} />
          </nav>
          <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-4">
            <div className="flex min-w-0 items-center gap-2">
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-3 text-fg">
                <UsersRound className="size-4" aria-hidden="true" />
              </span>
              <div className="min-w-0 leading-tight">
                <p className="truncate text-sm font-medium text-fg">{t.common.yourTeam}</p>
                <p className="truncate text-xs text-muted">
                  {clock.data ? t.common.demoSubtitle : t.common.clinicSubtitle}
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
              <EvaluatorBanner />
              {clock.data && shownNow !== undefined ? <SimulatedDate now={shownNow} /> : null}
              <LanguageSwitch compact />
              <div className="lg:hidden">
                <ThemeToggle />
              </div>
            </div>
          </div>
          <MobileNav items={items} />
        </header>
        <main id="content" className="px-4 py-5 lg:px-8 lg:py-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
