import {
  BarChart3,
  Beaker,
  Bot,
  CalendarClock,
  ChevronDown,
  ClipboardCheck,
  FlaskConical,
  HeartPulse,
  Inbox,
  ListChecks,
  Stethoscope,
  TrendingUp,
  UserRoundSearch,
  UsersRound,
} from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
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
import { usePageViewTracking } from '../api/evaluator-tracking.ts';
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

/** The sidebar's categories, in display order. */
const NAV_GROUP_KEYS = ['dailyWork', 'agents', 'results', 'tryIt'] as const;
type NavGroupKey = (typeof NAV_GROUP_KEYS)[number];

interface NavGroup {
  readonly key: NavGroupKey;
  readonly label: string;
  readonly items: readonly NavItem[];
}

function isNavGroupKey(value: unknown): value is NavGroupKey {
  return (NAV_GROUP_KEYS as readonly string[]).includes(value as string);
}

/** localStorage key of the viewer's collapsed categories. */
export const COLLAPSED_GROUPS_STORAGE_KEY = 'inbox-nav-collapsed-groups';

/** Reads the viewer's collapsed categories; a blocked or unreadable store falls back to none collapsed (all expanded). */
function readCollapsedGroups(): ReadonlySet<NavGroupKey> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_GROUPS_STORAGE_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter(isNavGroupKey) : []);
  } catch {
    return new Set();
  }
}

function storeCollapsedGroups(keys: ReadonlySet<NavGroupKey>): void {
  try {
    window.localStorage.setItem(COLLAPSED_GROUPS_STORAGE_KEY, JSON.stringify([...keys]));
  } catch {
    // Storage can be blocked (private mode); the toggle still works for this visit.
  }
}

/** The viewer's collapsed categories, remembered across visits. */
function useCollapsedGroups(): [ReadonlySet<NavGroupKey>, (key: NavGroupKey) => void] {
  const [collapsed, setCollapsed] = useState<ReadonlySet<NavGroupKey>>(readCollapsedGroups);
  function toggle(key: NavGroupKey): void {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      storeCollapsedGroups(next);
      return next;
    });
  }
  return [collapsed, toggle];
}

function isItemActive(pathname: string, to: string): boolean {
  return pathname === to || pathname.startsWith(`${to}/`);
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

/**
 * One sidebar category: a button that collapses or expands its items, with
 * a chevron and `aria-expanded`/`aria-controls`. Collapsed with a count on
 * one of its items, the header shows their sum instead.
 */
function NavGroupSection({
  group,
  expanded,
  onToggle,
}: {
  readonly group: NavGroup;
  readonly expanded: boolean;
  readonly onToggle: (key: NavGroupKey) => void;
}): ReactNode {
  const groupId = useId();
  const buttonId = `${groupId}-trigger`;
  const panelId = `${groupId}-panel`;

  function handleToggle(): void {
    onToggle(group.key);
  }

  const hasCounts = group.items.some((item) => item.count !== undefined);
  const collapsedCount = group.items.reduce((sum, item) => sum + (item.count ?? 0), 0);

  return (
    <div>
      <button
        type="button"
        id={buttonId}
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={handleToggle}
        className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-semibold tracking-wide text-muted uppercase transition-colors hover:bg-surface-2 hover:text-fg"
      >
        <span className="flex-1 truncate text-left">{group.label}</span>
        {!expanded && hasCounts ? (
          <span className="rounded-full bg-surface-2 px-1.5 text-xs font-medium tabular-nums text-muted">
            {collapsedCount}
          </span>
        ) : null}
        <ChevronDown
          className={cx('size-3.5 shrink-0 transition-transform', expanded && 'rotate-180')}
          aria-hidden="true"
        />
      </button>
      {expanded ? (
        <div
          id={panelId}
          role="group"
          aria-labelledby={buttonId}
          className="flex flex-col gap-1 pb-1"
        >
          <NavLinks items={group.items} />
        </div>
      ) : null}
    </div>
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
  usePageViewTracking();
  // The agents run in the evaluator's sandbox clinic, on its own clock: show that date there.
  const onAgent = pathname.startsWith('/agent') || pathname.startsWith('/rules');
  const labClock = useLabClock({ enabled: onAgent && Boolean(clock.data) });
  const shownNow = onAgent ? labClock.data?.now : clock.data?.now;
  const findings = useOpenShadowFindings();

  const dailyWorkItems: NavItem[] = [
    { to: '/inbox', label: t.nav.inbox, icon: Inbox, count: stats.data?.activePatients },
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
  ];
  // The agents only run once the API's demo clock exists (see `onAgent` above).
  const agentsItems: NavItem[] = clock.data
    ? [
        { to: '/agent', label: t.nav.agent, icon: Bot },
        { to: '/rules', label: t.nav.rules, icon: ListChecks },
      ]
    : [];
  const resultsItems: NavItem[] = [
    { to: '/metrics', label: t.nav.metrics, icon: BarChart3 },
    { to: '/value', label: t.nav.value, icon: TrendingUp },
  ];
  // Evaluation tools: only on the demo clock, and Evaluators only once identified.
  const tryItItems: NavItem[] = clock.data
    ? [
        { to: '/lab', label: t.nav.lab, icon: Beaker },
        { to: '/engine-tests', label: t.nav.engineTests, icon: ClipboardCheck },
        { to: '/demo', label: t.nav.demo, icon: FlaskConical },
        ...(evaluator.data?.email === undefined
          ? []
          : [{ to: '/evaluators', label: t.nav.evaluators, icon: UsersRound }]),
      ]
    : [];

  const allGroups: readonly NavGroup[] = [
    { key: 'dailyWork', label: t.nav.groups.dailyWork, items: dailyWorkItems },
    { key: 'agents', label: t.nav.groups.agents, items: agentsItems },
    { key: 'results', label: t.nav.groups.results, items: resultsItems },
    { key: 'tryIt', label: t.nav.groups.tryIt, items: tryItItems },
  ];
  const groups = allGroups.filter((group) => group.items.length > 0);
  const items = groups.flatMap((group) => group.items);
  const [collapsedGroups, toggleGroup] = useCollapsedGroups();

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
          <nav aria-label={t.common.mainNav} className="flex flex-col gap-3">
            {groups.map((group) => (
              <NavGroupSection
                key={group.key}
                group={group}
                expanded={
                  !collapsedGroups.has(group.key) ||
                  group.items.some((item) => isItemActive(pathname, item.to))
                }
                onToggle={toggleGroup}
              />
            ))}
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
