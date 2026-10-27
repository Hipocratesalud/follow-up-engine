import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CaseView } from './api/contract.ts';
import {
  DRAFT_PROTOCOL_HINT,
  DRAFT_PROTOCOL_LABEL,
  DraftProtocolBadge,
  ReasonProtocol,
} from './components/case-badges.tsx';
import { createMockStore } from './mocks/store.ts';
import { renderApp } from './test/render.tsx';

/*
 * HIP-137: a reason that comes from a protocol the clinical team has not
 * validated yet carries one draft badge, and the case and patient views
 * name the protocol. In the mock clinic Daniela Castillo has a pregnancy
 * protocol reason (draft) and Carmen Elena Salazar a women's screening one
 * (validated).
 */

function caseOf(name: string): CaseView {
  const page = createMockStore().listCases({ view: 'active', limit: 200 });
  const found = page.items.find((item) => item.patient.name === name);
  if (!found) throw new Error(`no active case for ${name}`);
  return found;
}

describe('draft protocol badge', () => {
  it('says it in words and explains it to screen readers and on hover', () => {
    render(<DraftProtocolBadge />);
    const badge = screen.getByTitle(DRAFT_PROTOCOL_HINT);
    expect(badge).toHaveTextContent(DRAFT_PROTOCOL_LABEL);
    expect(badge).toHaveTextContent(DRAFT_PROTOCOL_HINT);
  });

  it('names a validated protocol without the badge', () => {
    render(
      <ReasonProtocol
        protocol={{
          id: 'womens_screening',
          version: '1.0.0',
          name: 'Tamizaje',
          status: 'validated',
        }}
      />,
    );
    expect(screen.getByText('Tamizaje')).toBeInTheDocument();
    expect(screen.queryByText(DRAFT_PROTOCOL_LABEL)).not.toBeInTheDocument();
  });

  it('shows nothing for a reason without a protocol or a protocol turned off', () => {
    const { container, rerender } = render(<ReasonProtocol protocol={undefined} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<ReasonProtocol protocol={{ id: 'pregnancy', version: '0.1.0' }} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('protocol reasons in the inbox', () => {
  it('flags the case row once when a reason comes from a draft protocol', async () => {
    renderApp('/bandeja');
    const row = await screen.findByRole('link', { name: /Daniela Castillo/ });
    expect(within(row).getAllByText(DRAFT_PROTOCOL_LABEL)).toHaveLength(1);
    // Inside the link only the tooltip explains it: the link name stays short.
    expect(row).not.toHaveTextContent(DRAFT_PROTOCOL_HINT);
    const validated = await screen.findByRole('link', { name: /Carmen Elena Salazar/ });
    expect(within(validated).queryByText(DRAFT_PROTOCOL_LABEL)).not.toBeInTheDocument();
  });

  it('names the protocol and flags the draft on the case detail, one badge per reason', async () => {
    const item = caseOf('Daniela Castillo');
    renderApp(`/casos/${item.id}`);
    const title = await screen.findByRole('heading', {
      name: 'Prueba de tolerancia a la glucosa pendiente (semanas 24 a 28)',
    });
    const card = title.closest('li');
    if (!card) throw new Error('reason card not found');
    expect(within(card).getByText('Embarazo y puerperio')).toBeInTheDocument();
    expect(within(card).getAllByText(DRAFT_PROTOCOL_LABEL)).toHaveLength(1);
    expect(within(card).getByTitle(DRAFT_PROTOCOL_HINT)).toBeInTheDocument();
    // The other reason (a pending result) has neither.
    const other = screen.getByRole('heading', { name: 'Resultado de citología pendiente' });
    expect(within(other.closest('li') ?? other).queryByText(/Protocolo:/)).not.toBeInTheDocument();
    expect(screen.getAllByText(DRAFT_PROTOCOL_LABEL)).toHaveLength(1);
  });

  it("names the protocol on the patient's expectations and flags only the drafts", async () => {
    const pregnant = caseOf('Daniela Castillo');
    renderApp(`/pacientes/${pregnant.patient.id}`);
    expect(await screen.findByText('Embarazo y puerperio')).toBeInTheDocument();
    expect(screen.getAllByText(DRAFT_PROTOCOL_LABEL)).toHaveLength(1);
  });

  it('names a validated protocol without flagging it', async () => {
    const screened = caseOf('Carmen Elena Salazar');
    renderApp(`/pacientes/${screened.patient.id}`);
    expect(await screen.findByText('Tamizaje preventivo de la mujer')).toBeInTheDocument();
    expect(screen.queryByText(DRAFT_PROTOCOL_LABEL)).not.toBeInTheDocument();
  });
});
