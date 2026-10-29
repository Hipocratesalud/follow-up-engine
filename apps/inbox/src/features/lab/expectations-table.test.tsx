import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { LabExpectationView } from '../../api/contract.ts';
import { resetLocale } from '../../i18n/index.ts';
import { ExpectationsTable } from './expectations-table.tsx';

afterEach(() => {
  resetLocale();
});

function item(overrides: Partial<LabExpectationView> = {}): LabExpectationView {
  return {
    id: 'exp-1',
    ruleId: 'lab_order_result_pending',
    layer: 'universal',
    label: 'HbA1c pending',
    status: 'open',
    dueAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('the lab patient expectations table', () => {
  it('shows an empty state with no expectations', () => {
    render(<ExpectationsTable items={[]} previousStatuses={undefined} />);
    expect(screen.getByText(/no expectations yet/i)).toBeInTheDocument();
  });

  it('renders every row with its rule, layer and due date, with no diff badge the first time', () => {
    render(
      <ExpectationsTable
        items={[
          item(),
          item({
            id: 'exp-2',
            ruleId: 'imaging_order_result_pending',
            label: 'Imaging pending',
            status: 'expired',
          }),
        ]}
        previousStatuses={undefined}
      />,
    );
    expect(screen.getByText('HbA1c pending')).toBeInTheDocument();
    expect(screen.getByText('Imaging pending')).toBeInTheDocument();
    expect(screen.getByText('lab_order_result_pending')).toBeInTheDocument();
    expect(screen.queryByText('New')).not.toBeInTheDocument();
    expect(screen.queryByText('Updated')).not.toBeInTheDocument();
  });

  it('marks a row not seen before as new', () => {
    render(<ExpectationsTable items={[item()]} previousStatuses={new Map([['exp-0', 'open']])} />);
    expect(screen.getByText('New')).toBeInTheDocument();
  });

  it('marks a row whose status changed since the previous action as updated', () => {
    render(
      <ExpectationsTable
        items={[item({ status: 'fulfilled' })]}
        previousStatuses={new Map([['exp-1', 'open']])}
      />,
    );
    expect(screen.getByText('Updated')).toBeInTheDocument();
    expect(screen.getByText('Fulfilled')).toBeInTheDocument();
  });

  it('leaves an unchanged row with neither badge', () => {
    render(<ExpectationsTable items={[item()]} previousStatuses={new Map([['exp-1', 'open']])} />);
    expect(screen.queryByText('New')).not.toBeInTheDocument();
    expect(screen.queryByText('Updated')).not.toBeInTheDocument();
  });
});
