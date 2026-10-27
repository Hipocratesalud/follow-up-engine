import {
  ConflictError,
  InvalidCaseTransitionError,
  InvalidCursorError,
  InvalidIdentifierError,
  NotFoundError,
  PatientContactNotAllowedError,
  TenantMismatchError,
  ValidationError,
} from '@follow-up-engine/core';
import { sanitizeFhirJson } from '@follow-up-engine/fhir';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { ApiMessages } from '../i18n/index.ts';
import { invalidTransitionMessage } from '../inbox/labels.ts';
import type { AppEnv } from './context.ts';
import { type FieldError, fieldErrors, parseErrors, validationSummary } from './validation.ts';

/**
 * An error with an HTTP status and a stable code, rendered as
 * `{ error: { code, message, fields? } }`: `fields` lists, for a validation
 * error, each field and what is wrong with it. Messages are in the
 * request's language (`c.var.t`, docs/adr/0006).
 */
export class HttpError extends Error {
  override readonly name = 'HttpError';
  readonly status: ContentfulStatusCode;
  readonly code: string;
  readonly fields?: readonly FieldError[];

  constructor(
    status: ContentfulStatusCode,
    code: string,
    message: string,
    fields?: readonly FieldError[],
  ) {
    super(message);
    this.status = status;
    this.code = code;
    if (fields !== undefined) {
      this.fields = fields;
    }
  }
}

export function notFound(t: ApiMessages, message = t.errors.notFound): HttpError {
  return new HttpError(404, 'not_found', message);
}

function invalidRequest(fields: readonly FieldError[], message: string): HttpError {
  return new HttpError(422, 'invalid_request', message, fields);
}

/**
 * Maps any error to its HTTP answer. Domain errors keep their meaning:
 * invalid transition 409, business validation 422, unknown entity 404.
 * Unexpected errors are 500 with a generic message (details only in logs).
 */
export function toHttpError(error: unknown, t: ApiMessages): HttpError {
  if (error instanceof HttpError) {
    return error;
  }
  if (error instanceof z.ZodError) {
    return invalidRequest(fieldErrors(error.issues), validationSummary(error.issues, t));
  }
  if (error instanceof InvalidCaseTransitionError) {
    return new HttpError(
      409,
      'invalid_transition',
      invalidTransitionMessage(t, error.from, error.to),
    );
  }
  if (error instanceof PatientContactNotAllowedError) {
    return new HttpError(409, 'patient_contact_not_allowed', t.contactDenials[error.reason]);
  }
  if (error instanceof ValidationError) {
    const message = t.errors.domainValidation[error.field] ?? t.errors.invalidData;
    return invalidRequest([{ path: error.field, message }], message);
  }
  if (error instanceof NotFoundError) {
    return notFound(t);
  }
  if (error instanceof InvalidCursorError) {
    return new HttpError(400, 'invalid_cursor', t.errors.invalidCursor);
  }
  if (error instanceof InvalidIdentifierError) {
    return new HttpError(400, 'invalid_identifier', t.errors.invalidIdentifier);
  }
  if (error instanceof ConflictError) {
    return new HttpError(409, 'conflict', t.errors.conflict);
  }
  if (error instanceof TenantMismatchError) {
    return notFound(t);
  }
  return new HttpError(500, 'internal_error', t.errors.internal);
}

export function errorResponse(c: Context, error: HttpError): Response {
  return c.json(
    {
      error: {
        code: error.code,
        message: error.message,
        ...(error.fields === undefined ? {} : { fields: error.fields }),
      },
    },
    error.status,
  );
}

/**
 * Reads and validates a JSON body: 400 when it is not JSON, 422
 * `invalid_request` (field by field, in the request's language) when it
 * breaks the schema.
 * Control characters (a NUL) are dropped from every string first: they
 * would never reach the clinic as text anyway.
 */
export async function readJson<TSchema extends z.ZodType>(
  c: Context<AppEnv>,
  schema: TSchema,
): Promise<z.infer<TSchema>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HttpError(400, 'invalid_json', c.var.t.errors.invalidJson);
  }
  return schema.parse(sanitizeFhirJson(body, 'body').value, parseErrors(c.var.t));
}

/** Validates the query string against a schema (422 `invalid_request` on failure, localized). */
export function readQuery<TSchema extends z.ZodType>(
  c: Context<AppEnv>,
  schema: TSchema,
): z.infer<TSchema> {
  return schema.parse(c.req.query(), parseErrors(c.var.t));
}
