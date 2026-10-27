import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clinicId } from '@follow-up-engine/core';
import { clinicSlug, runClinicCommand } from './clinic-cli.ts';
import { createHarness, type Harness, STORAGES } from './test/harness.ts';

/** HIP-130: a supported way to register a clinic and issue its API keys. */

function keyOf(output: string): string {
  return /\n {2}(fue_[A-Za-z0-9_-]+)\n/.exec(output)?.[1] ?? '';
}

describe.each(STORAGES)('clinic:create (%s)', (storage) => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness({ storage });
  });
  afterEach(async () => {
    await h.close();
  });

  it('registers a clinic and prints a working, scoped key once', async () => {
    const created = await runClinicCommand(h.runtime, [
      '--name',
      'Clínica Ejemplo',
      '--scopes',
      'fhir:write',
    ]);
    expect(created.code).toBe(0);
    expect(created.output).toMatch(/clinic clinica-ejemplo \(created\)/);
    const integration = keyOf(created.output);
    expect(integration).not.toBe('');
    const clinic = await h.runtime.storage.clinics.get('clinica-ejemplo' as never);
    expect(clinic).toMatchObject({ name: 'Clínica Ejemplo', active: true });
    expect(clinic?.settings.allowPatientContact).toBe(false);
    expect((await h.call('/fhir/Task', { key: integration })).status).toBe(200);
    expect((await h.call('/api/inbox/cases', { key: integration })).status).toBe(403);

    const inbox = await runClinicCommand(h.runtime, [
      '--id',
      'clinica-ejemplo',
      '--label',
      'inbox',
      '--scopes',
      'inbox:read,inbox:act',
    ]);
    const inboxKey = keyOf(inbox.output);
    expect((await h.call('/api/inbox/cases', { key: inboxKey })).status).toBe(200);
    expect((await h.call('/fhir/Task', { key: inboxKey })).status).toBe(403);

    const revoked = await runClinicCommand(h.runtime, [
      '--id',
      'clinica-ejemplo',
      '--revoke',
      'inbox',
    ]);
    expect(revoked.output).toMatch(/revoked 1 key/);
    expect((await h.call('/api/inbox/cases', { key: inboxKey })).status).toBe(401);
    expect((await h.call('/fhir/Task', { key: integration })).status).toBe(200);
  });

  it('enables the protocols a clinic validated, and refuses unknown ones (HIP-137)', async () => {
    const created = await runClinicCommand(h.runtime, ['--name', 'Clínica Protocolos']);
    expect(created.code).toBe(0);
    const id = 'clinica-protocolos' as never;
    expect((await h.runtime.storage.clinics.get(id))?.settings.enabledProtocols).toBeUndefined();
    const enabled = await runClinicCommand(h.runtime, [
      '--id',
      'clinica-protocolos',
      '--protocols',
      'diabetes, pregnancy',
    ]);
    expect(enabled.output).toMatch(/protocols updated/);
    const clinic = await h.runtime.storage.clinics.get(id);
    expect(clinic?.settings.enabledProtocols).toEqual(['diabetes', 'pregnancy']);
    expect(clinic?.name).toBe('Clínica Protocolos');
    const catalog = await h.runtime.engine.catalog(id);
    expect(catalog.protocols.map((protocol) => protocol.id)).toEqual(['diabetes', 'pregnancy']);
    const unknown = await runClinicCommand(h.runtime, [
      '--id',
      'clinica-protocolos',
      '--protocols',
      'depression',
    ]);
    expect(unknown.code).toBe(1);
    expect(unknown.output).toMatch(/Unknown protocol\(s\): depression/);
  });

  it('refuses unknown scopes, a missing name and an unknown clinic', async () => {
    expect((await runClinicCommand(h.runtime, ['--name', 'X', '--scopes', 'admin'])).code).toBe(1);
    expect((await runClinicCommand(h.runtime, [])).code).toBe(1);
    expect((await runClinicCommand(h.runtime, ['--id', 'nadie'])).code).toBe(1);
    expect((await runClinicCommand(h.runtime, ['--bogus'])).code).toBe(1);
    expect((await runClinicCommand(h.runtime, ['--help'])).code).toBe(0);
  });

  it('sets the policy of a new clinic, switches an existing one, refuses an unknown one', async () => {
    const created = await runClinicCommand(h.runtime, [
      '--name',
      'Clínica Política',
      '--escalation-policy',
      'default_v2',
    ]);
    expect(created.code).toBe(0);
    const clinic = await h.runtime.storage.clinics.get(clinicId('clinica-politica'));
    expect(clinic?.settings.escalationPolicyId).toBe('default_v2');

    const switched = await runClinicCommand(h.runtime, [
      '--id',
      'clinica-politica',
      '--escalation-policy',
      'default_v1',
      '--label',
      'second',
    ]);
    expect(switched.output).toMatch(/\(updated\)/);
    expect(
      (await h.runtime.storage.clinics.get(clinicId('clinica-politica')))?.settings
        .escalationPolicyId,
    ).toBe('default_v1');

    const unknown = await runClinicCommand(h.runtime, [
      '--id',
      'clinica-politica',
      '--escalation-policy',
      'default_v9',
    ]);
    expect(unknown.code).toBe(1);
    expect(unknown.output).toMatch(/Unknown escalation policy default_v9/);
  });

  it('sets the clinic locale, new or existing, and refuses what is not a language tag (HIP-138)', async () => {
    const created = await runClinicCommand(h.runtime, ['--name', 'Clínica Idioma']);
    expect(created.code).toBe(0);
    const id = clinicId('clinica-idioma');
    expect((await h.runtime.storage.clinics.get(id))?.settings.locale).toBe('en-US');

    const switched = await runClinicCommand(h.runtime, [
      '--id',
      'clinica-idioma',
      '--locale',
      'es_ve',
      '--label',
      'inbox',
      '--scopes',
      'inbox:read',
    ]);
    expect(switched.code).toBe(0);
    expect(switched.output).toMatch(/\(updated\)/);
    expect((await h.runtime.storage.clinics.get(id))?.settings.locale).toBe('es-VE');
    // Its labels now default to Spanish; the user's Accept-Language still wins.
    const key = keyOf(switched.output);
    const spanish = await h.call<{ error: { message: string } }>('/api/inbox/cases/none', { key });
    expect(spanish.body.error.message).toBe('No encontramos ese caso.');

    const invalid = await runClinicCommand(h.runtime, [
      '--id',
      'clinica-idioma',
      '--locale',
      'Spanish',
    ]);
    expect(invalid.code).toBe(1);
    expect(invalid.output).toMatch(/not a BCP-47 language tag/);
  });
});

describe('clinicSlug', () => {
  it('folds accents and punctuation', () => {
    expect(clinicSlug('  Clínica Ñandú & Hijos ')).toBe('clinica-nandu-hijos');
  });
});
