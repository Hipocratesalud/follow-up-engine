import type { z } from 'zod';
import type { ApiMessages, ValidationMessages } from '../i18n/index.ts';

/*
 * Validation errors in the request's language for the clinic team: a zod
 * error map for every request the JSON API parses (`readJson`,
 * `readQuery`), and the `{ error: { code: 'invalid_request', message,
 * fields } }` body built from it. A schema `refine` names its message by key
 * (`params: { message: 'snoozeDaysRequired' }`, see `ValidationMessages.custom`),
 * so it is localized too; a literal message in a schema wins as is.
 */

function sizeMessage(
  v: ValidationMessages,
  origin: string,
  bound: number | bigint,
  direction: 'max' | 'min',
  inclusive: boolean,
): string {
  const limit = direction === 'max' ? v.atMost : v.atLeast;
  switch (origin) {
    case 'string':
      if (direction === 'min' && Number(bound) === 1) {
        return v.notEmpty;
      }
      return v.sized(limit, v.characters(Number(bound)));
    case 'array':
    case 'set':
      return v.sized(limit, v.elements(Number(bound)));
    case 'date':
      return direction === 'max' ? v.dateTooLate : v.dateTooEarly;
    default:
      if (!inclusive) {
        return direction === 'max' ? v.lessThan(String(bound)) : v.greaterThan(String(bound));
      }
      return v.bounded(limit, String(bound));
  }
}

function optionList(values: readonly unknown[]): string {
  return values.map((value) => String(value)).join(', ');
}

type RawIssue = Parameters<z.core.$ZodErrorMap>[0];

function customMessage(v: ValidationMessages, issue: RawIssue): string | undefined {
  const params = (issue as { params?: unknown }).params;
  const key =
    typeof params === 'object' && params !== null
      ? (params as { message?: unknown }).message
      : undefined;
  return typeof key === 'string' && key in v.custom
    ? v.custom[key as keyof ValidationMessages['custom']]
    : undefined;
}

/** zod error map: a message in the catalog's language for each issue. */
export function issueMessage(t: ApiMessages): (issue: RawIssue) => string {
  const v = t.validation;
  return (issue) => {
    const missing =
      issue.input === undefined &&
      (issue.code === 'invalid_type' ||
        issue.code === 'invalid_value' ||
        issue.code === 'invalid_union');
    if (missing) {
      return v.required;
    }
    switch (issue.code) {
      case 'invalid_type':
        return v.mustBe(v.typeNames[issue.expected] ?? v.otherType);
      case 'too_big':
        return sizeMessage(v, issue.origin, issue.maximum, 'max', issue.inclusive ?? true);
      case 'too_small':
        return sizeMessage(v, issue.origin, issue.minimum, 'min', issue.inclusive ?? true);
      case 'invalid_value':
        return issue.values.length === 1
          ? v.mustBe(String(issue.values[0]))
          : v.oneOf(optionList(issue.values));
      case 'invalid_union':
        return 'options' in issue && Array.isArray(issue.options)
          ? v.oneOf(optionList(issue.options as unknown[]))
          : v.invalidValue;
      case 'invalid_format':
        return issue.format === 'datetime' || issue.format === 'date'
          ? v.invalidDate
          : v.invalidFormat;
      case 'unrecognized_keys':
        return v.unrecognizedKeys(issue.keys.join(', '));
      case 'not_multiple_of':
        return v.multipleOf(String(issue.divisor));
      case 'custom':
        return customMessage(v, issue) ?? v.invalidValue;
      case 'invalid_key':
      case 'invalid_element':
        return v.invalidValue;
    }
  };
}

/** Parse params that give every issue its localized message (a schema's own literal message wins). */
export function parseErrors(t: ApiMessages): { readonly error: (issue: RawIssue) => string } {
  return { error: issueMessage(t) };
}

export interface FieldError {
  /** Dotted path of the field in the body or query (`note`, `orders.0.loinc`). */
  readonly path: string;
  /** In the request's language, for the person who filled the form. */
  readonly message: string;
}

/** Label of a field path for the summary: its name in the catalog, else the path. */
function fieldLabel(v: ValidationMessages, path: readonly PropertyKey[]): string {
  const named = [...path].reverse().find((segment) => typeof segment === 'string');
  return (typeof named === 'string' ? v.fields[named] : undefined) ?? path.join('.');
}

export function fieldErrors(issues: readonly z.core.$ZodIssue[]): FieldError[] {
  return issues.map((issue) => ({
    path: issue.path.map((segment) => String(segment)).join('.'),
    message: issue.message,
  }));
}

/** One line for the whole error: the first field, and how many more. */
export function validationSummary(issues: readonly z.core.$ZodIssue[], t: ApiMessages): string {
  const v = t.validation;
  const [first] = issues;
  if (first === undefined) {
    return v.checkRequest;
  }
  const message = first.message.charAt(0).toLowerCase() + first.message.slice(1);
  const head =
    first.path.length === 0
      ? v.checkRequestWith(message)
      : v.checkField(fieldLabel(v, first.path), message);
  const rest = issues.length - 1;
  return rest === 0 ? head : v.moreFields(head, rest);
}
