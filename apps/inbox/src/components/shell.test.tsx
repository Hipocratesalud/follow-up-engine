import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { en } from '../i18n/en.ts';
import { es } from '../i18n/es.ts';
import { renderApp } from '../test/render.tsx';
import { COLLAPSED_GROUPS_STORAGE_KEY } from './shell.tsx';

/**
 * The sidebar sorts every nav item into four categories: Daily work, Agents,
 * Results and Try it. Each category's header is a collapsible disclosure
 * button; `complementary` (the `<aside>`) scopes every query to the desktop
 * sidebar, since the phone's horizontal nav duplicates the same links.
 */

function sidebar(): HTMLElement {
  return screen.getByRole('complementary');
}

/** The phone's horizontal nav: the "Main" navigation outside the `<aside>`. */
function mobileNav(): HTMLElement {
  const navs = screen.getAllByRole('navigation', { name: en.common.mainNav });
  const found = navs.find((nav) => nav.closest('aside') === null);
  if (!found) throw new Error('expected the mobile nav outside the sidebar');
  return found;
}

/** The trailing run of digits in an element's text (a count badge, or none). */
function trailingNumber(text: string | null): number {
  const match = /(\d+)\s*$/.exec(text ?? '');
  return match ? Number(match[1]) : 0;
}

describe('Shell sidebar categories', () => {
  it('sorts the nav items into Daily work, Agents, Results and Try it', async () => {
    renderApp('/inbox');
    const nav = sidebar();
    // Agent/Rules/Lab/etc. only render once the API's demo clock has loaded.
    await within(nav).findByRole('link', { name: en.nav.agent });

    const dailyWork = within(nav).getByRole('group', { name: en.nav.groups.dailyWork });
    expect(within(dailyWork).getByRole('link', { name: new RegExp(en.nav.inbox) })).toBeVisible();
    expect(
      within(dailyWork).getByRole('link', { name: new RegExp(en.nav.recovery) }),
    ).toBeVisible();
    expect(within(dailyWork).getByRole('link', { name: new RegExp(en.nav.review) })).toBeVisible();

    const agents = within(nav).getByRole('group', { name: en.nav.groups.agents });
    expect(within(agents).getByRole('link', { name: en.nav.agent })).toBeVisible();
    expect(within(agents).getByRole('link', { name: en.nav.rules })).toBeVisible();

    const results = within(nav).getByRole('group', { name: en.nav.groups.results });
    expect(within(results).getByRole('link', { name: en.nav.metrics })).toBeVisible();
    expect(within(results).getByRole('link', { name: en.nav.value })).toBeVisible();

    const tryIt = within(nav).getByRole('group', { name: en.nav.groups.tryIt });
    expect(within(tryIt).getByRole('link', { name: en.nav.lab })).toBeVisible();
    expect(within(tryIt).getByRole('link', { name: en.nav.engineTests })).toBeVisible();
    expect(within(tryIt).getByRole('link', { name: en.nav.demo })).toBeVisible();
  });

  it('collapses and expands a category from its header button, chevron and all', async () => {
    const { user } = renderApp('/value');
    const nav = sidebar();
    await within(nav).findByRole('link', { name: new RegExp(en.nav.value) });

    const header = within(nav).getByRole('button', { name: en.nav.groups.dailyWork });
    expect(header).toHaveAttribute('aria-expanded', 'true');
    const panelId = header.getAttribute('aria-controls');
    expect(panelId).toBeTruthy();
    expect(document.getElementById(panelId ?? '')).toBeInTheDocument();

    // Sum the three items' counts before collapsing the group.
    const inboxCount = trailingNumber(
      within(nav).getByRole('link', { name: new RegExp(en.nav.inbox) }).textContent,
    );
    const recoveryCount = trailingNumber(
      within(nav).getByRole('link', { name: new RegExp(en.nav.recovery) }).textContent,
    );
    const reviewCount = trailingNumber(
      within(nav).getByRole('link', { name: new RegExp(en.nav.review) }).textContent,
    );
    const expectedSum = inboxCount + recoveryCount + reviewCount;

    await user.click(header);

    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById(panelId ?? '')).not.toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: new RegExp(en.nav.inbox) })).toBeNull();
    if (expectedSum > 0) {
      expect(trailingNumber(header.textContent)).toBe(expectedSum);
    }

    await user.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'true');
    expect(within(nav).getByRole('link', { name: new RegExp(en.nav.inbox) })).toBeVisible();
  });

  it('toggles a category with the keyboard', async () => {
    const { user } = renderApp('/value');
    const nav = sidebar();
    await within(nav).findByRole('link', { name: new RegExp(en.nav.value) });

    const header = within(nav).getByRole('button', { name: en.nav.groups.dailyWork });
    header.focus();
    expect(header).toHaveAttribute('aria-expanded', 'true');

    await user.keyboard('{Enter}');
    expect(header).toHaveAttribute('aria-expanded', 'false');

    await user.keyboard(' ');
    expect(header).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps the category of the current route expanded, even collapsed in storage', async () => {
    localStorage.setItem(COLLAPSED_GROUPS_STORAGE_KEY, JSON.stringify(['dailyWork', 'results']));
    renderApp('/inbox');
    const nav = sidebar();
    await within(nav).findByRole('link', { name: en.nav.agent });

    // Daily work holds the active route (/inbox): forced open despite storage.
    expect(within(nav).getByRole('button', { name: en.nav.groups.dailyWork })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    // Results holds no active route: it stays collapsed, as stored.
    expect(within(nav).getByRole('button', { name: en.nav.groups.results })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    // Agents was never collapsed: it stays expanded, the default.
    expect(within(nav).getByRole('button', { name: en.nav.groups.agents })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('writes a toggled category to storage, for the viewer: next visit to read back', async () => {
    const { user } = renderApp('/value');
    const nav = sidebar();
    await within(nav).findByRole('link', { name: en.nav.agent });
    const agentsHeader = within(nav).getByRole('button', { name: en.nav.groups.agents });

    await user.click(agentsHeader);
    expect(agentsHeader).toHaveAttribute('aria-expanded', 'false');
    expect(JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_STORAGE_KEY) ?? '[]')).toEqual([
      'agents',
    ]);

    await user.click(agentsHeader);
    expect(agentsHeader).toHaveAttribute('aria-expanded', 'true');
    expect(JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_STORAGE_KEY) ?? '[]')).toEqual([]);
  });

  it('still shows the sidebar, all expanded, when storage is blocked', async () => {
    localStorage.setItem(COLLAPSED_GROUPS_STORAGE_KEY, 'not json');
    renderApp('/inbox');
    const nav = sidebar();
    await within(nav).findByRole('link', { name: en.nav.agent });
    for (const label of [
      en.nav.groups.dailyWork,
      en.nav.groups.agents,
      en.nav.groups.results,
      en.nav.groups.tryIt,
    ]) {
      expect(within(nav).getByRole('button', { name: label })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
    }
  });

  it('shows the categories in Spanish', async () => {
    renderApp('/inbox', { locale: 'es' });
    const nav = sidebar();
    await within(nav).findByRole('link', { name: es.nav.agent });
    expect(within(nav).getByRole('button', { name: es.nav.groups.dailyWork })).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: es.nav.groups.agents })).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: es.nav.groups.results })).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: es.nav.groups.tryIt })).toBeInTheDocument();
  });

  it('keeps the mobile top bar working, flattened across every category', () => {
    renderApp('/inbox');
    // The phone's nav has no category headers: every item is a direct link.
    const nav = mobileNav();
    expect(within(nav).queryByRole('button')).toBeNull();
    expect(within(nav).getByRole('link', { name: new RegExp(en.nav.inbox) })).toBeVisible();
  });
});
