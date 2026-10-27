import { describe, expect, it } from 'vitest';
import type { Expectation } from '../../domain/expectation.ts';
import type { ExpectationDefinition } from '../catalog.ts';
import {
  computeCasePriority,
  escalationPriorityBonus,
  overdueFactor,
  PRIORITY_MODEL,
  type PriorityReason,
} from './priority.ts';

const NOW = new Date('2026-03-01T00:00:00.000Z');
const DAY = 86_400_000;

function reason(input: {
  readonly layer: Expectation['layer'];
  readonly kind?: ExpectationDefinition['expects'];
  readonly trigger?: ExpectationDefinition['trigger'];
  readonly priority?: number;
  readonly overdueDays?: number;
  readonly protocolId?: string;
}): PriorityReason {
  return {
    expectation: {
      layer: input.layer,
      matchKey: input.kind === 'lab' ? 'loinc:2160-0' : 'visit',
      dueAt: new Date(NOW.getTime() - (input.overdueDays ?? 1) * DAY),
      ...(input.protocolId === undefined ? {} : { protocolId: input.protocolId }),
    } as Expectation,
    definition: {
      priority: input.priority ?? 40,
      ...(input.kind === undefined ? {} : { expects: input.kind }),
      ...(input.trigger === undefined ? {} : { trigger: input.trigger }),
    } as ExpectationDefinition,
  };
}

function priority(
  reasons: readonly PriorityReason[],
  options: { confirmed?: readonly string[]; escalationBonus?: number } = {},
): number {
  return computeCasePriority({
    reasons,
    confirmedProtocols: new Set(options.confirmed ?? []),
    ...(options.escalationBonus === undefined ? {} : { escalationBonus: options.escalationBonus }),
    now: NOW,
  });
}

const abnormal = (overdueDays?: number) =>
  reason({
    layer: 'universal',
    kind: 'follow_up_visit',
    trigger: { event: 'result.received', filter: { interpretation: 'abnormal' } },
    priority: 60,
    ...(overdueDays === undefined ? {} : { overdueDays }),
  });
const pendingLab = (overdueDays?: number) =>
  reason({
    layer: 'universal',
    kind: 'lab',
    trigger: { event: 'service_request.created' },
    priority: 40,
    ...(overdueDays === undefined ? {} : { overdueDays }),
  });
const plan = (overdueDays?: number) =>
  reason({
    layer: 'doctor_plan',
    priority: 50,
    ...(overdueDays === undefined ? {} : { overdueDays }),
  });
const cadence = () => reason({ layer: 'cadence', kind: 'follow_up_visit', priority: 30 });
const protocol = (overdueDays?: number) =>
  reason({
    layer: 'protocol',
    kind: 'lab',
    priority: 40,
    protocolId: 'diabetes',
    ...(overdueDays === undefined ? {} : { overdueDays }),
  });

describe('case priority model (HIP-124)', () => {
  it('ranks abnormal results > ordered results > the doctor plan > cadence > protocol', () => {
    const ranked = [abnormal(), pendingLab(), plan(), cadence(), protocol()].map((r) =>
      priority([r], { confirmed: ['diabetes'] }),
    );
    expect([...ranked].sort((a, b) => b - a)).toEqual(ranked);
    expect(new Set(ranked).size).toBe(ranked.length);
  });

  it('puts a probable-only protocol reminder far below a fresh doctor-ordered lab', () => {
    const probableReminder = priority([protocol(16)]);
    const orderedLab = priority([pendingLab(1)]);
    expect(orderedLab).toBeGreaterThan(probableReminder + 20);
    expect(probableReminder).toBeLessThan(60);
    expect(orderedLab).toBeGreaterThanOrEqual(60);
  });

  it('ranks a confirmed condition above a probable one', () => {
    expect(priority([protocol()], { confirmed: ['diabetes'] })).toBeGreaterThan(
      priority([protocol()]),
    );
  });

  it('bounds the overdue bonus and lowers what is very old', () => {
    expect(overdueFactor(0)).toBe(0);
    expect(overdueFactor(10)).toBe(5);
    expect(overdueFactor(60)).toBe(PRIORITY_MODEL.maxOverdueBonus);
    expect(overdueFactor(90)).toBe(PRIORITY_MODEL.maxOverdueBonus);
    expect(overdueFactor(180)).toBe(0);
    expect(overdueFactor(2_000)).toBe(-PRIORITY_MODEL.maxStalePenalty);
    // A control missed 526 days ago ranks below one missed this week.
    expect(priority([plan(526)])).toBeLessThan(priority([plan(5)]));
    expect(priority([plan(526)])).toBeLessThan(60);
  });

  it('only an ignored abnormal result reaches urgent', () => {
    const urgent = PRIORITY_MODEL.max - 10;
    expect(priority([abnormal(30)], { escalationBonus: 20 })).toBeGreaterThanOrEqual(urgent);
    expect(priority([abnormal(1)])).toBeLessThan(urgent);
    expect(priority([plan(30)], { confirmed: ['diabetes'], escalationBonus: 20 })).toBeLessThan(
      urgent,
    );
    expect(priority([protocol(30)], { escalationBonus: 20 })).toBeLessThan(75);
  });

  it('adds a little per extra reason and stays within 0..100', () => {
    expect(priority([plan(), cadence()])).toBe(priority([plan()]) + PRIORITY_MODEL.perExtraReason);
    expect(
      priority([abnormal(60), pendingLab(60), plan(60), cadence()], { escalationBonus: 60 }),
    ).toBe(PRIORITY_MODEL.max);
    expect(priority([])).toBe(PRIORITY_MODEL.min);
  });

  it('counts the raises of the escalation steps already run', () => {
    const policy = {
      steps: [
        { afterDays: 0, action: 'notify_clinic' as const },
        { afterDays: 14, action: 'raise_priority' as const, priorityDelta: 20 },
        { afterDays: 14, action: 'request_patient_contact' as const },
      ],
    };
    expect(escalationPriorityBonus(policy, 0)).toBe(0);
    expect(escalationPriorityBonus(policy, 1)).toBe(0);
    expect(escalationPriorityBonus(policy, 2)).toBe(20);
    expect(escalationPriorityBonus(policy, 3)).toBe(20);
  });
});
