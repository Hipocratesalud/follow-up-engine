import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentFindingView } from './api/agent-contract.ts';
import { DoctorPanel } from './features/agent/side-panels.tsx';
import { resetLocale, setLocale } from './i18n/index.ts';

/**
 * The agent page's "For the doctor" panel (item 6, the hand-off): every
 * finding and pre-visit question shows the evidence it rests on, as
 * "Before the visit" does: the verbatim quote, the source document and its
 * date, never an ISO date.
 */
const FINDINGS: readonly AgentFindingView[] = [
  {
    id: 'finding-trend',
    category: 'lab_trend',
    severity: 'medium',
    summary: 'HbA1c en ascenso: 6,6 % → 7,1 % → 8,4 %.',
    suggestion: 'Revisar el control glucémico en la próxima consulta.',
    mode: 'shadow',
    modelId: 'meta:muse-spark-1.3',
    createdAt: '2026-01-08T13:00:00.000Z',
    routine: false,
    citations: [
      {
        docId: 'Observation/agent-obs-1-hba1c',
        kind: 'result',
        quote: 'HbA1c 8.4 %',
        date: '2025-12-29T12:00:00.000Z',
        title: 'HbA1c',
      },
      {
        docId: 'DocumentReference/visit-note',
        kind: 'note',
        quote: 'HbA1c 7,1 % (previa 6,6 %)',
        date: '2025-08-12T13:00:00.000Z',
        title: 'Internal medicine note',
      },
    ],
  },
  {
    id: 'finding-question',
    category: 'pre_visit_question',
    severity: 'low',
    summary: '¿Cómo va la adherencia a la metformina?',
    suggestion: 'Preguntar en la consulta.',
    mode: 'shadow',
    modelId: 'meta:muse-spark-1.3',
    createdAt: '2026-01-08T13:00:00.000Z',
    routine: false,
    citations: [
      {
        docId: 'DocumentReference/visit-note',
        kind: 'note',
        quote: 'en tratamiento con metformina 850 mg cada 12 horas',
        date: '2025-08-12T13:00:00.000Z',
        title: 'Internal medicine note',
      },
    ],
  },
];

afterEach(() => {
  resetLocale();
});

function items(): HTMLElement[] {
  return screen.getAllByRole('listitem');
}

describe('For the doctor: findings with their citations', () => {
  it('shows each finding’s verbatim quote with its source document and date (English)', () => {
    setLocale('en');
    render(<DoctorPanel findings={FINDINGS} />);
    const [trend, question] = items();
    if (trend === undefined || question === undefined) throw new Error('two findings expected');
    const trendCitations = within(trend).getAllByTestId('citation');
    expect(trendCitations).toHaveLength(2);
    expect(trendCitations[0]).toHaveTextContent('HbA1c 8.4 %');
    expect(trendCitations[0]).toHaveTextContent('HbA1c · Dec 29, 2025');
    expect(trendCitations[1]).toHaveTextContent('HbA1c 7,1 % (previa 6,6 %)');
    expect(trendCitations[1]).toHaveTextContent('Internal medicine note · Aug 12, 2025');
    const questionCitation = within(question).getByTestId('citation');
    expect(questionCitation).toHaveTextContent(
      'en tratamiento con metformina 850 mg cada 12 horas',
    );
    expect(questionCitation).toHaveTextContent('Internal medicine note · Aug 12, 2025');
    expect(document.body.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('formats the dates in Spanish and says when a finding has no citation', () => {
    setLocale('es');
    const bare: AgentFindingView = {
      ...FINDINGS[1],
      id: 'bare',
      citations: [],
    } as AgentFindingView;
    render(<DoctorPanel findings={[...FINDINGS, bare]} />);
    const [trend, , last] = items();
    if (trend === undefined || last === undefined) throw new Error('three findings expected');
    expect(within(trend).getAllByTestId('citation')[0]).toHaveTextContent('29 dic 2025');
    expect(within(last).queryByTestId('citation')).toBeNull();
    expect(last).toHaveTextContent('Sin evidencia citada.');
    expect(screen.getByText('Para el médico')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
