import type { Clinic, ClinicId } from '@follow-up-engine/core';
import type { ApiKeyScope, Logger } from '@follow-up-engine/runtime';
import type { Hono } from 'hono';
import type { ApiLocale, ApiMessages } from '../i18n/index.ts';

/** Per-request values set by the middleware. */
export interface AppEnv {
  Variables: {
    requestId: string;
    log: Logger;
    clinic: Clinic;
    clinicId: ClinicId;
    /** What the request's API key may do. */
    scopes: readonly ApiKeyScope[];
    /**
     * The language of the labels and messages of this response: the user's
     * `Accept-Language`, else the clinic's locale, else English (ADR 0007).
     */
    locale: ApiLocale;
    /** The message catalog of {@link locale}. */
    t: ApiMessages;
    /**
     * The evaluator's own identity in the hosted demo (docs/deploy.md#evaluator-identity-and-tracking),
     * from the signed `fue_evaluator` cookie: validated, lowercased email.
     * Set only when the access gate is configured and the cookie verifies;
     * routes that need it (the lab, the engine tests) check it themselves.
     */
    evaluatorEmail?: string;
  };
}

export type App = Hono<AppEnv>;
