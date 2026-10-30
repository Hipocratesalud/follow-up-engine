import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { valueFormat } from './features/value/format.ts';
import { mockValueSimulation } from './features/value/mock.ts';
import { en } from './i18n/en.ts';
import { es } from './i18n/es.ts';
import { setLocale } from './i18n/index.ts';
import { renderApp } from './test/render.tsx';

/** The Value view: the simulation headline with intervals, the clinic inputs, the persona chart. */

const report = mockValueSimulation();
const control = report.arms.control.fulfilledShare.mean;
const agent = report.arms.agent.fulfilledShare.mean;

describe('Value (simulation with a control arm)', () => {
  it('shows the headline, both arms with intervals and the not-a-trial notice', async () => {
    renderApp('/value');
    const format = valueFormat('en', 'USD');
    expect(
      await screen.findByRole('heading', { level: 1, name: en.value.title }),
    ).toBeInTheDocument();
    expect(screen.getByText(en.value.notice)).toBeInTheDocument();
    const headline = await screen.findByLabelText(
      en.value.headline.summary(
        format.percent(control),
        format.percent(agent),
        format.points(agent - control),
      ),
    );
    expect(within(headline).getByText(format.percent(control))).toBeInTheDocument();
    expect(within(headline).getByText(format.percent(agent))).toBeInTheDocument();
    // Every persona is in the chart's table, including the ones the agent does not help.
    const personas = screen.getByRole('table', { name: en.value.personas.caption });
    for (const name of Object.values(en.value.personas.names)) {
      expect(within(personas).getByRole('rowheader', { name })).toBeInTheDocument();
    }
    expect(screen.getAllByRole('link', { name: /Value/ }).length).toBeGreaterThan(0);
  });

  it('rescales the monthly estimate to the clinic’s patients and price', async () => {
    const { user } = renderApp('/value');
    const format = valueFormat('en', 'USD');
    const perPatient = report.economics.recoveredConsultationsPerPatient.mean;
    const patients = await screen.findByLabelText(en.value.clinic.patientsPerMonth);
    const price = screen.getByLabelText(en.value.clinic.price('USD'));
    await user.clear(patients);
    await user.type(patients, '100');
    await user.clear(price);
    await user.type(price, '50');
    expect(screen.getByText(format.decimal(perPatient * 100))).toBeInTheDocument();
    expect(screen.getByText(format.money(perPatient * 100 * 50))).toBeInTheDocument();
    await user.clear(price);
    await user.type(price, '-1');
    expect(screen.getByRole('alert')).toHaveTextContent(en.value.clinic.invalid);
  });

  it('speaks Spanish with locale numbers', async () => {
    setLocale('es');
    renderApp('/value');
    const format = valueFormat('es', 'USD');
    expect(
      await screen.findByRole('heading', { level: 1, name: es.value.title }),
    ).toBeInTheDocument();
    expect(screen.getByText(es.value.notice)).toBeInTheDocument();
    // The DOM matcher collapses the no-break space Intl puts before "%".
    const shown = format.percent(agent).replace(/\s/g, ' ');
    expect((await screen.findAllByText(shown)).length).toBeGreaterThan(0);
    expect(format.percent(0.506).replace(/\s/g, ' ')).toBe('50,6 %');
  });

  it('has Spanish copy keyed like the English', () => {
    const keys = (value: object): string[] =>
      Object.entries(value).flatMap(([key, inner]) =>
        typeof inner === 'object' && inner !== null && !Array.isArray(inner)
          ? keys(inner as object).map((child) => `${key}.${child}`)
          : [key],
      );
    expect(keys(es.value).sort()).toEqual(keys(en.value).sort());
    expect(es.value.assumptions.items).toHaveLength(en.value.assumptions.items.length);
  });
});
