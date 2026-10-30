import type { Expectation } from '../../domain/expectation.ts';
import type { SlotResourceKind } from '../../domain/order-agent.ts';
import { kindOfMatchKey, parseCodeMatchKey } from '../matching/match-key.ts';
import { testGroupOfCoding } from '../terminology/test-names.ts';

/**
 * Which engine expectations are the agent's to own: only what the doctor
 * ordered (the doctor's plan read from a note, an order the host sent, and
 * what an abnormal result asks for). Protocol and cadence items are the
 * engine's own suggestions: the agent never pursues them (no demand
 * generation).
 */
export const AGENT_OWNED_LAYERS: ReadonlySet<Expectation['layer']> = new Set([
  'doctor_plan',
  'universal',
]);

/** Universal rules that are orders or their direct consequence (not engine suggestions). */
const OWNED_UNIVERSAL_RULES: ReadonlySet<string> = new Set([
  'lab_order_result_pending',
  'imaging_order_result_pending',
  'abnormal_result_followup',
  'short_treatment_followup',
]);

/** Rules whose expectations are urgent: an abnormal result asks for a visit this week. */
const URGENT_RULES: ReadonlySet<string> = new Set(['abnormal_result_followup']);

export function isAgentOwned(expectation: Expectation): boolean {
  if (!AGENT_OWNED_LAYERS.has(expectation.layer)) return false;
  return expectation.layer === 'doctor_plan' || OWNED_UNIVERSAL_RULES.has(expectation.ruleId);
}

/** Still something to complete (open, or expired into a case that can still close late). */
export function isPending(expectation: Expectation): boolean {
  return expectation.status === 'open' || expectation.status === 'expired';
}

/**
 * Orders the engine itself created from a result (an abnormal value asks for
 * a visit), not something the doctor wrote or ordered: the doctor confirms
 * each one before the agent contacts the patient about it
 * (docs/agent/order-to-completion.md#what-the-agent-owns).
 */
const DOCTOR_CONFIRMED_RULES: ReadonlySet<string> = new Set(['abnormal_result_followup']);

export function needsDoctorConfirmation(expectation: Expectation): boolean {
  return DOCTOR_CONFIRMED_RULES.has(expectation.ruleId);
}

export function isUrgentOrder(expectation: Expectation): boolean {
  return URGENT_RULES.has(expectation.ruleId) || expectation.severity === 'critical';
}

/** What an order asks for, for the model and the order list. */
export interface OrderDescriptor {
  /** `visit` for a control visit or session; `test` for a lab or imaging test. */
  readonly kind: 'visit' | 'test';
  /** The test's short name (`HbA1c`), language-neutral; absent for visits. For staff and the model, never for the patient. */
  readonly test?: string;
  /** An imaging study rather than a lab test. */
  readonly imaging?: boolean;
  /** LOINC (or the test's own code) the result must carry, when known. */
  readonly code?: { readonly system: string; readonly code: string };
  /** Who books it: the treating professional or a lab. */
  readonly resourceKind: SlotResourceKind;
  /** Where it came from: the doctor's note, an order, an abnormal result. */
  readonly source: 'doctor_note' | 'doctor_order' | 'abnormal_result';
}

export function describeOrder(expectation: Expectation): OrderDescriptor {
  const source =
    expectation.layer === 'doctor_plan'
      ? 'doctor_note'
      : expectation.ruleId === 'abnormal_result_followup'
        ? 'abnormal_result'
        : 'doctor_order';
  const kind = kindOfMatchKey(expectation.matchKey);
  if (kind === 'lab' || kind === 'imaging') {
    const code = parseCodeMatchKey(expectation.matchKey);
    const group = code === undefined ? undefined : testGroupOfCoding(code);
    return {
      kind: 'test',
      ...(group === undefined ? {} : { test: group.label }),
      ...(kind === 'imaging' ? { imaging: true } : {}),
      ...(code === undefined ? {} : { code: { system: code.system, code: code.code } }),
      resourceKind: 'lab',
      source,
    };
  }
  return { kind: 'visit', resourceKind: 'professional', source };
}
