/**
 * Adjudicator eval CLI (PRD V2, workstream E).
 *
 *   pnpm --filter @follow-up-engine/llm eval:adjudicator                 # scripted, offline
 *   META_API_KEY=... pnpm --filter @follow-up-engine/llm eval:adjudicator --provider meta
 *
 * Runs the adjudicator over the gold set of synthetic ambiguous items
 * (`packages/testkit/fixtures/adjudicator-gold/gold.json`) through the real
 * gateway and the engine's checks, prints accuracy, the Brier score and the
 * cost, and writes `docs/evals/adjudicator/<date>-<provider>-<model>.md`.
 * A live run is about 20 small calls.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createAdjudicator } from '../../adjudicator/agent.ts';
import { ADJUDICATION_PROMPT_VERSION, ADJUDICATION_TASK } from '../../adjudicator/prompt.ts';
import {
  FAKE_ADJUDICATOR_MODEL,
  scriptedAdjudicatorResponder,
} from '../../adjudicator/scripted.ts';
import { LlmConfigError } from '../../errors.ts';
import { createLlmGateway } from '../../gateway/gateway.ts';
import { DEFAULT_PRICING } from '../../pricing.ts';
import type { StructuredLlmProvider } from '../../providers/chat-completions.ts';
import { createFakeProvider } from '../../providers/fake.ts';
import { createMetaProvider, META_DEFAULT_MODEL } from '../../providers/meta.ts';
import { InMemoryLlmUsageLog } from '../../usage-log.ts';
import { loadAdjudicatorGold, renderAdjudicatorReport, runAdjudicatorEval } from './run.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
export const ADJUDICATOR_GOLD_PATH = join(
  REPO_ROOT,
  'packages/testkit/fixtures/adjudicator-gold/gold.json',
);

const HELP = `Usage: eval:adjudicator [--provider fake|meta] [--model <id>] [--limit N] [--no-report]

  --provider <name>  fake (the scripted adjudicator, offline, default) or meta (META_API_KEY)
  --model <id>       meta model (default ${META_DEFAULT_MODEL})
  --limit <n>        only the first n gold items
  --out <dir>        report directory (default docs/evals/adjudicator)
  --no-report        print the summary only
`;

async function main(argv: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      provider: { type: 'string', default: 'fake' },
      model: { type: 'string' },
      limit: { type: 'string' },
      out: { type: 'string' },
      'no-report': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  let provider: StructuredLlmProvider;
  let model: string;
  const kind = values.provider;
  if (kind === 'meta') {
    const apiKey = process.env['META_API_KEY'];
    if (apiKey === undefined || apiKey.trim() === '') {
      throw new LlmConfigError('Set META_API_KEY to run against Muse Spark');
    }
    model = values.model ?? META_DEFAULT_MODEL;
    provider = createMetaProvider({ apiKey });
  } else if (kind === 'fake') {
    model = FAKE_ADJUDICATOR_MODEL;
    provider = createFakeProvider({ respond: scriptedAdjudicatorResponder });
  } else {
    throw new LlmConfigError('--provider must be fake or meta');
  }
  const gateway = createLlmGateway({
    providers: { [kind]: provider },
    tasks: { [ADJUDICATION_TASK]: { route: [{ provider: kind, model }], maxOutputTokens: 3_000 } },
    usageLog: new InMemoryLlmUsageLog(),
    pricing: DEFAULT_PRICING,
  });
  const all = await loadAdjudicatorGold(ADJUDICATOR_GOLD_PATH);
  const items = values.limit === undefined ? all : all.slice(0, Number(values.limit));
  process.stdout.write(`Adjudicating ${String(items.length)} gold items on ${kind}/${model}\n`);
  const run = await runAdjudicatorEval({
    items,
    adjudicator: createAdjudicator({ gateway }),
    provider: kind,
    model,
    promptVersion: ADJUDICATION_PROMPT_VERSION,
    onItem: (result) => {
      process.stdout.write(
        `  ${result.id} expected ${result.expected} decided ${result.decision} (model ${result.modelDecision}, p=${result.probability.toFixed(2)})${result.error === undefined ? '' : ` ${result.error}`}\n`,
      );
    },
  });
  const { totals } = run;
  process.stdout.write(
    `accuracy ${(totals.accuracy * 100).toFixed(1)}% | model ${(totals.modelAccuracy * 100).toFixed(1)}% | flips ${String(totals.flips)} | brier ${totals.brier?.toFixed(4) ?? 'n/a'} | unverified quotes ${String(totals.unverifiedQuotes)} | errors ${String(totals.errors)} | cost $${totals.costUsd.toFixed(6)} | mean latency ${String(totals.avgLatencyMs)} ms\n`,
  );
  if (!values['no-report']) {
    const outDir = values.out ? resolve(values.out) : join(REPO_ROOT, 'docs/evals/adjudicator');
    await mkdir(outDir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const file = join(outDir, `${date}-${kind}-${model.replace(/[^a-z0-9.-]/gi, '_')}.md`);
    const note =
      kind === 'fake'
        ? "> Fake provider: the **scripted adjudicator**, deterministic cue words over the item's sentence, through the real gateway and the engine's checks. It was written next to this gold set, so its score shows the protocol and the checks, not clinical judgment."
        : '';
    await writeFile(file, renderAdjudicatorReport(run, date, note), 'utf8');
    process.stdout.write(`Report: ${file}\n`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`,
  );
  process.exitCode = 1;
});
