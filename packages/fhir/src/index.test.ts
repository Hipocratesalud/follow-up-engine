import { describe, expect, it } from 'vitest';
import { FHIR_VERSION, PACKAGE_NAME } from './index.ts';

describe('@follow-up-engine/fhir', () => {
  it('is wired into the workspace', () => {
    expect(PACKAGE_NAME).toBe('@follow-up-engine/fhir');
  });

  it('pins FHIR R4', () => {
    expect(FHIR_VERSION).toBe('4.0.1');
  });
});
