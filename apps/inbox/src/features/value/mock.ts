import type { SimulationReportView } from './contract.ts';
import snapshot from './simulation-snapshot.json' with { type: 'json' };

/**
 * What the in-browser mock answers for `GET /api/inbox/value/simulation`:
 * the very report the API serves (the CLI writes both copies, a test keeps
 * them equal), so the offline inbox shows the real simulation numbers.
 */
export function mockValueSimulation(): SimulationReportView {
  return snapshot as unknown as SimulationReportView;
}
