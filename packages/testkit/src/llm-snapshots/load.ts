import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FIXTURES_DIR } from '../fixtures/load.ts';

/**
 * Recorded model replies (`LlmSnapshot` of `@follow-up-engine/llm`, format 1),
 * committed so the demo and the evals replay real Muse Spark readings of the
 * synthetic notes without calling the model. Synthetic data only.
 *
 * - `demo-clinic.meta.json`: every extraction and reviewer step of the demo
 *   seed (`pnpm --filter @follow-up-engine/api demo:record`).
 * - `gold-notes.meta.json`: the extraction eval over the gold notes
 *   (`eval:extraction --provider meta --snapshot ...`).
 * - `reviewer-cohort.meta.json`: the reviewer eval over the cohort
 *   (`eval:reviewer --provider meta --snapshot ...`).
 */
export const LLM_SNAPSHOTS = {
  demoClinic: 'demo-clinic.meta.json',
  goldNotes: 'gold-notes.meta.json',
  reviewerCohort: 'reviewer-cohort.meta.json',
} as const;

/** Absolute path of a committed snapshot file (it may not exist yet). */
export function llmSnapshotPath(name: (typeof LLM_SNAPSHOTS)[keyof typeof LLM_SNAPSHOTS]): string {
  return fileURLToPath(new URL(`llm-snapshots/${name}`, FIXTURES_DIR));
}

/** The snapshot's text, or `undefined` when it was never recorded. Parse it with `parseSnapshot`. */
export function readLlmSnapshot(
  name: (typeof LLM_SNAPSHOTS)[keyof typeof LLM_SNAPSHOTS],
): string | undefined {
  const path = llmSnapshotPath(name);
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}
