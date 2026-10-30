import type { DetailedUsage } from './usage.ts';

/** USD per one million tokens. */
export interface ModelPrice {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  /** Price of prompt tokens served from cache; defaults to the input price. */
  readonly cachedInputPerMTok?: number;
  /** Speech-to-text models: USD per minute of audio. */
  readonly audioPerMinute?: number;
  /** Where the price comes from, so a reviewer can re-check it. */
  readonly source: string;
  /** When the price was last checked against the source (ISO date). */
  readonly verifiedAt?: string;
}

/** Prices keyed by `<provider>:<model>`, falling back to `*:<model>` for the same model on any provider. */
export type PricingTable = Readonly<Record<string, ModelPrice>>;

const META_PRICING_URL = 'https://dev.meta.ai/docs/pricing-rate-limits';
const BASETEN_MUSE_URL = 'https://www.baseten.co/library/muse-spark-open/';

const MUSE_SPARK_STANDARD: ModelPrice = {
  inputPerMTok: 1.25,
  cachedInputPerMTok: 0.15,
  outputPerMTok: 4.25,
  source: META_PRICING_URL,
  verifiedAt: '2026-10-26',
};

const MUSE_SPARK_CONTRIBUTOR: ModelPrice = {
  inputPerMTok: 0.1,
  cachedInputPerMTok: 0.002,
  outputPerMTok: 0.2,
  source: META_PRICING_URL,
  verifiedAt: '2026-10-26',
};

const MUSE_SPARK_OPEN_BASETEN: ModelPrice = {
  inputPerMTok: 1.25,
  cachedInputPerMTok: 0.15,
  outputPerMTok: 4.25,
  source: BASETEN_MUSE_URL,
  verifiedAt: '2026-10-26',
};

/**
 * Default prices (standard tier, pay as you go). Re-check before quoting a
 * cost to a clinic: vendor prices change. Muse Spark "Contributor mode"
 * (`*-contributor` ids) is cheaper but lets Meta train on the data, so the
 * Meta provider refuses it unless explicitly allowed. Add a row (or pass `--price-in/--price-out` to the eval CLI)
 * to benchmark any other model.
 */
export const DEFAULT_PRICING: PricingTable = {
  'meta:muse-spark-1.3': MUSE_SPARK_STANDARD,
  'meta:muse-spark-1.2': MUSE_SPARK_STANDARD,
  // Contributor mode: Meta may train on prompts and replies. Synthetic evals only;
  // the Meta provider refuses these ids unless `allowContributorMode` is set.
  'meta:muse-spark-1.3-contributor': MUSE_SPARK_CONTRIBUTOR,
  'meta:muse-spark-1.2-contributor': MUSE_SPARK_CONTRIBUTOR,
  'meta:muse-wonder-1.0': {
    inputPerMTok: 4,
    cachedInputPerMTok: 0.2,
    outputPerMTok: 20,
    source: META_PRICING_URL,
    verifiedAt: '2026-10-26',
  },
  'baseten:meta-models/muse-spark-open': MUSE_SPARK_OPEN_BASETEN,
  // Dated snapshot id named in the hackathon brief. Not found in Baseten's
  // public docs on 2026-10-26 (they list `meta-models/muse-spark-open`);
  // verify the slug with `GET https://inference.baseten.co/v1/models`.
  'baseten:meta-models/muse-spark-open-1026': MUSE_SPARK_OPEN_BASETEN,
  'fake:fake-extractor': {
    inputPerMTok: 0,
    outputPerMTok: 0,
    source: 'Deterministic in-process fake; free.',
  },
  'meta:muse-voice-transcribe-1.0': {
    inputPerMTok: 0,
    outputPerMTok: 0,
    audioPerMinute: 0.006,
    source:
      'No per-minute price listed on dev.meta.ai on 2026-10-30: a conservative budgeting estimate (USD 0.006/min); re-check before quoting.',
    verifiedAt: '2026-10-30',
  },
  'fake:fake-order-agent': {
    inputPerMTok: 0,
    outputPerMTok: 0,
    source: 'Deterministic scripted order-to-completion agent (in-process); free.',
  },
  'fake:fake-vision': {
    inputPerMTok: 0,
    outputPerMTok: 0,
    source: 'Deterministic scripted lab photo reader (in-process); free.',
  },
  'fake:fake-transcriber': {
    inputPerMTok: 0,
    outputPerMTok: 0,
    audioPerMinute: 0,
    source: 'Deterministic scripted transcriber (in-process); free.',
  },
  'fake:fake-reviewer': {
    inputPerMTok: 0,
    outputPerMTok: 0,
    source: 'Deterministic scripted clinical reviewer (in-process); free.',
  },
};

export function priceFor(
  table: PricingTable,
  provider: string,
  model: string,
): ModelPrice | undefined {
  return table[`${provider}:${model}`] ?? table[`*:${model}`];
}

/** Cost in USD of one call. Cached prompt tokens are billed at the cached rate. */
export function costOf(price: ModelPrice, usage: DetailedUsage): number {
  const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
  const uncached = usage.inputTokens - cached;
  const cachedRate = price.cachedInputPerMTok ?? price.inputPerMTok;
  const usd =
    (uncached * price.inputPerMTok +
      cached * cachedRate +
      usage.outputTokens * price.outputPerMTok) /
    1_000_000;
  // Round to a micro-dollar so sums stay stable in reports and logs.
  return Math.round(usd * 1_000_000) / 1_000_000;
}
