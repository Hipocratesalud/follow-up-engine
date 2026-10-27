import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { messagesFor } from './i18n/index.ts';
import { renderApp } from './test/render.tsx';

const t = messagesFor('en');

/*
 * QA round 3 of the inbox (HIP-135): inbox.json #0 and #1, through the UI
 * against the mock API. The real layout (scrollWidth at 375-1440 px) and axe
 * are checked with Playwright; happy-dom has no layout, so these tests pin
 * what makes it work.
 */

async function saveDiabetesConsultation() {
  const rendered = renderApp('/demo');
  const { user } = rendered;
  await user.click(
    await screen.findByRole('button', { name: t.consultation.examples['diabetes-plan'] ?? '' }),
  );
  await user.click(screen.getByRole('button', { name: t.consultation.save }));
  await screen.findByText(t.extraction.viewBundle, {}, { timeout: 5000 });
  return rendered;
}

describe('HIP-135 Demo page JSON viewers', () => {
  it('the consultation and result columns can shrink below their content (no page overflow under xl)', async () => {
    await saveDiabetesConsultation();
    const result = document.querySelector('[aria-labelledby="extraction-title"]');
    const grid = result?.parentElement;
    // grid-cols-1 is repeat(1, minmax(0, 1fr)); *:min-w-0 lets every column shrink.
    expect(grid).toHaveClass('grid-cols-1', '*:min-w-0');
  });

  it('the Bundle JSON is a named, keyboard-focusable scroll region', async () => {
    const { user } = await saveDiabetesConsultation();
    await user.click(screen.getByText(t.extraction.viewBundle));
    const bundle = screen.getByRole('region', { name: t.extraction.bundleRegion });
    expect(bundle.tagName).toBe('PRE');
    expect(bundle).toHaveAttribute('tabindex', '0');
    expect(bundle.textContent).toContain('"resourceType": "Bundle"');
  });

  it('each webhook payload is a named, keyboard-focusable scroll region', async () => {
    const { user } = renderApp('/demo');
    const [summary] = await screen.findAllByText(t.demo.viewContent, {}, { timeout: 5000 });
    if (summary === undefined) throw new Error('expected a webhook');
    await user.click(summary);
    const payload = screen.getAllByRole('region', { name: /^Content of webhook / })[0];
    expect(payload?.tagName).toBe('PRE');
    expect(payload).toHaveAttribute('tabindex', '0');
  });
});
