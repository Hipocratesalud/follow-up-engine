import { type Clock, SystemClock } from '@follow-up-engine/core';

/**
 * Composition root of the api. Adapters are chosen here, and only here,
 * from configuration; the core never knows which ones are in use.
 */
export interface ApiDependencies {
  readonly clock: Clock;
}

export function createApiDependencies(): ApiDependencies {
  return { clock: new SystemClock() };
}
