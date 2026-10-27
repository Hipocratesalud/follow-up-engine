import type { FhirResourceJson, JsonValue } from '@follow-up-engine/core';
import type { PatientSummary } from '../http/schemas.ts';
import { UNKNOWN_PATIENT_LABEL } from './labels.ts';

/*
 * Human-readable text out of stored FHIR resources (names, ages, what an
 * order was for). Tolerant: any missing element falls back to something
 * sensible instead of failing a whole inbox page.
 */

type Json = JsonValue | undefined;

function record(value: Json): Readonly<Record<string, Json>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, Json>>)
    : undefined;
}

function list(value: Json): readonly Json[] {
  return Array.isArray(value) ? (value as readonly Json[]) : [];
}

function str(value: Json): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** `name[0].text`, else prefix + given + family. */
export function humanName(resource: FhirResourceJson | undefined): string | undefined {
  const name = record(list(resource?.['name'])[0]);
  if (name === undefined) {
    return undefined;
  }
  const textName = str(name['text']);
  if (textName !== undefined) {
    return textName;
  }
  const parts = [
    ...list(name['prefix']).map(str),
    ...list(name['given']).map(str),
    str(name['family']) ?? list(name['family']).map(str).join(' '),
  ].filter((part): part is string => part !== undefined && part !== '');
  return parts.length === 0 ? undefined : parts.join(' ');
}

/** Whole years between a FHIR `birthDate` (`YYYY`, `YYYY-MM` or `YYYY-MM-DD`) and `now`. */
export function ageAt(birthDate: string | undefined, now: Date): number | undefined {
  const match = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(birthDate ?? '');
  if (match === null) {
    return undefined;
  }
  const year = Number(match[1]);
  const month = Number(match[2] ?? '1') - 1;
  const day = Number(match[3] ?? '1');
  let age = now.getUTCFullYear() - year;
  if (now.getUTCMonth() < month || (now.getUTCMonth() === month && now.getUTCDate() < day)) {
    age -= 1;
  }
  return age >= 0 && age < 150 ? age : undefined;
}

const SEXES = new Set(['female', 'male', 'other', 'unknown']);

export function patientSummary(
  patientId: string,
  resource: FhirResourceJson | undefined,
  now: Date,
): PatientSummary & { birthDate?: string } {
  const birthDate = str(resource?.['birthDate']);
  const gender = str(resource?.['gender']);
  const age = ageAt(birthDate, now);
  return {
    id: patientId,
    name: humanName(resource) ?? UNKNOWN_PATIENT_LABEL,
    ...(age === undefined ? {} : { age }),
    ...(gender !== undefined && SEXES.has(gender)
      ? { sex: gender as 'female' | 'male' | 'other' | 'unknown' }
      : {}),
    ...(birthDate === undefined ? {} : { birthDate }),
  };
}

function conceptText(value: Json): string | undefined {
  const concept = record(value);
  if (concept === undefined) {
    return undefined;
  }
  const coding = list(concept['coding'])
    .map(record)
    .find((item) => str(item?.['display']) !== undefined);
  return str(concept['text']) ?? str(coding?.['display']);
}

const TYPE_LABELS: Record<string, string> = {
  ServiceRequest: 'Orden',
  MedicationRequest: 'Receta',
  DocumentReference: 'Nota clínica',
  Composition: 'Nota clínica',
  Encounter: 'Consulta',
  Appointment: 'Cita',
  DiagnosticReport: 'Resultado',
  Observation: 'Resultado',
  Condition: 'Diagnóstico',
};

function dateLabel(value: Json): string | undefined {
  const raw = str(value);
  const date = raw === undefined ? undefined : new Date(raw);
  return date === undefined || Number.isNaN(date.getTime())
    ? undefined
    : date.toLocaleDateString('es', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      });
}

/** What a source resource is, in a few words: "HbA1c", "Nota clínica del 5 de enero de 2026". */
export function sourceDisplay(
  resourceType: string,
  resource: FhirResourceJson | undefined,
): string {
  const typeLabel = TYPE_LABELS[resourceType] ?? resourceType;
  if (resource === undefined) {
    return typeLabel;
  }
  const named =
    conceptText(resource['code']) ??
    conceptText(resource['medicationCodeableConcept']) ??
    conceptText(resource['serviceType']);
  if (named !== undefined && resourceType !== 'Encounter') {
    return named;
  }
  const when =
    dateLabel(resource['date']) ??
    dateLabel(resource['authoredOn']) ??
    dateLabel(record(resource['period'])?.['start']);
  return when === undefined ? typeLabel : `${typeLabel} del ${when}`;
}

/** About `size` characters of `text` centred on `quote` (case-insensitive), with ellipses. */
export function excerptAround(text: string, quote: string, size = 400): string {
  const index = text.toLowerCase().indexOf(quote.toLowerCase());
  if (text.length <= size) {
    return text;
  }
  const centre = index === -1 ? 0 : index + Math.floor(quote.length / 2);
  const start = Math.max(0, Math.min(centre - Math.floor(size / 2), text.length - size));
  const end = Math.min(text.length, start + size);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}
