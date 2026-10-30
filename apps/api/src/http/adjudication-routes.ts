import {
  type Adjudication,
  type CaseId,
  NotFoundError,
  patientId as toPatientId,
} from '@follow-up-engine/core';
import type { EngineRuntime } from '@follow-up-engine/runtime';
import type { ApiMessages } from '../i18n/index.ts';
import { adjudicationDecisionLabel } from '../inbox/labels.ts';
import {
  AdjudicationListQuerySchema,
  AdjudicationOverrideRequestSchema,
  type AdjudicationView,
} from './adjudication-schemas.ts';
import type { App } from './context.ts';
import { HttpError, notFound, readJson, readQuery } from './errors.ts';
import { actorId } from './security.ts';

/** A decision as the inbox shows it, in the request's language. */
export function adjudicationView(t: ApiMessages, adjudication: Adjudication): AdjudicationView {
  const spanish = t.intlLocale.toLowerCase().startsWith('es');
  return {
    id: adjudication.id,
    expectationId: adjudication.expectationId,
    patientId: adjudication.patientId,
    ...(adjudication.caseId === undefined ? {} : { caseId: adjudication.caseId }),
    decision: adjudication.decision,
    decisionLabel: adjudicationDecisionLabel(t, adjudication.decision),
    modelDecision: adjudication.modelDecision,
    probability: adjudication.probability,
    reasons: adjudication.reasonCodes.map((code) => ({
      code,
      label: t.adjudication.reasons[code],
    })),
    rationale: spanish ? adjudication.rationale.es : adjudication.rationale.en,
    quotes: adjudication.quotes.map((quote) => ({
      quote: quote.quote,
      sourceDocumentId: quote.sourceDocumentId,
    })),
    inputConfidence: adjudication.inputConfidence,
    mode: adjudication.mode,
    applied: adjudication.applied,
    provider: adjudication.provider,
    model: adjudication.model,
    promptVersion: adjudication.promptVersion,
    costUsd: adjudication.costUsd,
    createdAt: adjudication.createdAt.toISOString(),
    ...(adjudication.override === undefined
      ? {}
      : {
          override: {
            decision: adjudication.override.decision,
            decisionLabel: adjudicationDecisionLabel(t, adjudication.override.decision),
            by: adjudication.override.userId,
            at: adjudication.override.at.toISOString(),
            ...(adjudication.override.note === undefined
              ? {}
              : { note: adjudication.override.note }),
          },
        }),
  };
}

/**
 * The adjudicator's inbox endpoints (PRD V2, docs/adjudicator.md): the
 * decisions on a clinic's ambiguous plan items (by case or patient) and the
 * doctor's override. Decisions are for the clinical team only; nothing here
 * is sent to the patient or the host.
 */
export function registerAdjudicationRoutes(app: App, runtime: EngineRuntime): void {
  app.get('/api/inbox/adjudications', async (c) => {
    const query = readQuery(c, AdjudicationListQuerySchema);
    const clinicId = c.var.clinicId;
    const t = c.var.t;
    const items =
      query.caseId === undefined
        ? await runtime.adjudicator.list(clinicId, {
            ...(query.patientId === undefined ? {} : { patientId: toPatientId(query.patientId) }),
            ...(query.decision === undefined ? {} : { decisions: [query.decision] }),
            limit: query.limit,
          })
        : await runtime.adjudicator
            .forCase(clinicId, query.caseId as CaseId)
            .catch((error: unknown) => {
              throw error instanceof NotFoundError ? notFound(t) : error;
            });
    const settings = await runtime.adjudicator.settings(clinicId);
    return c.json({
      items: items
        .filter((item) => query.decision === undefined || item.decision === query.decision)
        .slice(0, query.limit)
        .map((item) => adjudicationView(t, item)),
      settings: {
        mode: settings.mode,
        minConfidence: settings.minConfidence,
        maxConfidence: settings.maxConfidence,
      },
    });
  });

  app.post('/api/inbox/adjudications/:id/override', async (c) => {
    const body = await readJson(c, AdjudicationOverrideRequestSchema);
    const id = c.req.param('id');
    const t = c.var.t;
    const current = await runtime.adjudicator.get(c.var.clinicId, id);
    if (current === undefined) throw notFound(t, t.adjudication.notFound);
    if (current.override !== undefined) {
      throw new HttpError(409, 'conflict', t.adjudication.alreadyOverridden);
    }
    const result = await runtime.adjudicator.override(c.var.clinicId, id, {
      decision: body.decision,
      userId: actorId(c),
      ...(body.note === undefined || body.note === '' ? {} : { note: body.note }),
    });
    c.var.log.info(
      { adjudicationId: id, decision: current.decision, override: body.decision },
      'adjudication overridden',
    );
    return c.json({
      adjudication: adjudicationView(t, result.adjudication),
      casesResolved: [...result.casesResolved],
    });
  });
}
