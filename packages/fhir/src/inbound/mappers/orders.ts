import type { Coding, ServiceCategory } from '@follow-up-engine/core';
import { LABORATORY_LOINC_CODES, SNOMED_SERVICE_CATEGORY, TERMINOLOGY } from '../../terminology.ts';
import { daysBetween, durationToDays, firstDate } from '../../support/datetime.ts';
import {
  conceptLabel,
  hasCode,
  pickCoding,
  uncodedCoding,
  type ConceptInput,
  type EntryContext,
  type MappedResource,
} from '../context.ts';
import type { ParsedResourceOf } from '../schemas.ts';

/** `ServiceRequest.intent` values that are actual orders. */
const ORDER_INTENTS: readonly string[] = [
  'order',
  'original-order',
  'reflex-order',
  'filler-order',
  'instance-order',
];

/** `MedicationRequest.intent` values that count as a prescription. */
const PRESCRIPTION_INTENTS: readonly string[] = [...ORDER_INTENTS, 'plan'];

/** `MedicationRequest.status` values that count as prescribed. */
const PRESCRIBED_STATUSES: readonly string[] = ['active', 'completed'];

/**
 * Category of an order: SNOMED CT 108252007 (laboratory procedure) or
 * 363679005 (imaging), else a keyword in the category text.
 */
export function serviceCategory(categories: readonly ConceptInput[] | undefined): ServiceCategory {
  const all = categories ?? [];
  if (all.some((c) => hasCode(c, [SNOMED_SERVICE_CATEGORY.laboratory], TERMINOLOGY.snomed))) {
    return 'laboratory';
  }
  if (all.some((c) => hasCode(c, [SNOMED_SERVICE_CATEGORY.imaging], TERMINOLOGY.snomed))) {
    return 'imaging';
  }
  const labels = all.flatMap((c) => [c.text, ...(c.coding ?? []).map((coding) => coding.display)]);
  const text = labels
    .filter((label) => label !== undefined)
    .join(' ')
    .toLowerCase();
  if (/\blab|laborator/.test(text)) {
    return 'laboratory';
  }
  if (/imag|radiol|ecograf|ultrasound|tomograf|resonan/.test(text)) {
    return 'imaging';
  }
  return 'other';
}

/** Imaging modalities as LOINC names them (`XR Chest 2 Views`, `CT Head W contrast`, ...). */
const IMAGING_DISPLAY =
  /^(XR|CT|MR|MRI|US|NM|PT|MG|RF|DXA)\b|radiograph|tomograph|ultrasound|ecograf|resonan/i;

/** The category an uncategorized order's code implies, if it is unambiguous. */
function categoryFromCode(code: Coding): ServiceCategory | undefined {
  if (code.system !== TERMINOLOGY.loinc) {
    return undefined;
  }
  if (LABORATORY_LOINC_CODES.has(code.code)) {
    return 'laboratory';
  }
  return code.display !== undefined && IMAGING_DISPLAY.test(code.display) ? 'imaging' : undefined;
}

/**
 * The category of an order. Without a recognizable `category`, an order
 * coded with a well-known LOINC laboratory test (or a LOINC imaging study)
 * takes that category with a warning; otherwise it stays `other`, and a
 * warning says that it creates no result expectation.
 */
function orderCategory(
  request: ParsedResourceOf<'ServiceRequest'>,
  code: Coding,
  ctx: EntryContext,
): ServiceCategory {
  const declared = serviceCategory(request.category);
  if (declared !== 'other') {
    return declared;
  }
  const inferred = categoryFromCode(code);
  if (inferred !== undefined) {
    ctx.report(
      'warning',
      'incomplete',
      `no recognizable category; classified as ${inferred} from its LOINC code ${code.code}`,
      'category',
    );
    return inferred;
  }
  if ((request.category ?? []).length === 0) {
    ctx.report(
      'warning',
      'incomplete',
      'no category: the order is classified as other and creates no result expectation ' +
        '(send SNOMED CT 108252007 for laboratory or 363679005 for imaging)',
      'category',
    );
  }
  return 'other';
}

/**
 * The coding the engine keys an order or result on: LOINC first, then any
 * complete coding, then an uncoded placeholder built from the text.
 */
export function orderCoding(
  concept: ConceptInput,
  ctx: EntryContext,
  path: string,
): Coding | undefined {
  const coding = pickCoding(concept, [TERMINOLOGY.loinc]);
  if (coding !== undefined) {
    return coding;
  }
  const label = conceptLabel(concept);
  if (label === undefined) {
    ctx.report('error', 'required', 'a code with a system, or a text, is required', path);
    return undefined;
  }
  ctx.report(
    'warning',
    'code-invalid',
    `no coded value; keyed on the uncoded text "${label}"`,
    path,
  );
  return uncodedCoding(label);
}

/** ServiceRequest (active order) → `service_request.created`. */
export function mapServiceRequest(
  request: ParsedResourceOf<'ServiceRequest'>,
  ctx: EntryContext,
): MappedResource | undefined {
  const patient = ctx.follow(request.subject, 'subject', ['Patient'], true);
  if (patient === undefined) {
    return undefined;
  }
  const encounter = ctx.follow(request.encounter, 'encounter', ['Encounter'], false);
  const scope = {
    patientId: patient.id,
    ...(encounter === undefined ? {} : { encounterId: encounter.id }),
  };
  if (request.status !== 'active' || !ORDER_INTENTS.includes(request.intent)) {
    ctx.report(
      'information',
      'informational',
      `ServiceRequest ${request.status}/${request.intent} produces no event (needs active/order)`,
      'status',
    );
    return { ...scope, events: [] };
  }
  const code = orderCoding(request.code, ctx, 'code');
  if (code === undefined) {
    return undefined;
  }
  return {
    ...scope,
    events: [
      {
        ...ctx.base('service_request.created', firstDate(request.authoredOn)),
        orderId: ctx.entry.ref.id,
        code,
        category: orderCategory(request, code, ctx),
      },
    ],
  };
}

function medicationOf(
  request: ParsedResourceOf<'MedicationRequest'>,
  ctx: EntryContext,
): { readonly code?: Coding; readonly text: string } | undefined {
  let concept: ConceptInput | undefined = request.medicationCodeableConcept;
  let fallbackText: string | undefined;
  if (concept === undefined && request.medicationReference !== undefined) {
    fallbackText = request.medicationReference.display;
    const target = ctx.follow(
      request.medicationReference,
      'medicationReference',
      ['Medication'],
      false,
    );
    concept = target === undefined ? undefined : ctx.bundle.parsed('Medication', target)?.code;
  }
  const text = conceptLabel(concept) ?? fallbackText;
  if (text === undefined) {
    ctx.report(
      'error',
      'required',
      'cannot tell which medication was prescribed (no code, text or display)',
      'medication[x]',
    );
    return undefined;
  }
  const code = pickCoding(concept);
  return code === undefined ? { text } : { code, text };
}

/**
 * Treatment length in days: `dispenseRequest.expectedSupplyDuration`, else a
 * dosage `timing.repeat.boundsDuration`, else the span of `boundsPeriod`.
 */
export function prescriptionDurationDays(
  request: ParsedResourceOf<'MedicationRequest'>,
): number | undefined {
  const supply = durationToDays(request.dispenseRequest?.expectedSupplyDuration);
  if (supply !== undefined) {
    return supply;
  }
  for (const dosage of request.dosageInstruction ?? []) {
    const repeat = dosage.timing?.repeat;
    const bounded = durationToDays(repeat?.boundsDuration);
    if (bounded !== undefined) {
      return bounded;
    }
    const start = firstDate(repeat?.boundsPeriod?.start);
    const end = firstDate(repeat?.boundsPeriod?.end);
    if (start !== undefined && end !== undefined && end > start) {
      return daysBetween(start, end);
    }
  }
  return undefined;
}

/** MedicationRequest (active or completed prescription) → `medication.prescribed`. */
export function mapMedicationRequest(
  request: ParsedResourceOf<'MedicationRequest'>,
  ctx: EntryContext,
): MappedResource | undefined {
  const patient = ctx.follow(request.subject, 'subject', ['Patient'], true);
  if (patient === undefined) {
    return undefined;
  }
  const encounter = ctx.follow(request.encounter, 'encounter', ['Encounter'], false);
  const scope = {
    patientId: patient.id,
    ...(encounter === undefined ? {} : { encounterId: encounter.id }),
  };
  if (
    !PRESCRIBED_STATUSES.includes(request.status) ||
    !PRESCRIPTION_INTENTS.includes(request.intent)
  ) {
    ctx.report(
      'information',
      'informational',
      `MedicationRequest ${request.status}/${request.intent} produces no event`,
      'status',
    );
    return { ...scope, events: [] };
  }
  const medication = medicationOf(request, ctx);
  if (medication === undefined) {
    return undefined;
  }
  const authoredOn = firstDate(request.authoredOn);
  const startAt =
    firstDate(
      ...(request.dosageInstruction ?? []).map((d) => d.timing?.repeat?.boundsPeriod?.start),
      request.dispenseRequest?.validityPeriod?.start,
    ) ??
    authoredOn ??
    ctx.receivedAt;
  const durationDays = prescriptionDurationDays(request);
  return {
    ...scope,
    events: [
      {
        ...ctx.base('medication.prescribed', authoredOn),
        medication,
        startAt,
        ...(durationDays === undefined ? {} : { durationDays }),
      },
    ],
  };
}
