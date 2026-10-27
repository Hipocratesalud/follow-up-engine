import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CaseId,
  clinicId,
  ConfigValidationError,
  ConflictError,
  type DomainEvent,
  type Expectation,
  expectationId,
  FakeClock,
  type FollowUpCase,
  NotFoundError,
  patientId,
  TenantMismatchError,
  ZERO_BACKFILL_COUNTS,
} from '@follow-up-engine/core';
import { describe, expect, it } from 'vitest';
import {
  createMemoryStores,
  DEFAULT_CONFIG_DIR,
  FakeNoteExtractor,
  FileRuleSource,
  loadConfigDirectory,
  MemoryClinicDirectory,
  MemoryDatabase,
  MemoryEventPublisher,
  MemoryLlmUsageLog,
  MemoryUnitOfWork,
  PACKAGE_NAME,
  SequentialIdGenerator,
  StaticProtocolSource,
  UuidIdGenerator,
  demoClinic,
} from './index.ts';
import { CODES } from './testing/index.ts';

const CLINIC = clinicId('clinic-a');
const OTHER = clinicId('clinic-b');
const PATIENT = patientId('pat-1');
const T0 = new Date('2026-01-05T12:00:00.000Z');

function setup() {
  const clock = new FakeClock(T0);
  const db = new MemoryDatabase();
  const stores = createMemoryStores(db, clock);
  return { clock, db, stores, unitOfWork: new MemoryUnitOfWork(db, stores) };
}

function expectation(id: string, overrides: Partial<Expectation> = {}): Expectation {
  return {
    id: expectationId(id),
    clinicId: CLINIC,
    patientId: PATIENT,
    idempotencyKey: `ServiceRequest/${id}#lab_order_result_pending`,
    ruleId: 'lab_order_result_pending',
    ruleVersion: '1.0.0',
    layer: 'universal',
    source: { resourceType: 'ServiceRequest', id },
    matchKey: 'loinc:4548-4',
    dueAt: new Date('2026-01-20T12:00:00.000Z'),
    status: 'open',
    origin: 'live',
    reason: { code: 'lab_order_result_pending', label: 'Resultado de laboratorio pendiente' },
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function followUpCase(id: string, overrides: Partial<FollowUpCase> = {}): FollowUpCase {
  return {
    id: id as CaseId,
    clinicId: CLINIC,
    patientId: PATIENT,
    dedupKey: `${PATIENT}:follow_up`,
    reasons: [],
    status: 'open',
    priority: 10,
    escalationStep: 0,
    origin: 'live',
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

describe(PACKAGE_NAME, () => {
  describe('MemoryUnitOfWork', () => {
    it('commits writes of a successful transaction', async () => {
      const { stores, unitOfWork } = setup();
      await unitOfWork.withTransaction(CLINIC, (tx) =>
        tx.expectations.upsertByIdempotencyKey(CLINIC, expectation('e1')),
      );
      expect(stores.expectations.listAll(CLINIC)).toHaveLength(1);
    });

    it('rolls back every store, jobs and outbox included, when the work throws', async () => {
      const { stores, unitOfWork } = setup();
      await expect(
        unitOfWork.withTransaction(CLINIC, async (tx) => {
          await tx.expectations.upsertByIdempotencyKey(CLINIC, expectation('e1'));
          await tx.jobs.enqueue(CLINIC, { type: 'x', payload: {} });
          await tx.outbox.add(CLINIC, {
            id: 'evt-1',
            type: 'backfill.completed',
            clinicId: CLINIC,
            occurredAt: T0,
            payload: {
              runId: 'r',
              shadow: false,
              ...ZERO_BACKFILL_COUNTS,
              casesScheduled: 0,
              casesNotNotified: 0,
            },
          });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(stores.expectations.listAll(CLINIC)).toHaveLength(0);
      expect(stores.jobs.list()).toHaveLength(0);
      expect(stores.outbox.list()).toHaveLength(0);
    });

    it('serializes concurrent transactions', async () => {
      const { stores, unitOfWork } = setup();
      const order: string[] = [];
      await Promise.all([
        unitOfWork.withTransaction(CLINIC, async (tx) => {
          order.push('a:start');
          await tx.expectations.upsertByIdempotencyKey(CLINIC, expectation('e1'));
          await Promise.resolve();
          order.push('a:end');
        }),
        unitOfWork
          .withTransaction(CLINIC, async () => {
            order.push('b:start');
            await Promise.resolve();
            throw new Error('b fails');
          })
          .catch(() => undefined),
      ]);
      expect(order).toEqual(['a:start', 'a:end', 'b:start']);
      expect(stores.expectations.listAll(CLINIC)).toHaveLength(1);
    });
  });

  describe('repositories', () => {
    it('deduplicates expectations by idempotency key and guards the tenant', async () => {
      const { stores } = setup();
      const first = await stores.expectations.upsertByIdempotencyKey(CLINIC, expectation('e1'));
      const second = await stores.expectations.upsertByIdempotencyKey(
        CLINIC,
        expectation('e2', { idempotencyKey: first.expectation.idempotencyKey }),
      );
      expect([first.created, second.created]).toEqual([true, false]);
      expect(second.expectation.id).toBe('e1');
      await expect(
        stores.expectations.upsertByIdempotencyKey(OTHER, expectation('e3')),
      ).rejects.toBeInstanceOf(TenantMismatchError);
      await expect(
        stores.expectations.update(CLINIC, expectation('missing')),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(await stores.expectations.findDue(CLINIC, new Date('2026-02-01'), 10)).toHaveLength(1);
      expect(await stores.expectations.findOpenByPatient(OTHER, PATIENT)).toHaveLength(0);
    });

    it('keeps one active case per dedup key and pages the inbox', async () => {
      const { stores } = setup();
      await stores.cases.create(CLINIC, followUpCase('c1', { priority: 5 }));
      await expect(stores.cases.create(CLINIC, followUpCase('c2'))).rejects.toBeInstanceOf(
        ConflictError,
      );
      await stores.cases.create(CLINIC, followUpCase('c2', { dedupKey: 'k2', priority: 50 }));
      await stores.cases.create(
        CLINIC,
        followUpCase('c3', { dedupKey: 'k3', status: 'resolved', priority: 1 }),
      );
      const first = await stores.cases.list(CLINIC, { limit: 2 });
      expect(first.items.map((item) => item.id)).toEqual(['c2', 'c1']);
      const second = await stores.cases.list(CLINIC, {
        limit: 2,
        ...(first.nextCursor === undefined ? {} : { cursor: first.nextCursor }),
      });
      expect(second).toEqual({ items: [expect.objectContaining({ id: 'c3' })] });
      expect(
        (
          await stores.cases.list(CLINIC, {
            limit: 10,
            statuses: ['resolved'],
            orderBy: 'created_at',
          })
        ).items,
      ).toHaveLength(1);
      await expect(stores.cases.update(CLINIC, followUpCase('nope'))).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(stores.cases.create(OTHER, followUpCase('x'))).rejects.toBeInstanceOf(
        TenantMismatchError,
      );
    });

    it('finds cases due for action, including snoozed cases whose snooze ended', async () => {
      const { stores } = setup();
      await stores.cases.create(CLINIC, followUpCase('due', { nextActionAt: T0 }));
      await stores.cases.create(
        CLINIC,
        followUpCase('later', { dedupKey: 'b', nextActionAt: new Date('2027-01-01') }),
      );
      await stores.cases.create(
        CLINIC,
        followUpCase('snoozed', { dedupKey: 'c', status: 'snoozed', snoozedUntil: T0 }),
      );
      const due = await stores.cases.findDueForAction(CLINIC, T0, 10);
      expect(due.map((item) => item.id).sort()).toEqual(['due', 'snoozed']);
    });

    it('stores clinical events once per idempotency key, chronologically', async () => {
      const { stores } = setup();
      const base = {
        clinicId: CLINIC,
        patientId: PATIENT,
        source: { resourceType: 'Encounter', id: 'e' },
      } as const;
      const late = {
        ...base,
        type: 'encounter.finished',
        occurredAt: new Date('2026-02-01'),
        idempotencyKey: 'b',
      } as const;
      const early = {
        ...base,
        type: 'encounter.finished',
        occurredAt: new Date('2026-01-01'),
        idempotencyKey: 'a',
      } as const;
      expect(await stores.clinicalRecords.appendEvents(CLINIC, [late, early, late])).toEqual({
        inserted: 2,
      });
      expect(
        (await stores.clinicalRecords.listEventsForPatient(CLINIC, PATIENT)).map(
          (event) => event.idempotencyKey,
        ),
      ).toEqual(['a', 'b']);
      expect(
        await stores.clinicalRecords.listEventsForPatient(CLINIC, PATIENT, {
          since: new Date('2026-01-15'),
        }),
      ).toHaveLength(1);
      expect(await stores.clinicalRecords.listPatientIds(CLINIC, { limit: 1 })).toEqual({
        patientIds: [PATIENT],
      });
      await expect(stores.clinicalRecords.appendEvents(OTHER, [early])).rejects.toBeInstanceOf(
        TenantMismatchError,
      );
    });

    it('versions raw resources only when their content changes', async () => {
      const { stores } = setup();
      const resource = { resourceType: 'Patient', id: 'p1', name: [{ family: 'Pérez' }] };
      expect(await stores.clinicalRecords.saveResource(CLINIC, PATIENT, resource, T0)).toEqual({
        versionId: '1',
        changed: true,
      });
      expect(
        await stores.clinicalRecords.saveResource(
          CLINIC,
          PATIENT,
          { name: [{ family: 'Pérez' }], id: 'p1', resourceType: 'Patient' },
          T0,
        ),
      ).toEqual({ versionId: '1', changed: false });
      expect(
        await stores.clinicalRecords.saveResource(
          CLINIC,
          PATIENT,
          { ...resource, active: true },
          T0,
        ),
      ).toEqual({ versionId: '2', changed: true });
      expect(
        (await stores.clinicalRecords.getResource(CLINIC, { resourceType: 'Patient', id: 'p1' }))
          ?.versionId,
      ).toBe('2');
      expect(
        await stores.clinicalRecords.getResource(OTHER, { resourceType: 'Patient', id: 'p1' }),
      ).toBeUndefined();
    });

    it('feedback, findings and audit are tenant-scoped', async () => {
      const { stores } = setup();
      const feedback = {
        id: 'f1' as never,
        clinicId: CLINIC,
        caseId: 'c1' as CaseId,
        useful: true,
        createdAt: T0,
      };
      await stores.feedback.record(CLINIC, feedback);
      await expect(stores.feedback.record(CLINIC, feedback)).rejects.toBeInstanceOf(ConflictError);
      await expect(stores.feedback.record(OTHER, feedback)).rejects.toBeInstanceOf(
        TenantMismatchError,
      );
      expect(await stores.feedback.listSince(CLINIC, T0, 10)).toHaveLength(1);
      const finding = {
        id: 'q1',
        clinicId: CLINIC,
        patientId: PATIENT,
        kind: 'note_without_plan',
        source: { resourceType: 'DocumentReference', id: 'd' },
        detectedAt: T0,
      } as const;
      await stores.qualityFindings.save(CLINIC, finding);
      await stores.qualityFindings.save(CLINIC, finding);
      expect(await stores.qualityFindings.listByPatient(CLINIC, PATIENT)).toHaveLength(1);
      await expect(stores.qualityFindings.save(OTHER, finding)).rejects.toBeInstanceOf(
        TenantMismatchError,
      );
      await expect(
        stores.audit.append(OTHER, {
          clinicId: CLINIC,
          caseId: 'c1' as CaseId,
          type: 'opened',
          actor: { type: 'system' },
          payload: {},
          at: T0,
        }),
      ).rejects.toBeInstanceOf(TenantMismatchError);
      await expect(
        stores.conditions.upsert(OTHER, {
          clinicId: CLINIC,
          patientId: PATIENT,
          code: CODES.hba1c,
          status: 'probable',
          confidence: 0.5,
          sourceType: 'recorded',
          source: { resourceType: 'Condition', id: 'c' },
          updatedAt: T0,
        }),
      ).rejects.toBeInstanceOf(TenantMismatchError);
    });
  });

  describe('MemoryJobQueue', () => {
    it('leases jobs, hides them while leased and rejects stale leases', async () => {
      const { clock, stores } = setup();
      const id = await stores.jobs.enqueue(CLINIC, {
        type: 'note.extract_plan',
        payload: { documentId: 'd1' },
        dedupKey: 'd1',
      });
      expect(
        await stores.jobs.enqueue(CLINIC, {
          type: 'note.extract_plan',
          payload: {},
          dedupKey: 'd1',
        }),
      ).toBe(id);
      const [claimed] = await stores.jobs.claim({
        workerId: 'w1',
        limit: 5,
        leaseFor: { minutes: 1 },
        now: clock.now(),
      });
      expect(claimed).toMatchObject({ id, attempt: 1, clinicId: CLINIC });
      expect(
        await stores.jobs.claim({
          workerId: 'w2',
          limit: 5,
          leaseFor: { minutes: 1 },
          now: clock.now(),
        }),
      ).toEqual([]);
      clock.advance({ minutes: 2 });
      const [reclaimed] = await stores.jobs.claim({
        workerId: 'w2',
        limit: 5,
        leaseFor: { minutes: 1 },
        now: clock.now(),
      });
      expect(reclaimed?.attempt).toBe(2);
      if (claimed === undefined || reclaimed === undefined) {
        throw new Error('expected claims');
      }
      expect(await stores.jobs.complete(CLINIC, claimed)).toBe('lease_lost');
      await expect(stores.jobs.complete(OTHER, reclaimed)).rejects.toBeInstanceOf(
        TenantMismatchError,
      );
      expect(await stores.jobs.complete(CLINIC, reclaimed)).toBe('acknowledged');
      expect(stores.jobs.list(CLINIC)[0]?.status).toBe('completed');
    });

    it('retries failed jobs at retryAt and dead-letters them after maxAttempts', async () => {
      const { clock, stores } = setup();
      await stores.jobs.enqueue(CLINIC, { type: 't', payload: {}, maxAttempts: 2 });
      const claim = () =>
        stores.jobs.claim({
          workerId: 'w',
          types: ['t'],
          limit: 1,
          leaseFor: { minutes: 5 },
          now: clock.now(),
        });
      const [first] = await claim();
      if (first === undefined) {
        throw new Error('expected a claim');
      }
      expect(
        await stores.jobs.fail(CLINIC, first, {
          error: 'x',
          retryAt: new Date(T0.getTime() + 60_000),
        }),
      ).toBe('acknowledged');
      expect(await claim()).toEqual([]);
      clock.advance({ minutes: 1 });
      const [second] = await claim();
      if (second === undefined) {
        throw new Error('expected a second claim');
      }
      await stores.jobs.fail(CLINIC, second, { error: 'y' });
      expect(stores.jobs.list()[0]).toMatchObject({ status: 'dead', lastError: 'y' });
      expect(
        await stores.jobs.fail(CLINIC, { id: 'job-404' as never, leaseToken: 'x' }, { error: 'z' }),
      ).toBe('lease_lost');
    });
  });

  describe('MemoryOutbox', () => {
    it('delivers pending events once, in order, through the publisher', async () => {
      const { stores } = setup();
      const event = (id: string): DomainEvent => ({
        id,
        type: 'case.resolved',
        clinicId: CLINIC,
        occurredAt: T0,
        payload: { caseId: 'c1' as CaseId, patientId: PATIENT, resolution: 'fulfilled' },
      });
      await stores.outbox.add(CLINIC, event('1'));
      await stores.outbox.add(CLINIC, event('2'));
      await expect(stores.outbox.add(OTHER, event('3'))).rejects.toBeInstanceOf(
        TenantMismatchError,
      );
      const publisher = new MemoryEventPublisher();
      expect(await stores.outbox.deliverPending(publisher, T0)).toBe(2);
      expect(await stores.outbox.deliverPending(publisher, T0)).toBe(0);
      expect(publisher.published.map((item) => item.id)).toEqual(['1', '2']);
      await expect(publisher.publish(OTHER, event('4'))).rejects.toBeInstanceOf(
        TenantMismatchError,
      );
    });
  });

  describe('directory, usage log and ids', () => {
    it('finds clinics by id and API key hash, listing only active ones', async () => {
      const directory = new MemoryClinicDirectory([
        { clinic: demoClinic(CLINIC), apiKeyHash: 'abc' },
        { clinic: { ...demoClinic(OTHER), active: false } },
      ]);
      expect((await directory.findByApiKeyHash('abc'))?.id).toBe(CLINIC);
      expect(await directory.findByApiKeyHash('nope')).toBeUndefined();
      expect((await directory.listActive()).map((clinic) => clinic.id)).toEqual([CLINIC]);
      expect((await directory.get(OTHER))?.active).toBe(false);
    });

    it('sums LLM cost per clinic since a date', async () => {
      const log = new MemoryLlmUsageLog(new MemoryDatabase());
      const call = {
        callId: '1',
        clinicId: CLINIC,
        task: 'plan_extraction',
        promptVersion: 'v1',
        provider: 'fake',
        model: 'm',
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.01,
        latencyMs: 3,
        ok: true,
        at: T0,
      };
      await log.record(call);
      await log.record({ ...call, callId: '2', at: new Date('2025-01-01') });
      await log.record({ ...call, callId: '3', clinicId: OTHER });
      expect(await log.totalCostUsd(CLINIC, new Date('2026-01-01'))).toBeCloseTo(0.01);
      expect(log.list(CLINIC)).toHaveLength(2);
    });

    it('mints sequential or random ids', () => {
      const sequential = new SequentialIdGenerator();
      expect([
        sequential.next('case'),
        sequential.next('case'),
        sequential.next('expectation'),
      ]).toEqual(['case-1', 'case-2', 'exp-1']);
      expect(new UuidIdGenerator().next()).toMatch(/^[0-9a-f-]{36}$/u);
    });
  });

  describe('config sources', () => {
    it('loads and validates the repository config', () => {
      const config = loadConfigDirectory(DEFAULT_CONFIG_DIR);
      expect(config.rules.map((rule) => rule.id).sort()).toEqual([
        'abnormal_result_followup',
        'cadence_break',
        'doctor_plan_followup',
        'imaging_order_result_pending',
        'lab_order_result_pending',
        'short_treatment_followup',
      ]);
      expect(config.protocols.map((protocol) => protocol.id).sort()).toEqual([
        'diabetes',
        'hypertension',
      ]);
      expect(config.escalationPolicies.map((policy) => policy.id)).toEqual(['default_v1']);
      expect(config.rules.every((rule) => rule.reason.code === rule.id)).toBe(true);
    });

    it('applies per-clinic overrides and enables config only for validated clinics', async () => {
      const source = new FileRuleSource(DEFAULT_CONFIG_DIR, {
        enabledClinics: [CLINIC],
        overrides: {
          [CLINIC]: {
            lab_order_result_pending: { dueInDays: 10 },
            cadence_break: { enabled: false },
          },
        },
      });
      expect((await source.getRule(CLINIC, 'lab_order_result_pending'))?.dueInDays).toBe(10);
      expect(await source.getRule(CLINIC, 'cadence_break')).toBeUndefined();
      expect(await source.listRules(OTHER)).toEqual([]);
      const protocols = new StaticProtocolSource(loadConfigDirectory().protocols, {
        enabledClinics: [CLINIC],
      });
      expect((await protocols.getProtocol(CLINIC, 'diabetes'))?.version).toBe('1.0.0');
      expect(await protocols.listProtocols(OTHER)).toEqual([]);
    });

    it('reports every invalid file with its name', () => {
      const dir = mkdtempSync(join(tmpdir(), 'fue-config-'));
      mkdirSync(join(dir, 'rules', 'escalation'), { recursive: true });
      mkdirSync(join(dir, 'protocols'));
      writeFileSync(
        join(dir, 'rules', 'escalation', 'p.json'),
        JSON.stringify({ id: 'p1', steps: [{ afterDays: 0, action: 'notify_clinic' }] }),
      );
      writeFileSync(join(dir, 'rules', 'bad.json'), JSON.stringify([{ id: 'Bad Id' }]));
      const error = (() => {
        try {
          loadConfigDirectory(dir);
          return undefined;
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).issues.join('\n')).toContain('bad.json[0]');
    });
  });

  describe('FakeNoteExtractor', () => {
    it('reads follow-up plans, conditions and medications from Spanish notes', async () => {
      const extractor = new FakeNoteExtractor();
      const result = await extractor.extract(CLINIC, {
        documentId: 'd1',
        authoredAt: T0,
        text: 'Pcte con DM2 e HTA. Metformina 850 mg. Amoxicilina 500 mg por 7 días. Plan: ctrl en 3 meses con HbA1c. Cita en 2 semanas.',
      });
      expect(result.hasPlan).toBe(true);
      expect(
        result.planItems.map((item) => [
          item.kind,
          item.dueAt.toISOString().slice(0, 10),
          item.evidenceQuote,
        ]),
      ).toEqual([
        ['follow_up_visit', '2026-04-05', 'ctrl en 3 meses'],
        ['lab', '2026-04-05', 'HbA1c'],
        ['follow_up_visit', '2026-01-19', 'Cita en 2 semanas'],
      ]);
      expect(result.conditions.map((condition) => condition.code.code)).toEqual(['E11', 'I10']);
      expect(result.medications).toMatchObject([
        { text: 'Metformina 850 mg' },
        { durationDays: 7 },
      ]);
    });

    it('marks psychology plans as sessions and notes without plan as such', async () => {
      const extractor = new FakeNoteExtractor({ model: 'm', promptVersion: 'p', costUsd: 0.5 });
      const session = await extractor.extract(CLINIC, {
        documentId: 'd',
        authoredAt: T0,
        specialty: 'psychology',
        text: 'Próxima sesión en 1 semana.',
      });
      expect(session.planItems[0]?.kind).toBe('session');
      const none = await extractor.extract(CLINIC, {
        documentId: 'd2',
        authoredAt: T0,
        text: 'Sin cambios.',
      });
      expect(none).toMatchObject({
        hasPlan: false,
        planItems: [],
        model: 'm',
        promptVersion: 'p',
        costUsd: 0.5,
      });
    });

    it('fails on demand and recovers', async () => {
      const extractor = new FakeNoteExtractor().failNext();
      const input = { documentId: 'd', authoredAt: T0, text: 'x' };
      await expect(extractor.extract(CLINIC, input)).rejects.toThrow('Extraction of d failed');
      await expect(extractor.extract(CLINIC, input)).resolves.toMatchObject({ hasPlan: false });
      extractor.failFor('d');
      await expect(extractor.extract(CLINIC, input)).rejects.toThrow();
      extractor.recover('d');
      await expect(extractor.extract(CLINIC, input)).resolves.toBeDefined();
    });
  });

  it('resets the database', () => {
    const db = new MemoryDatabase();
    db.nextSequence();
    db.reset();
    expect(db.state.sequence).toBe(0);
  });
});
