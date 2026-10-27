import { type Clock, SystemClock } from '@follow-up-engine/core';

/**
 * Composition root of the worker. Adapters are chosen here, and only here,
 * from configuration; the core never knows which ones are in use.
 */
export interface WorkerDependencies {
  readonly clock: Clock;
}

export function createWorkerDependencies(): WorkerDependencies {
  return { clock: new SystemClock() };
}
