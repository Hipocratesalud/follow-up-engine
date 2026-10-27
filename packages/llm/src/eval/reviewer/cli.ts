/**
 * Clinical reviewer eval CLI (HIP-112).
 *
 *   pnpm --filter @follow-up-engine/llm eval:reviewer --provider fake
 *   META_API_KEY=... pnpm --filter @follow-up-engine/llm eval:reviewer --provider meta
 *   BASETEN_API_KEY=... pnpm --filter @follow-up-engine/llm eval:reviewer --provider baseten
 *
 * Runs the real review pipeline (dossier, detectors, the agent loop through
 * the gateway, the engine's citation checks) over the testkit's reviewer
 * cohort and writes `docs/evals/reviewer/<date>-<provider>-<model>.md`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { ClinicalReviewAgent } from '@follow-up-engine/core';
import { LlmConfigError } from '../../errors.ts';
import { createLlmGateway } from '../../gateway/gateway.ts';
import { DEFAULT_PRICING } from '../../pricing.ts';
import type { StructuredLlmProvider } from '../../providers/chat-completions.ts';
import { createFakeProvider } from '../../providers/fake.ts';
import { createMetaProvider, META_DEFAULT_MODEL } from '../../providers/meta.ts';
import {
  BASETEN_BASE_URL,
  BASETEN_MUSE_SPARK_OPEN_MODEL,
  createBasetenProvider,
  createOpenAiCompatibleProvider,
} from '../../providers/openai-compatible.ts';
import { createReviewAgent } from '../../reviewer/agent.ts';
import { CLINICAL_REVIEW_PROMPT_VERSION, CLINICAL_REVIEW_TASK } from '../../reviewer/prompt.ts';
import { FAKE_REVIEWER_MODEL, scriptedReviewerResponder } from '../../reviewer/scripted.ts';
import { InMemoryLlmUsageLog } from '../../usage-log.ts';
import { loadCohort, recordOf } from './cohort.ts';
import { renderReviewerReport, reviewerReportFileName, reviewerSidecar } from './report.ts';
import { runReviewerEval } from './run.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const COHORT_DIR = join(REPO_ROOT, 'packages/testkit/fixtures/reviewer-cohort');
const PROVIDERS = ['fake', 'meta', 'baseten', 'openai-compatible', 'detectors'] as const;
type ProviderKind = (typeof PROVIDERS)[number];

const HELP = `Usage: eval:reviewer --provider <${PROVIDERS.join('|')}> [options]

  --provider <name>      fake (scripted agent, offline, default), meta (META_API_KEY), baseten
                         (BASETEN_API_KEY), openai-compatible (see --base-url), detectors (no agent)
  --model <id>           model id (defaults: meta ${META_DEFAULT_MODEL}, baseten ${BASETEN_MUSE_SPARK_OPEN_MODEL})
  --tool-calling <mode>  native (default) | structured (for endpoints without tool calling)
  --base-url <url>       openai-compatible base URL (default ${BASETEN_BASE_URL})
  --api-key-env <VAR>    env var with the openai-compatible key (default BASETEN_API_KEY)
  --out <dir>            report directory (default docs/evals/reviewer)
  --no-report            print the summary only
`;

function requireEnv(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim() !== '') return value;
  }
  throw new LlmConfigError(`Set ${names.join(' or ')} to run against a real model`);
}

async function main(argv: readonly string[]): Promise<void> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      provider: { type: 'string', default: 'fake' },
      model: { type: 'string' },
      'tool-calling': { type: 'string', default: 'native' },
      'base-url': { type: 'string' },
      'api-key-env': { type: 'string' },
      out: { type: 'string' },
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
  const toolCalling = values['tool-calling'] === 'structured' ? 'structured' : 'native';

  let provider: StructuredLlmProvider | undefined;
  let model: string;
  switch (kind) {
    case 'meta':
      model = values.model ?? META_DEFAULT_MODEL;
      provider = createMetaProvider({
        apiKey: requireEnv('META_API_KEY', 'MODEL_API_KEY'),
        toolCalling,
      });
      break;
    case 'baseten':
      model = values.model ?? BASETEN_MUSE_SPARK_OPEN_MODEL;
      provider = createBasetenProvider({ apiKey: requireEnv('BASETEN_API_KEY') });
      break;
    case 'openai-compatible':
      model = values.model ?? BASETEN_MUSE_SPARK_OPEN_MODEL;
      provider = createOpenAiCompatibleProvider({
        name: 'openai-compatible',
        baseUrl: values['base-url'] ?? BASETEN_BASE_URL,
        apiKey: requireEnv(values['api-key-env'] ?? 'BASETEN_API_KEY'),
        toolCalling,
      });
      break;
    case 'fake':
      model = FAKE_REVIEWER_MODEL;
      provider = createFakeProvider({ respond: scriptedReviewerResponder });
      break;
    case 'detectors':
      model = 'detectors-only';
      break;
  }

  let agent: ClinicalReviewAgent | undefined;
  if (provider !== undefined) {
    const gateway = createLlmGateway({
      providers: { [kind]: provider },
      tasks: {
        [CLINICAL_REVIEW_TASK]: { route: [{ provider: kind, model }], maxOutputTokens: 4_000 },
      },
      usageLog: new InMemoryLlmUsageLog(),
      pricing: DEFAULT_PRICING,
    });
    agent = createReviewAgent({ gateway });
  }

  const records = (await loadCohort(COHORT_DIR)).map(recordOf);
  process.stdout.write(`Reviewing ${String(records.length)} cohort patients on ${kind}/${model}\n`);
  const run = await runReviewerEval({
    records,
    ...(agent === undefined ? {} : { agent }),
    provider: kind,
    model,
    promptVersion: agent === undefined ? 'detectors@1' : CLINICAL_REVIEW_PROMPT_VERSION,
    onPatient: (result) => {
      process.stdout.write(
        `  ${result.patientId} ${result.kind} found [${result.found.map((item) => item.category).join(', ')}]${result.error === undefined ? '' : ` ${result.stopReason}: ${result.error}`}\n`,
      );
    },
  });
  const { totals } = run;
  const pct = (value: number | undefined): string =>
    value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`;
  process.stdout.write(
    `precision ${pct(totals.precision)} | recall ${pct(totals.recall)} | hallucinated citations ${String(totals.hallucinatedCitations)} | tool calls/review ${totals.avgToolCalls.toFixed(1)} | cost/review $${totals.costPerReviewUsd.toFixed(6)}\n`,
  );
  if (totals.hallucinatedCitations > 0) process.exitCode = 1;
  if (!values['no-report']) {
    const outDir = values.out ? resolve(values.out) : join(REPO_ROOT, 'docs/evals/reviewer');
    await mkdir(outDir, { recursive: true });
    const file = join(outDir, reviewerReportFileName(run));
    const note =
      kind === 'fake'
        ? "> Fake provider: the **scripted reviewer**, a deterministic agent that speaks the real tool protocol through the real gateway and loop (it checks each signal with the read-only tools and submits the confirmed ones with their verbatim evidence). It measures the detectors, the protocol and the engine's checks, not clinical judgment: a Meta model is expected to add findings the detectors miss."
        : '';
    await writeFile(file, renderReviewerReport(run, note), 'utf8');
    await writeFile(
      file.replace(/\.md$/, '.json'),
      `${JSON.stringify(reviewerSidecar(run), null, 2)}\n`,
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
