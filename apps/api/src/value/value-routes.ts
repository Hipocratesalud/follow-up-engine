import { createSimulationReportCache, type SimulationReportCache } from '@follow-up-engine/runtime';
import { z } from 'zod';
import type { App } from '../http/context.ts';
import { readQuery } from '../http/errors.ts';

/**
 * `GET /api/inbox/value/simulation` (V1 PRD workstream B, V2 PRD outcomes):
 * the 90-day outcome simulation of the order agent against fixed reminders
 * (docs/simulation.md). Synthetic patients and stated assumptions, the same
 * for every clinic: no clinic data is read. The default parameters come
 * from the shipped snapshot at once; another size is computed once in the
 * background (202 with the progress until it is ready, then cached).
 * Patients per month and the consultation price are scaling inputs the
 * inbox applies itself.
 */
export const ValueSimulationQuerySchema = z.object({
  patientsPerArm: z.coerce.number().int().min(50).max(400).optional(),
  seeds: z.coerce.number().int().min(1).max(20).optional(),
});

export function registerValueRoutes(
  app: App,
  cache: SimulationReportCache = createSimulationReportCache(),
): void {
  app.get('/api/inbox/value/simulation', (c) => {
    const query = readQuery(c, ValueSimulationQuerySchema);
    const state = cache.get({
      ...(query.patientsPerArm === undefined ? {} : { patientsPerArm: query.patientsPerArm }),
      ...(query.seeds === undefined ? {} : { seeds: query.seeds }),
    });
    switch (state.status) {
      case 'ready':
        return c.json(state.report);
      case 'running':
        return c.json({ status: 'running', seedsDone: state.seedsDone, seeds: state.seeds }, 202);
      case 'failed':
        return c.json({ status: 'failed', error: state.error }, 500);
    }
  });
}
