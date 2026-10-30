import type {
  SimulationOrderKind,
  SimulationPersonaId,
  SimulationTaskKind,
} from '../features/value/contract.ts';

/**
 * Copy of the Value view (V1 PRD workstream B, V2 PRD outcomes): the
 * 90-day simulation with a control arm and this demo clinic's own
 * attributed numbers. Typed here so `en.ts` and `es.ts` give the same keys
 * with the same parameters. Numbers arrive already formatted.
 */
export interface ValueCopy {
  readonly title: string;
  readonly subtitle: string;
  readonly notice: string;
  readonly method: string;
  readonly loading: string;
  readonly running: (done: number, total: number) => string;
  readonly errorTitle: string;
  readonly headline: {
    readonly title: string;
    readonly control: string;
    readonly agent: string;
    readonly difference: (points: string, low: string, high: string) => string;
    readonly scope: (patients: string, seeds: number, days: number) => string;
    readonly interval: (low: string, high: string) => string;
    readonly summary: (control: string, agent: string, points: string) => string;
  };
  readonly arms: { readonly control: string; readonly agent: string };
  readonly points: (value: string) => string;
  readonly intervalLegend: string;
  readonly clinic: {
    readonly title: string;
    readonly description: string;
    readonly patientsPerMonth: string;
    readonly patientsHint: string;
    readonly price: (currency: string) => string;
    readonly priceHint: string;
    readonly invalid: string;
    readonly consultations: string;
    readonly consultationsHint: (low: string, high: string) => string;
    readonly revenue: string;
    readonly revenueHint: (low: string, high: string) => string;
    readonly orders: string;
    readonly ordersHint: (low: string, high: string) => string;
  };
  readonly tiles: {
    readonly urgent7: string;
    readonly urgent14: (agent: string, control: string) => string;
    readonly median: string;
    readonly days: (value: string) => string;
    readonly unreachable: string;
    readonly messages: string;
    readonly messagesHint: (max: number) => string;
    readonly staff: string;
    readonly staffHint: (calls: string, notices: string, phones: string) => string;
    readonly attended: string;
    readonly versus: (control: string) => string;
  };
  readonly personas: {
    readonly title: string;
    readonly description: string;
    readonly caption: string;
    readonly share: (value: string) => string;
    readonly names: Readonly<Record<SimulationPersonaId, string>>;
    readonly summaries: Readonly<Record<SimulationPersonaId, string>>;
  };
  readonly kinds: {
    readonly title: string;
    readonly description: string;
    readonly caption: string;
    readonly names: Readonly<Record<SimulationOrderKind, string>>;
  };
  readonly workload: {
    readonly title: string;
    readonly description: string;
    readonly caption: string;
    readonly perHundred: string;
    readonly tasks: Readonly<Record<SimulationTaskKind, string>>;
  };
  readonly demoClinic: {
    readonly title: string;
    readonly description: string;
    readonly booked: string;
    readonly bookedHint: (total: number) => string;
    readonly attended: string;
    readonly attendedHint: (total: number) => string;
    readonly revenue: string;
    readonly revenueHint: (price: string) => string;
    readonly empty: string;
    readonly unavailable: string;
  };
  readonly assumptions: {
    readonly title: string;
    readonly description: string;
    readonly items: readonly string[];
  };
}
