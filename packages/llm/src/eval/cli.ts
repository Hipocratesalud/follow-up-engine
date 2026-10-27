/**
 * Extraction eval CLI.
 *
 *   pnpm --filter @follow-up-engine/llm eval:extraction --provider fake
 *   META_API_KEY=... pnpm --filter @follow-up-engine/llm eval:extraction --provider meta
 *   BASETEN_API_KEY=... pnpm --filter @follow-up-engine/llm eval:extraction --provider baseten
 *   pnpm --filter @follow-up-engine/llm eval:extraction --provider openai-compatible \
 *     --base-url https://api.together.xyz/v1 --api-key-env TOGETHER_API_KEY \
 *     --model some/model --price-in 0.2 --price-out 0.6
 *
 * Run `--help` for every flag.
 */
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { clinicId } from '@follow-up-engine/core';
import { LlmConfigError } from '../errors.ts';
import {
  chainResponders,
  createNoteFixtureResponder,
  modelOutputFromExpected,
} from '../extraction/fixtures.ts';
import { heuristicResponder } from '../extraction/heuristic-baseline.ts';
import { createNoteExtractor } from '../extraction/note-extractor.ts';
import { NOTE_EXTRACTION_PROMPT_VERSION, NOTE_EXTRACTION_TASK } from '../extraction/prompt.ts';
import { createLlmGateway } from '../gateway/gateway.ts';
import { DEFAULT_PRICING, type PricingTable } from '../pricing.ts';
import {
  STRUCTURED_OUTPUT_MODES,
  type StructuredLlmProvider,
  type StructuredOutputMode,
} from '../providers/chat-completions.ts';
import { FAKE_DEFAULT_MODEL, createFakeProvider } from '../providers/fake.ts';
import {
  META_DEFAULT_MODEL,
  createMetaProvider,
  type MetaReasoningEffort,
} from '../providers/meta.ts';
import {
  BASETEN_BASE_URL,
  BASETEN_MUSE_SPARK_OPEN_MODEL,
  createBasetenProvider,
  createOpenAiCompatibleProvider,
} from '../providers/openai-compatible.ts';
import { InMemoryLlmUsageLog } from '../usage-log.ts';
import { loadGoldNotes, type GoldNote } from './gold.ts';
import { renderReport, reportFileName, reportSidecar } from './report.ts';
import { runExtractionEval } from './run.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SHARED_GOLD_DIR = join(REPO_ROOT, 'packages/testkit/fixtures/gold-notes');
const LOCAL_GOLD_DIR = join(REPO_ROOT, 'packages/llm/test/fixtures/gold-notes');
const PROVIDERS = ['meta', 'baseten', 'openai-compatible', 'fake'] as const;
type ProviderKind = (typeof PROVIDERS)[number];

const HELP = `Usage: eval:extraction --provider <${PROVIDERS.join('|')}> [options]

  --provider <name>        meta (Muse Spark, META_API_KEY), baseten (Muse Spark Open, BASETEN_API_KEY),
                           openai-compatible (any endpoint, see --base-url), fake (offline, default)
  --model <id>             model id (defaults: meta ${META_DEFAULT_MODEL}, baseten ${BASETEN_MUSE_SPARK_OPEN_MODEL})
  --limit <n>              only the first n gold notes
  --concurrency <n>        parallel extractions (default 4)
  --gold <dir>             gold-note directory (default: testkit fixtures, else packages/llm/test/fixtures)
  --out <dir>              report directory (default docs/evals)
  --base-url <url>         openai-compatible base URL (default ${BASETEN_BASE_URL})
  --api-key-env <VAR>      env var holding the openai-compatible key (default BASETEN_API_KEY)
  --name <label>           provider label in pricing and reports (openai-compatible only)
  --output-mode <mode>     ${STRUCTURED_OUTPUT_MODES.join(' | ')}
  --reasoning-effort <e>   meta only: minimal | low | medium | high | xhigh (default low)
  --price-in <usd>         USD per 1M input tokens, for models not in the pricing table
  --price-out <usd>        USD per 1M output tokens
  --allow-contributor      meta only: allow *-contributor models (Meta may train on the data; synthetic notes only)
  --fake-mode <mode>       baseline (rule-based, default) | oracle (returns the gold answer)
  --no-report              print the summary only
`;

/** The shared testkit gold set once it has notes, otherwise this package's seed notes. */
function defaultGoldDir(): string {
  const hasNotes =
    existsSync(SHARED_GOLD_DIR) && readdirSync(SHARED_GOLD_DIR).some((f) => f.endsWith('.json'));
  return hasNotes ? SHARED_GOLD_DIR : LOCAL_GOLD_DIR;
}

function positiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0)
    throw new LlmConfigError(`${flag} must be a positive integer`);
  return n;
}

function requireEnv(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim() !== '') return value;
  }
  throw new LlmConfigError(`Set ${names.join(' or ')} to run against a real model`);
}

function outputMode(value: string | undefined): StructuredOutputMode | undefined {
  if (value === undefined) return undefined;
  if ((STRUCTURED_OUTPUT_MODES as readonly string[]).includes(value)) {
    return value as StructuredOutputMode;
  }
  throw new LlmConfigError(`--output-mode must be one of ${STRUCTURED_OUTPUT_MODES.join(', ')}`);
}

async function main(argv: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      provider: { type: 'string', default: 'fake' },
      model: { type: 'string' },
      limit: { type: 'string' },
      concurrency: { type: 'string' },
      gold: { type: 'string' },
      out: { type: 'string' },
      'base-url': { type: 'string' },
      'api-key-env': { type: 'string' },
      name: { type: 'string' },
      'output-mode': { type: 'string' },
      'reasoning-effort': { type: 'string' },
      'price-in': { type: 'string' },
      'price-out': { type: 'string' },
      'fake-mode': { type: 'string', default: 'baseline' },
      'allow-contributor': { type: 'boolean', default: false },
      'no-report': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  const kind = values.provider as ProviderKind;
  if (!PROVIDERS.includes(kind))
    throw new LlmConfigError(`--provider must be one of ${PROVIDERS.join(', ')}`);
  const goldDir = values.gold ? resolve(values.gold) : defaultGoldDir();
  const limit = positiveInt(values.limit, '--limit');
  const concurrency = positiveInt(values.concurrency, '--concurrency') ?? 4;
  const allNotes = await loadGoldNotes(goldDir);
  const notes: GoldNote[] = limit === undefined ? allNotes : allNotes.slice(0, limit);
  const mode = outputMode(values['output-mode']);

  let provider: StructuredLlmProvider;
  let model: string;
  let label: string;
  let runNote: string | undefined;
  switch (kind) {
    case 'meta':
      label = 'meta';
      model = values.model ?? META_DEFAULT_MODEL;
      provider = createMetaProvider({
        apiKey: requireEnv('META_API_KEY', 'MODEL_API_KEY'),
        promptCacheKey: NOTE_EXTRACTION_PROMPT_VERSION,
        allowContributorMode: values['allow-contributor'],
        ...(mode ? { outputMode: mode } : {}),
        ...(values['reasoning-effort']
          ? { reasoningEffort: values['reasoning-effort'] as MetaReasoningEffort }
          : {}),
      });
      break;
    case 'baseten':
      label = 'baseten';
      model = values.model ?? BASETEN_MUSE_SPARK_OPEN_MODEL;
      provider = createBasetenProvider({
        apiKey: requireEnv('BASETEN_API_KEY'),
        ...(values['base-url'] ? { baseUrl: values['base-url'] } : {}),
        ...(mode ? { outputMode: mode } : {}),
      });
      break;
    case 'openai-compatible': {
      label = values.name ?? 'openai-compatible';
      model = values.model ?? BASETEN_MUSE_SPARK_OPEN_MODEL;
      provider = createOpenAiCompatibleProvider({
        name: label,
        baseUrl: values['base-url'] ?? BASETEN_BASE_URL,
        apiKey: requireEnv(values['api-key-env'] ?? 'BASETEN_API_KEY'),
        ...(mode ? { outputMode: mode } : {}),
      });
      break;
    }
    case 'fake': {
      label = 'fake';
      const oracle = values['fake-mode'] === 'oracle';
      model = values.model ?? (oracle ? 'oracle' : FAKE_DEFAULT_MODEL);
      const fixtures = createNoteFixtureResponder(
        notes.map((n) => ({ text: n.text, output: modelOutputFromExpected(n.expected) })),
      );
      provider = createFakeProvider({
        respond: oracle ? chainResponders(fixtures) : heuristicResponder,
      });
      runNote = oracle
        ? '> Fake provider in **oracle** mode: it returns the gold answer, so this run checks the harness and the post-checks, not a model. Anything below 100% is a harness or post-check bug.'
        : '> Fake provider in **baseline** mode: a deterministic, rule-based extractor (regexes, no model). It runs offline in CI and is the floor a Meta model has to beat. Its rules were written while looking at the gold notes, so it overstates how well regexes generalize. It reads the note the model would see (names masked, capped) and passes the same evidence checks.';
      break;
    }
  }

  let pricing: PricingTable = DEFAULT_PRICING;
  if (values['price-in'] !== undefined || values['price-out'] !== undefined) {
    pricing = {
      ...DEFAULT_PRICING,
      [`${label}:${model}`]: {
        inputPerMTok: Number(values['price-in'] ?? 0),
        outputPerMTok: Number(values['price-out'] ?? 0),
        source: 'eval CLI flags --price-in/--price-out',
      },
    };
  } else if (kind === 'fake') {
    pricing = {
      ...DEFAULT_PRICING,
      [`fake:${model}`]: { inputPerMTok: 0, outputPerMTok: 0, source: 'fake' },
    };
  }

  const usageLog = new InMemoryLlmUsageLog();
  const gateway = createLlmGateway({
    providers: { [label]: provider },
    tasks: {
      [NOTE_EXTRACTION_TASK]: { route: [{ provider: label, model }], maxOutputTokens: 8_000 },
    },
    usageLog,
    pricing,
  });
  const extractor = createNoteExtractor({ gateway });

  process.stdout.write(
    `Evaluating ${String(notes.length)} notes from ${goldDir} on ${label}/${model}\n`,
  );
  const run = await runExtractionEval({
    notes,
    extractor,
    provider: label,
    model,
    promptVersion: NOTE_EXTRACTION_PROMPT_VERSION,
    clinicId: clinicId('clinic-eval'),
    concurrency,
    onNote: (r) => {
      process.stdout.write(`  ${r.id} ${r.error ? `ERROR ${r.error}` : 'ok'}\n`);
    },
  });

  const { overall } = run.summary;
  process.stdout.write(
    [
      `conditions F1 ${(overall.scores.conditions.f1 * 100).toFixed(1)}%`,
      `medications F1 ${(overall.scores.medications.f1 * 100).toFixed(1)}%`,
      `plan items F1 ${(overall.scores.planItems.f1 * 100).toFixed(1)}%`,
      `hasPlan ${(overall.hasPlanAccuracy * 100).toFixed(1)}%`,
      `discharge ${(overall.dischargeAccuracy * 100).toFixed(1)}%`,
      `hallucinated quotes ${(overall.hallucinatedQuoteRate * 100).toFixed(1)}%`,
      `cost/note $${run.summary.cost.perNoteUsd.toFixed(6)}`,
      `p50 ${String(run.summary.latencyMs.p50)} ms`,
    ].join(' | ') + '\n',
  );

  if (!values['no-report']) {
    const outDir = values.out ? resolve(values.out) : join(REPO_ROOT, 'docs/evals');
    await mkdir(outDir, { recursive: true });
    const file = join(outDir, reportFileName(run));
    const dataset = `${relative(REPO_ROOT, goldDir)} (${String(notes.length)} of ${String(allNotes.length)} notes)`;
    const header = [`- Gold set: \`${dataset}\``, ...(runNote ? ['', runNote] : [])].join('\n');
    await writeFile(file, renderReport(run, header), 'utf8');
    await writeFile(
      file.replace(/\.md$/, '.json'),
      `${JSON.stringify(reportSidecar(run, dataset), null, 2)}\n`,
      'utf8',
    );
    process.stdout.write(`Report: ${file}\n`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`,
  );
  process.exitCode = 1;
});
