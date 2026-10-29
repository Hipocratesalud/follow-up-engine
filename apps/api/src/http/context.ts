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
     * The evaluator lab's identity (docs/deploy.md#hosted-demo): the email
     * given at the access gate, validated and lowercased, from the signed
     * `fue_evaluator` cookie. Set by {@link accessGate} before any route
     * runs; `undefined` when the hosted demo's access gate is not
     * configured (a plain API deployment has no evaluators).
     */
    evaluatorEmail?: string;
  };
}

export type App = Hono<AppEnv>;
