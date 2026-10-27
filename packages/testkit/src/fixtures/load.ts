import { readdirSync, readFileSync } from 'node:fs';
import type { Scenario } from '../scenarios/types.ts';
import type {
  SyntheticClinic,
  SyntheticClinicDirectory,
  SyntheticPatient,
} from '../synthetic/clinic.ts';
import {
  type GoldNote,
  GoldNoteSchema,
  ScenarioSchema,
  SyntheticPatientSchema,
} from './schemas.ts';

/** Root of the committed fixtures (`packages/testkit/fixtures`). */
export const FIXTURES_DIR = new URL('../../fixtures/', import.meta.url);

function readJsonDir(relative: string): { readonly file: string; readonly json: unknown }[] {
  const dir = new URL(relative, FIXTURES_DIR);
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => ({
      file,
      json: JSON.parse(readFileSync(new URL(file, dir), 'utf8')) as unknown,
    }));
}

function parseOrThrow<T>(
  schema: {
    safeParse(input: unknown): { success: true; data: T } | { success: false; error: Error };
  },
  json: unknown,
  label: string,
): T {
  const result = schema.safeParse(json);
  if (!result.success) throw new Error(`Invalid fixture ${label}: ${result.error.message}`);
  return result.data;
}

/** The hand-labeled extraction gold set, sorted by id. */
export function loadGoldNotes(): GoldNote[] {
  return readJsonDir('gold-notes/').map(({ file, json }) =>
    parseOrThrow(GoldNoteSchema, json, `gold-notes/${file}`),
  );
}

/** The PRD acceptance scenarios, sorted by file name. */
export function loadScenarios(): Scenario[] {
  return readJsonDir('scenarios/').map(({ file, json }) => {
    parseOrThrow(ScenarioSchema, json, `scenarios/${file}`);
    return json as Scenario;
  });
}

/** The synthetic demo clinic: directory (organization, practitioners, stats) and every patient's history. */
export function loadSyntheticClinic(): SyntheticClinic {
  const clinic = JSON.parse(
    readFileSync(new URL('clinic/clinic.json', FIXTURES_DIR), 'utf8'),
  ) as SyntheticClinicDirectory;
  const patients = readJsonDir('clinic/patients/').map(({ file, json }) => {
    parseOrThrow(SyntheticPatientSchema, json, `clinic/patients/${file}`);
    return json as SyntheticPatient;
  });
  return { clinic, patients };
}
