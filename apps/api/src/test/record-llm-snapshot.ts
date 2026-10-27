import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  CLINICAL_REVIEW_PROMPT_VERSION,
  costOf,
  DEFAULT_PRICING,
  emptySnapshot,
  type LlmSnapshot,
  type LlmSnapshotEntry,
  NOTE_EXTRACTION_PROMPT_VERSION,
  parseSnapshot,
  priceFor,
  serializeSnapshot,
} from '@follow-up-engine/llm';
import {
  createRuntime,
  DEFAULT_DEMO_API_KEY,
  DEFAULT_DEMO_INBOX_API_KEY,
  loadRuntimeConfig,
} from '@follow-up-engine/runtime';
import { LLM_SNAPSHOTS, llmSnapshotPath, readLlmSnapshot } from '@follow-up-engine/testkit';
import { seedReviewerPilot } from './seed-reviewer.ts';
import { seedSyntheticClinic } from './seed.ts';

/*
 * `pnpm --filter @follow-up-engine/api demo:record` (needs META_API_KEY):
 * records the demo seed's Muse Spark readings into
 * `packages/testkit/fixtures/llm-snapshots/demo-clinic.meta.json`, which
 * `pnpm demo` replays with LLM_PROVIDER=meta. Every note extraction of the
 * initial backfill and every step of the reviewer's shadow pilot is a
 * request; requests already in the snapshot are replayed (free), the rest
 * call the Meta Model API. Four in-memory runtimes seed disjoint quarters of
 * the clinic at once (a patient's readings only depend on that patient's
 * record), so recording from scratch takes minutes, not an hour. Entries no
 * request used any more (an older prompt version) are dropped.
 * `SEED_PATIENTS=N` records only the first N patients (a smoke check).
 */

const SLICES = 4;
const path = llmSnapshotPath(LLM_SNAPSHOTS.demoClinic);
const promptVersions = [NOTE_EXTRACTION_PROMPT_VERSION, CLINICAL_REVIEW_PROMPT_VERSION];
const existingText = readLlmSnapshot(LLM_SNAPSHOTS.demoClinic);
const existing: LlmSnapshot =
  existingText === undefined ? emptySnapshot('meta', promptVersions) : parseSnapshot(existingText);

const used = new Map<string, LlmSnapshotEntry>();
const keep = (key: string, entry: LlmSnapshotEntry): void => {
  used.set(key, entry);
};
let liveCostUsd = 0;
const record = (key: string, entry: LlmSnapshotEntry): void => {
  keep(key, entry);
  const price = priceFor(DEFAULT_PRICING, 'meta', entry.model);
  if (price !== undefined) liveCostUsd += costOf(price, entry.usage);
};
const started = performance.now();
let hits = 0;
let misses = 0;

await Promise.all(
  Array.from({ length: SLICES }, async (_, index) => {
    const runtime = await createRuntime(
      loadRuntimeConfig({
        ...process.env,
        LLM_PROVIDER: 'meta',
        CLOCK: 'fake',
        DATABASE_URL: '',
        LOG_LEVEL: 'warn',
        DEMO_API_KEY: DEFAULT_DEMO_API_KEY,
        DEMO_INBOX_API_KEY: DEFAULT_DEMO_INBOX_API_KEY,
      }),
      {
        service: `record-${String(index)}`,
        llmSnapshot: { snapshot: existing, onRecord: record, onReplay: keep },
      },
    );
    try {
      const seed = await seedSyntheticClinic(runtime, {
        apiKey: DEFAULT_DEMO_API_KEY,
        inboxApiKey: DEFAULT_DEMO_INBOX_API_KEY,
        slice: { index, count: SLICES },
        ...(process.env['SEED_PATIENTS'] === undefined
          ? {}
          : { patients: Number(process.env['SEED_PATIENTS']) }),
      });
      const pilot = await seedReviewerPilot(runtime, { cohort: index === 0 });
      const stats = runtime.llmReplay?.stats() ?? { hits: 0, misses: 0 };
      hits += stats.hits;
      misses += stats.misses;
      process.stdout.write(
        `slice ${String(index + 1)}/${String(SLICES)}: ${String(seed.patients)} patients, ${String(seed.documentsProcessed)} notes, ${String(pilot.reviewed)} reviews; ${String(stats.hits)} replayed, ${String(stats.misses)} live\n`,
      );
    } finally {
      await runtime.close();
    }
  }),
);

const snapshot: LlmSnapshot = {
  format: 1,
  provider: 'meta',
  promptVersions,
  recordedAt:
    misses > 0 ? new Date().toISOString() : (existing.recordedAt ?? new Date().toISOString()),
  entries: Object.fromEntries(used),
};
await mkdir(dirname(path), { recursive: true });
await writeFile(path, serializeSnapshot(snapshot), 'utf8');
process.stdout.write(
  `${path}: ${String(used.size)} entries (${String(hits)} replayed, ${String(misses)} recorded live for $${liveCostUsd.toFixed(4)}) in ${String(Math.round((performance.now() - started) / 1000))} s\n`,
);
