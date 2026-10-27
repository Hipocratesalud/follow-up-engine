import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AdminRuleChangeView,
  AdminRuleUpdateResult,
  AdminRuleView,
} from './http/admin-schemas.ts';
import { createHarness, FIXTURE_PATIENT, fixture, type Harness, STORAGES } from './test/harness.ts';

/** HIP-141: the rule configuration API, `admin:rules` only. */

const ADMIN_KEY = 'admin-key-clinic-a';
const ADMIN_B = 'admin-key-clinic-b';
const LAB = 'lab_order_result_pending';
const USER = { 'x-followup-user': 'Dra. Ruiz' };

interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly fields?: readonly { readonly path: string; readonly message: string }[];
  };
}

/** The invalid fields of a 422, each with a message. */
function fieldsOf(body: ErrorBody): string[] {
  const fields = body.error.fields ?? [];
  expect(fields.every((field) => field.message.length > 0)).toBe(true);
  return fields.map((field) => field.path);
}

describe.each(STORAGES)('admin rules API (%s)', (storage) => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness({ storage });
    await h.runtime.issueApiKey({
      clinicId: 'clinic-demo',
      label: 'admin',
      scopes: ['admin:rules'],
      apiKey: ADMIN_KEY,
    });
    await h.runtime.issueApiKey({
      clinicId: 'clinic-b',
      label: 'admin',
      scopes: ['admin:rules'],
      apiKey: ADMIN_B,
    });
  });
  afterEach(async () => {
    await h.close();
  });

  const put = (body: unknown, key = ADMIN_KEY, headers: Record<string, string> = USER) =>
    h.call<AdminRuleUpdateResult & ErrorBody>('/api/admin/rules', {
      method: 'PUT',
      body,
      key,
      headers,
    });

  it('needs the admin:rules scope: integration and inbox keys get 403', async () => {
    // KEY_A (the demo clinic's integration key) and an inbox key.
    expect((await h.call('/api/admin/rules')).status).toBe(403);
    await h.runtime.issueApiKey({
      clinicId: 'clinic-demo',
      label: 'inbox',
      scopes: ['inbox:read', 'inbox:act'],
      apiKey: 'inbox-key-a',
    });
    const inbox = await h.call<ErrorBody>('/api/admin/rules', {
      method: 'PUT',
      key: 'inbox-key-a',
      body: { ruleId: LAB, override: { dueInDays: 10 }, reason: 'x' },
      headers: USER,
    });
    expect(inbox.status).toBe(403);
    expect(inbox.body.error.code).toBe('insufficient_scope');
    expect((await h.call('/api/admin/rules/history', { key: 'inbox-key-a' })).status).toBe(403);
    // And the admin key cannot read the inbox nor send FHIR.
    expect((await h.call('/api/inbox/cases', { key: ADMIN_KEY })).status).toBe(403);
    expect((await h.call('/fhir/Task', { key: ADMIN_KEY })).status).toBe(403);
    expect((await h.call('/api/admin/rules', { key: '' })).status).toBe(401);
  });

  it('lists the rules, changes one with an audit trail, and new expectations follow it', async () => {
    const listed = await h.call<{ items: AdminRuleView[] }>('/api/admin/rules', {
      key: ADMIN_KEY,
    });
    expect(listed.status).toBe(200);
    const lab = listed.body.items.find((rule) => rule.ruleId === LAB);
    expect(lab).toMatchObject({
      layer: 'universal',
      layerLabel: 'Universal',
      defaults: { dueInDays: 15, enabled: true },
      effective: { dueInDays: 15, enabled: true },
    });
    expect(lab?.override).toBeUndefined();
    const baseVersion = lab?.version ?? '';

    const changed = await put({
      ruleId: LAB,
      override: { dueInDays: 10 },
      reason: 'Our lab answers in a week',
      expectedVersion: 0,
    });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({
      changed: true,
      change: {
        ruleId: LAB,
        version: 1,
        action: 'set',
        next: { dueInDays: 10 },
        actor: 'Dra. Ruiz',
        reason: 'Our lab answers in a week',
      },
      rule: {
        effective: { dueInDays: 10, enabled: true },
        version: `${baseVersion}+clinic.1`,
        override: { value: { dueInDays: 10 }, version: 1, updatedBy: 'Dra. Ruiz' },
      },
    });
    // Repeating it changes nothing.
    const again = await put({ ruleId: LAB, override: { dueInDays: 10 }, reason: 'same' });
    expect(again.body.changed).toBe(false);
    expect(again.body.message).toMatch(/nothing changed/);

    // A consultation with a lab order: its expectation is due in 10 days and carries the version.
    await h.call('/fhir?sync=true', { body: fixture('consultation-diabetology'), fhir: true });
    const expectations = await h.runtime.storage.stores.expectations.listByPatient(
      'clinic-demo' as never,
      FIXTURE_PATIENT as never,
    );
    const ordered = expectations.find((expectation) => expectation.ruleId === LAB);
    expect(ordered?.ruleVersion).toBe(`${baseVersion}+clinic.1`);

    const reset = await put({ ruleId: LAB, override: null, reason: 'Back to the protocol' });
    expect(reset.body).toMatchObject({
      changed: true,
      change: { version: 2, action: 'reset', previous: { dueInDays: 10 } },
      rule: { effective: { dueInDays: 15 }, version: baseVersion },
    });

    const history = await h.call<{ items: AdminRuleChangeView[] }>(
      `/api/admin/rules/history?ruleId=${LAB}`,
      { key: ADMIN_KEY },
    );
    expect(
      history.body.items.map((change) => [change.version, change.action, change.actor]),
    ).toEqual([
      [2, 'reset', 'Dra. Ruiz'],
      [1, 'set', 'Dra. Ruiz'],
    ]);
  });

  it('validates: 422 for unknown rules and fields, bad days, no reason or no user; 409 when stale', async () => {
    const invalid: readonly [unknown, string][] = [
      [{ ruleId: 'nope', override: { dueInDays: 10 }, reason: 'x' }, 'ruleId'],
      [{ ruleId: LAB, override: { dueInDays: -1 }, reason: 'x' }, 'dueInDays'],
      [{ ruleId: LAB, override: { dueInDays: 0 }, reason: 'x' }, 'dueInDays'],
      [{ ruleId: LAB, override: { priority: 99 }, reason: 'x' }, 'priority'],
      [{ ruleId: LAB, override: {}, reason: 'x' }, 'override'],
      [{ ruleId: LAB, override: { enabled: false }, reason: '  ' }, 'reason'],
    ];
    for (const [body, field] of invalid) {
      const response = await put(body);
      expect(response.status, JSON.stringify(body)).toBe(422);
      expect(fieldsOf(response.body)).toEqual([field]);
    }
    const anonymous = await put(
      { ruleId: LAB, override: { dueInDays: 9 }, reason: 'x' },
      ADMIN_KEY,
      {},
    );
    expect(anonymous.status).toBe(422);
    expect(fieldsOf(anonymous.body)).toEqual(['actor']);

    expect((await put({ ruleId: LAB, override: { dueInDays: 9 }, reason: 'x' })).status).toBe(200);
    const stale = await put({
      ruleId: LAB,
      override: { dueInDays: 8 },
      reason: 'x',
      expectedVersion: 0,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('stale_version');
  });

  it('isolates clinics: an admin key changes only its own clinic', async () => {
    await put({ ruleId: LAB, override: { enabled: false }, reason: 'paused' });
    const other = await h.call<{ items: AdminRuleView[] }>('/api/admin/rules', { key: ADMIN_B });
    expect(other.body.items.find((rule) => rule.ruleId === LAB)?.effective.enabled).toBe(true);
    const history = await h.call<{ items: unknown[] }>('/api/admin/rules/history', {
      key: ADMIN_B,
    });
    expect(history.body.items).toEqual([]);
  });
});
