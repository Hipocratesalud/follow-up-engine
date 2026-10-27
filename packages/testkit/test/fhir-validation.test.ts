import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FHIR_R4_SCHEMA_SHA256, readFhirR4SchemaBytes } from '../src/fhir/validate.ts';
import { assertValidFhirR4, validateFhirR4 } from '../src/index.ts';

const patient = { resourceType: 'Patient', id: 'pat-1', gender: 'female', birthDate: '1980-02-29' };

describe('validateFhirR4', () => {
  it('uses the unmodified official R4 4.0.1 schema', () => {
    expect(createHash('sha256').update(readFhirR4SchemaBytes()).digest('hex')).toBe(
      FHIR_R4_SCHEMA_SHA256,
    );
  });

  it('accepts a valid resource', () => {
    expect(validateFhirR4(patient)).toEqual({ valid: true, resourceType: 'Patient', issues: [] });
  });

  it.each([
    ['an unknown property', { ...patient, nickname: 'Ana' }, 'unknown property "nickname"'],
    [
      'a value outside a required binding',
      { ...patient, gender: 'f' },
      'must be equal to one of the allowed values',
    ],
    ['a malformed date', { ...patient, birthDate: '29/02/1980' }, 'must match pattern'],
    [
      'a missing required element',
      { resourceType: 'Encounter', id: 'e1', status: 'finished' },
      "must have required property 'class'",
    ],
  ])('rejects %s', (_label, resource, message) => {
    const result = validateFhirR4(resource);
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.message).join('\n')).toContain(message);
  });

  it('rejects unknown resource types and non-resources', () => {
    expect(validateFhirR4({ resourceType: 'Prescription', id: 'x' }).issues[0]?.message).toContain(
      'unknown R4 resource type',
    );
    expect(validateFhirR4('Patient').valid).toBe(false);
  });

  it('reports an invalid resource inside a Bundle with its path', () => {
    const bundle = {
      resourceType: 'Bundle',
      type: 'transaction',
      entry: [
        { resource: patient, request: { method: 'PUT', url: 'Patient/pat-1' } },
        {
          resource: { ...patient, id: 'pat-2', gender: 'x' },
          request: { method: 'PUT', url: 'Patient/pat-2' },
        },
      ],
    };
    const result = validateFhirR4(bundle);
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.path).toBe('/entry/1/resource/gender');
    expect(() => {
      assertValidFhirR4(bundle, 'test bundle');
    }).toThrow(/Invalid FHIR R4 test bundle/);
  });
});
