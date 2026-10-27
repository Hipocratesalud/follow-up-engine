import type { z } from 'zod';

/**
 * Validation errors in Spanish for the clinic team: a zod error map for
 * every request the JSON API parses (`readJson`, `readQuery`), and the
 * `{ error: { code: 'invalid_request', message, fields } }` body built from
 * it. Messages written in a schema (a `refine`) are already Spanish and win.
 */

/** What the clinic team calls each request field, for the summary message. */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  action: 'Acción',
  assignee: 'Responsable',
  comment: 'Comentario',
  cursor: 'Página',
  days: 'Días',
  limit: 'Cantidad por página',
  note: 'Nota interna',
  noteText: 'Nota de la consulta',
  orders: 'Órdenes',
  origin: 'Origen',
  patient: 'Paciente',
  patientId: 'Paciente',
  patientName: 'Nombre del paciente',
  q: 'Búsqueda',
  query: 'Búsqueda',
  reason: 'Motivo',
  snoozeDays: 'Días para posponer',
  specialty: 'Especialidad',
  type: 'Tipo',
  useful: 'Utilidad',
  view: 'Vista',
};

const TYPE_NAMES: Readonly<Record<string, string>> = {
  string: 'un texto',
  number: 'un número',
  int: 'un número entero',
  boolean: 'verdadero o falso',
  array: 'una lista',
  object: 'un objeto',
  date: 'una fecha',
};

function plural(count: number | bigint, one: string, many: string): string {
  return `${String(count)} ${Number(count) === 1 ? one : many}`;
}

function sizeMessage(
  origin: string,
  bound: number | bigint,
  direction: 'max' | 'min',
  inclusive: boolean,
): string {
  const limit = direction === 'max' ? 'como máximo' : 'al menos';
  switch (origin) {
    case 'string':
      if (direction === 'min' && Number(bound) === 1) {
        return 'No puede quedar vacío.';
      }
      return `Debe tener ${limit} ${plural(bound, 'carácter', 'caracteres')}.`;
    case 'array':
    case 'set':
      return `Debe tener ${limit} ${plural(bound, 'elemento', 'elementos')}.`;
    case 'date':
      return direction === 'max'
        ? 'La fecha es demasiado tardía.'
        : 'La fecha es demasiado temprana.';
    default:
      if (!inclusive) {
        return direction === 'max'
          ? `Debe ser menor que ${String(bound)}.`
          : `Debe ser mayor que ${String(bound)}.`;
      }
      return `Debe ser ${limit} ${String(bound)}.`;
  }
}

function optionList(values: readonly unknown[]): string {
  return values.map((value) => String(value)).join(', ');
}

type RawIssue = Parameters<z.core.$ZodErrorMap>[0];

/** zod error map: a Spanish message for each issue. */
export function spanishIssueMessage(issue: RawIssue): string {
  const missing =
    issue.input === undefined &&
    (issue.code === 'invalid_type' ||
      issue.code === 'invalid_value' ||
      issue.code === 'invalid_union');
  if (missing) {
    return 'Es obligatorio.';
  }
  switch (issue.code) {
    case 'invalid_type':
      return `Debe ser ${TYPE_NAMES[issue.expected] ?? 'un valor de otro tipo'}.`;
    case 'too_big':
      return sizeMessage(issue.origin, issue.maximum, 'max', issue.inclusive ?? true);
    case 'too_small':
      return sizeMessage(issue.origin, issue.minimum, 'min', issue.inclusive ?? true);
    case 'invalid_value':
      return issue.values.length === 1
        ? `Debe ser ${String(issue.values[0])}.`
        : `Elige una de estas opciones: ${optionList(issue.values)}.`;
    case 'invalid_union':
      return 'options' in issue && Array.isArray(issue.options)
        ? `Elige una de estas opciones: ${optionList(issue.options as unknown[])}.`
        : 'El valor no es válido.';
    case 'invalid_format':
      return issue.format === 'datetime' || issue.format === 'date'
        ? 'La fecha no es válida (usa el formato ISO 8601, por ejemplo 2026-01-05T10:00:00Z).'
        : 'El formato no es válido.';
    case 'unrecognized_keys':
      return `Campo(s) no admitido(s): ${issue.keys.join(', ')}.`;
    case 'not_multiple_of':
      return `Debe ser múltiplo de ${String(issue.divisor)}.`;
    case 'invalid_key':
    case 'invalid_element':
    case 'custom':
      return 'El valor no es válido.';
  }
}

/** Parse params that give every issue its Spanish message (a schema's own message wins). */
export const SPANISH_ERRORS = { error: spanishIssueMessage } as const;

export interface FieldError {
  /** Dotted path of the field in the body or query (`note`, `orders.0.loinc`). */
  readonly path: string;
  /** Spanish, for the person who filled the form. */
  readonly message: string;
}

/** Label of a field path for the summary: its Spanish name, else the path. */
function fieldLabel(path: readonly PropertyKey[]): string {
  const named = [...path].reverse().find((segment) => typeof segment === 'string');
  return (typeof named === 'string' ? FIELD_LABELS[named] : undefined) ?? path.join('.');
}

/** One Spanish line for the whole error: the first field, and how many more. */
function summary(issues: readonly z.core.$ZodIssue[]): string {
  const [first] = issues;
  if (first === undefined) {
    return 'Revisa los datos enviados.';
  }
  const message = first.message.charAt(0).toLowerCase() + first.message.slice(1);
  const head =
    first.path.length === 0
      ? `Revisa los datos enviados: ${message}`
      : `Revisa «${fieldLabel(first.path)}»: ${message}`;
  const rest = issues.length - 1;
  return rest === 0 ? head : `${head} (y ${plural(rest, 'campo más', 'campos más')})`;
}

export function fieldErrors(issues: readonly z.core.$ZodIssue[]): FieldError[] {
  return issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join('.'),
    message: issue.message,
  }));
}

export function validationSummary(issues: readonly z.core.$ZodIssue[]): string {
  return summary(issues);
}
