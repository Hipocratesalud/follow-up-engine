import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const FIXTURES = new URL('../fixtures/', import.meta.url);

/** A synthetic bundle from `fixtures/bundles`, parsed but untyped (as a host would send it). */
export function loadBundle(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`bundles/${name}.json`, FIXTURES), 'utf8')) as Record<
    string,
    unknown
  >;
}

/** Deep copy, for tests that mutate a fixture. */
export function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * The official FHIR R4 JSON Schema (https://hl7.org/fhir/R4/fhir.schema.json.zip),
 * read straight from the downloaded zip. The archive holds one deflated entry;
 * sizes come from the central directory because the local header defers them
 * to a data descriptor.
 */
export function loadFhirR4JsonSchema(): Record<string, unknown> {
  const zip = readFileSync(new URL('schema/fhir.schema.json.zip', FIXTURES));
  const endOfCentralDirectory = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const centralDirectory = zip.readUInt32LE(endOfCentralDirectory + 16);
  const compressedSize = zip.readUInt32LE(centralDirectory + 20);
  const localHeader = zip.readUInt32LE(centralDirectory + 42);
  const dataStart =
    localHeader + 30 + zip.readUInt16LE(localHeader + 26) + zip.readUInt16LE(localHeader + 28);
  const json = inflateRawSync(zip.subarray(dataStart, dataStart + compressedSize)).toString('utf8');
  const schema = JSON.parse(json) as Record<string, unknown>;
  // The schema declares draft-06 but uses the draft-04 `id` keyword; Ajv 8 expects `$id`.
  const { id, ...rest } = schema;
  return { ...rest, $id: id };
}
