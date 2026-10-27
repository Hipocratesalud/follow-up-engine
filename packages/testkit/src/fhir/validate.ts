import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { Ajv, type AnySchemaObject, type ErrorObject, type ValidateFunction } from 'ajv';

/**
 * The official HL7 FHIR R4 (4.0.1) JSON Schema, downloaded unmodified from
 * https://hl7.org/fhir/R4/fhir.schema.json.zip and stored gzipped. The
 * SHA-256 of the uncompressed file is pinned so a swapped file fails tests.
 */
const SCHEMA_URL = new URL('../../fhir/fhir.schema.json.gz', import.meta.url);
export const FHIR_R4_SCHEMA_SHA256 =
  '2230406893b4cf002a4ee1e5e2bbeca22ac5d2d4931b3e9ef7b9594bbc376a01';

export interface FhirValidationIssue {
  /** JSON pointer into the validated resource, for example `/entry/2/resource/status`. */
  readonly path: string;
  readonly message: string;
}

export interface FhirValidationResult {
  readonly valid: boolean;
  readonly resourceType?: string;
  readonly issues: readonly FhirValidationIssue[];
}

interface Validator {
  readonly ajv: Ajv;
  readonly schemaId: string;
  readonly resourceTypes: ReadonlySet<string>;
  readonly byType: Map<string, ValidateFunction>;
}

let validator: Validator | undefined;

/** The raw (uncompressed) schema bytes, as published by HL7. */
export function readFhirR4SchemaBytes(): Buffer {
  return gunzipSync(readFileSync(SCHEMA_URL));
}

function getValidator(): Validator {
  if (validator) return validator;
  const schema = JSON.parse(readFhirR4SchemaBytes().toString('utf8')) as AnySchemaObject & {
    id?: string;
    discriminator?: { mapping?: Record<string, string> };
  };
  // The file declares draft-06 but names itself with the draft-04 `id`
  // keyword, which Ajv 8 rejects. Move it to `$id`; nothing else changes.
  const schemaId = schema.id ?? 'http://hl7.org/fhir/json-schema/4.0';
  delete schema.id;
  schema.$id = schemaId;

  const require = createRequire(import.meta.url);
  const draft06 = require('ajv/dist/refs/json-schema-draft-06.json') as AnySchemaObject;
  // strict: false because the schema uses the non-standard `discriminator`
  // annotation; it is informational and ignored.
  const ajv = new Ajv({ strict: false, allErrors: true });
  ajv.addMetaSchema(draft06);
  ajv.addSchema(schema);

  validator = {
    ajv,
    schemaId,
    resourceTypes: new Set(Object.keys(schema.discriminator?.mapping ?? {})),
    byType: new Map(),
  };
  return validator;
}

function validateFunctionFor(v: Validator, resourceType: string): ValidateFunction {
  const cached = v.byType.get(resourceType);
  if (cached) return cached;
  const fn = v.ajv.getSchema(`${v.schemaId}#/definitions/${resourceType}`);
  if (!fn) throw new Error(`No FHIR R4 schema for ${resourceType}`);
  v.byType.set(resourceType, fn);
  return fn;
}

function toIssues(errors: readonly ErrorObject[] | null | undefined, prefix: string) {
  return (errors ?? []).map((error) => ({
    path: `${prefix}${error.instancePath}`,
    message:
      error.keyword === 'additionalProperties'
        ? `unknown property "${String((error.params as { additionalProperty: unknown }).additionalProperty)}"`
        : (error.message ?? error.keyword),
  }));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateOne(v: Validator, resource: unknown, prefix: string): FhirValidationIssue[] {
  if (!isObject(resource) || typeof resource['resourceType'] !== 'string') {
    return [{ path: prefix || '/', message: 'not a FHIR resource (missing resourceType)' }];
  }
  const resourceType = resource['resourceType'];
  if (!v.resourceTypes.has(resourceType)) {
    return [
      { path: `${prefix}/resourceType`, message: `unknown R4 resource type "${resourceType}"` },
    ];
  }
  // Validate nested resources one by one first: the R4 schema checks them
  // through a `oneOf` over every resource type, whose errors are unreadable.
  const nested: FhirValidationIssue[] = [];
  const entries = resource['entry'];
  if (resourceType === 'Bundle' && Array.isArray(entries)) {
    entries.forEach((entry: unknown, index) => {
      if (isObject(entry) && entry['resource'] !== undefined) {
        nested.push(
          ...validateOne(v, entry['resource'], `${prefix}/entry/${String(index)}/resource`),
        );
      }
    });
  }
  const contained = resource['contained'];
  if (Array.isArray(contained)) {
    contained.forEach((item: unknown, index) => {
      nested.push(...validateOne(v, item, `${prefix}/contained/${String(index)}`));
    });
  }
  if (nested.length > 0) return nested;

  const fn = validateFunctionFor(v, resourceType);
  return fn(resource) ? [] : toIssues(fn.errors, prefix);
}

/**
 * Validates a FHIR resource (including a Bundle and every resource in it)
 * against the official FHIR R4 JSON Schema. Structural validation only:
 * cardinality, data types, primitive formats, value-set bindings that the
 * schema encodes as enums, and unknown properties. It does not check
 * terminology membership or invariants (FHIRPath constraints).
 */
export function validateFhirR4(resource: unknown): FhirValidationResult {
  const issues = validateOne(getValidator(), resource, '');
  const resourceType =
    isObject(resource) && typeof resource['resourceType'] === 'string'
      ? resource['resourceType']
      : undefined;
  return {
    valid: issues.length === 0,
    ...(resourceType === undefined ? {} : { resourceType }),
    issues,
  };
}

/** Throws with readable issues when {@link validateFhirR4} fails. */
export function assertValidFhirR4(resource: unknown, label = 'resource'): void {
  const result = validateFhirR4(resource);
  if (!result.valid) {
    const details = result.issues
      .slice(0, 10)
      .map((issue) => `  ${issue.path || '/'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid FHIR R4 ${label}:\n${details}`);
  }
}
