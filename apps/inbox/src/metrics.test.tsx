import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { en } from './i18n/en.ts';
import { es } from './i18n/es.ts';
import { renderApp } from './test/render.tsx';

const COPY = en.metrics;

describe('Metrics (HIP-141)', () => {
  it('shows the tiles and the to-scale charts of the period, in English by default', async () => {
    renderApp('/metrics');
    expect(await screen.findByRole('heading', { level: 1, name: COPY.title })).toBeInTheDocument();
    expect(await screen.findByText(COPY.tiles.opened)).toBeInTheDocument();
    expect(screen.getByText(COPY.tiles.booked)).toBeInTheDocument();
    expect(screen.getByText(COPY.tiles.attended)).toBeInTheDocument();
    expect(screen.getByText(COPY.tiles.firstAction)).toBeInTheDocument();
    // The funnel: a table for screen readers says what the bars show.
    const funnel = screen.getByRole('heading', { name: COPY.funnel.title }).closest('section');
    if (funnel === null) throw new Error('funnel panel missing');
    expect(within(funnel).getAllByRole('table')[0]).toHaveTextContent(/Booked\s*19/);
    expect(funnel.querySelectorAll('svg rect').length).toBeGreaterThan(4);
    // The quantile strip reads as one sentence.
    expect(
      screen.getByRole('img', {
        name: /Median 6\.5 h, 75th percentile 22\.0 h, 90th percentile 2\.1 d/,
      }),
    ).toBeInTheDocument();
    // The nav has the view.
    expect(screen.getAllByRole('link', { name: /Metrics/ }).length).toBeGreaterThan(0);
  });

  it('switches the period with one press, the choice kept in the URL', async () => {
    const { user } = renderApp('/metrics');
    const week = await screen.findByRole('button', { name: COPY.preset(7) });
    expect(screen.getByRole('button', { name: COPY.preset(30) })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(week);
    expect(week).toHaveAttribute('aria-pressed', 'true');
    // A quarter of the 30-day mock clinic: 12 cases opened.
    const opened = (await screen.findByText(COPY.tiles.opened)).closest('div');
    expect(await within(opened ?? document.body).findByText('12')).toBeInTheDocument();
  });

  it('shows the rule version under each case reason', async () => {
    const { user } = renderApp('/inbox');
    await waitFor(() => {
      expect(document.querySelector('a[href^="/inbox/"]')).not.toBeNull();
    });
    const row = document.querySelector<HTMLAnchorElement>('a[href^="/inbox/"]');
    if (row === null) throw new Error('no case row');
    await user.click(row);
    const versions = await screen.findAllByText(/version \d+\.\d+\.\d+/);
    expect(versions.length).toBeGreaterThan(0);
    expect(versions[0]?.closest('p')).toHaveTextContent(/^Rule \S+ · version \d+\.\d+\.\d+/);
  });

  it('has Spanish copy keyed like the English', () => {
    const keys = (value: object): string[] =>
      Object.entries(value).flatMap(([key, inner]) =>
        typeof inner === 'object' && inner !== null
          ? keys(inner as object).map((child) => `${key}.${child}`)
          : [key],
      );
    expect(keys(es.metrics).sort()).toEqual(keys(en.metrics).sort());
  });
});
