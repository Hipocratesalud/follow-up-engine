import type { MetricsDismissReason, OriginKey } from '../features/metrics/contract.ts';

/** The four period presets of the Metrics view, in days. */
export type MetricsPreset = 7 | 30 | 90 | 365;

/**
 * Copy of the Metrics view and of the rule-version line on a case reason
 * (HIP-141). Typed here so `en.ts` and `es.ts` give the same keys with the
 * same parameters.
 */
export interface MetricsCopy {
  readonly title: string;
  readonly subtitle: string;
  readonly periodLegend: string;
  readonly preset: (days: MetricsPreset) => string;
  readonly periodRange: (from: string, to: string) => string;
  readonly loading: string;
  readonly errorTitle: string;
  readonly empty: { readonly title: string; readonly body: string };
  readonly tiles: {
    readonly opened: string;
    readonly openedHint: (live: number, backfill: number) => string;
    readonly booked: string;
    readonly bookedHint: (rate: string) => string;
    readonly attended: string;
    readonly attendedHint: (rate: string) => string;
    readonly firstAction: string;
    readonly firstActionHint: (measured: number, pending: number) => string;
    readonly useful: string;
    readonly usefulHint: (count: number) => string;
    readonly costPerCase: string;
    readonly costPerCaseHint: (total: string) => string;
    readonly lost: string;
    readonly lostHint: (dismissed: number) => string;
    readonly recovered: string;
    readonly recoveredHint: (cases: number) => string;
    readonly none: string;
  };
  readonly funnel: {
    readonly title: string;
    readonly description: string;
    readonly opened: string;
    readonly booked: string;
    readonly attended: string;
    readonly resolvedByBooking: string;
    readonly byOrigin: string;
    readonly origin: Readonly<Record<OriginKey, string>>;
    readonly summary: (stage: string, total: number, parts: string) => string;
  };
  readonly timing: {
    readonly title: string;
    readonly description: string;
    readonly median: string;
    readonly p75: string;
    readonly p90: string;
    readonly none: string;
    readonly summary: (median: string, p75: string, p90: string) => string;
  };
  readonly dismissals: {
    readonly title: string;
    readonly description: (total: number) => string;
    readonly none: string;
    readonly reasons: Readonly<Record<MetricsDismissReason, string>>;
  };
  readonly extraction: {
    readonly title: string;
    readonly description: string;
    readonly conditions: string;
    readonly confirmed: string;
    readonly rejected: string;
    readonly pending: string;
    readonly legend: (label: string, count: number) => string;
    readonly corrections: (rate: string) => string;
    readonly planItems: string;
    readonly planItemsNone: string;
    readonly planItemsCounts: (confirmed: number, corrected: number, rejected: number) => string;
  };
  readonly ai: {
    readonly title: string;
    readonly description: string;
    readonly tasks: Readonly<Record<string, string>>;
    readonly calls: (count: number) => string;
    readonly tokens: (count: string) => string;
    readonly perReviewRun: (cost: string, runs: number) => string;
    readonly attributed: (cost: string, cases: number) => string;
    readonly none: string;
  };
  readonly ruleVersion: {
    readonly rule: string;
    readonly protocol: string;
    readonly version: (version: string) => string;
  };
  readonly hours: (hours: number) => string;
}
