import type { Clinic, ClinicId } from '@follow-up-engine/core';
import type { ApiKeyScope, Logger } from '@follow-up-engine/runtime';
import type { Hono } from 'hono';

/** Per-request values set by the middleware. */
export interface AppEnv {
  Variables: {
    requestId: string;
    log: Logger;
    clinic: Clinic;
    clinicId: ClinicId;
    /** What the request's API key may do. */
    scopes: readonly ApiKeyScope[];
  };
}

export type App = Hono<AppEnv>;
