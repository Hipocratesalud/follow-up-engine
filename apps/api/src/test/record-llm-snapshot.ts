import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
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
 * `--max-usd <n>` caps the live spend (default 10; a full recording costs
 * about $7.3: $4.7 for the 918 notes, $2.6 for the 185 reviews); past it a
 * request is read by the fake provider, exactly as the demo seed reads a
 * request missing from the snapshot. `--no-reviews` records the backfill only.
 */

const { values } = parseArgs({
  options: {
    'max-usd': { type: 'string', default: '10' },
    reviews: { type: 'boolean', default: true },
    'no-reviews': { type: 'boolean', default: false },
  },
});
/** Live spend cap (USD at list price); past it, requests are read by the fake provider. */
const maxUsd = Number(values['max-usd']);
if (!Number.isFinite(maxUsd) || maxUsd < 0) throw new Error('--max-usd must be a number of USD');
if (values['no-reviews']) values.reviews = false;

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

const runtimes = await Promise.all(
  Array.from({ length: SLICES }, (_, index) =>
    createRuntime(
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
        llmSnapshot: {
          snapshot: existing,
          onRecord: record,
          onReplay: keep,
          // Past the cap a request is read by the fake provider, as the demo
          // seed would read it, and not recorded.
          allowLive: () => liveCostUsd < maxUsd,
        },
      },
    ),
  ),
);
try {
  // Every note first, then the reviews: under a spending cap, the readings
  // the inbox is built from come first.
  const seeds = await Promise.all(
    runtimes.map((runtime, index) =>
      seedSyntheticClinic(runtime, {
        apiKey: DEFAULT_DEMO_API_KEY,
        inboxApiKey: DEFAULT_DEMO_INBOX_API_KEY,
        slice: { index, count: SLICES },
        ...(process.env['SEED_PATIENTS'] === undefined
          ? {}
          : { patients: Number(process.env['SEED_PATIENTS']) }),
      }),
    ),
  );
  process.stdout.write(
    `seeded ${String(seeds.reduce((sum, seed) => sum + seed.documentsProcessed, 0))} notes; live so far $${liveCostUsd.toFixed(4)}\n`,
  );
  const pilots = values.reviews
    ? await Promise.all(
        runtimes.map((runtime, index) => seedReviewerPilot(runtime, { cohort: index === 0 })),
      )
    : [];
  for (const [index, runtime] of runtimes.entries()) {
    const stats = runtime.llmReplay?.stats() ?? { hits: 0, misses: 0 };
    hits += stats.hits;
    misses += stats.misses;
    process.stdout.write(
      `slice ${String(index + 1)}/${String(SLICES)}: ${String(seeds[index]?.patients ?? 0)} patients, ${String(seeds[index]?.documentsProcessed ?? 0)} notes, ${String(pilots[index]?.reviewed ?? 0)} reviews; ${String(stats.hits)} replayed, ${String(stats.misses)} not in the snapshot\n`,
    );
  }
} finally {
  await Promise.all(runtimes.map((runtime) => runtime.close()));
}

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
  `${path}: ${String(used.size)} entries (${String(hits)} replayed, ${String(misses)} not in the snapshot; live spend $${liveCostUsd.toFixed(4)} of the $${maxUsd.toFixed(2)} cap) in ${String(Math.round((performance.now() - started) / 1000))} s\n`,
);
