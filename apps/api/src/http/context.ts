import type { Clinic, ClinicId } from '@follow-up-engine/core';
import type { Logger } from '@follow-up-engine/worker';
import type { Hono } from 'hono';

/** Per-request values set by the middleware. */
export interface AppEnv {
  Variables: {
    requestId: string;
    log: Logger;
    clinic: Clinic;
    clinicId: ClinicId;
  };
}

export type App = Hono<AppEnv>;
