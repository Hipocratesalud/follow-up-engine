import type { DismissReason, EscalationView, FeedbackReason } from '../api/contract.ts';
import type { Messages } from '../i18n/index.ts';

/**
 * Labels that need a little logic on top of the catalogs (`src/i18n`). Each
 * takes the catalog of the active locale (`useT()` in a component,
 * `messagesFor(locale)` in the mock API), so it never holds copy itself.
 */

/** The specialties of the synthetic clinic (codes the engine's cadence and rules use). */
export const SPECIALTIES = [
  'diabetology',
  'internal_medicine',
  'psychology',
  'gynecology',
] as const;
export type SpecialtyCode = (typeof SPECIALTIES)[number];

/**
 * "Escalation: step 2 of 5, raised priority": how far the case went along
 * its escalation policy (step labels come from the API). The last step is
 * named only when the API says it ran (case detail); a list view does not
 * know whether a passed step was skipped, so it gives the count only.
 */
export function escalationSummary(t: Messages, escalation: EscalationView): string {
  const total = escalation.steps.length;
  const passed = Math.min(escalation.currentStep, total);
  if (passed === 0) return t.labels.escalationNone(total);
  const summary = t.labels.escalationStep(passed, total);
  const lastDone = escalation.steps
    .slice(0, passed)
    .filter((step) => step.outcome === 'done')
    .at(-1);
  return lastDone ? `${summary}, ${lastDone.label.toLowerCase()}` : summary;
}

/** "Next: escalate to coordination, Feb 12, 2026" (empty when nothing is scheduled). */
export function escalationNext(
  t: Messages,
  escalation: EscalationView,
  formatDate: (iso: string) => string,
): string {
  return escalation.next
    ? t.labels.escalationNext(escalation.next.label.toLowerCase(), formatDate(escalation.next.at))
    : '';
}

/** Display name of the model the API reports ("muse-spark-1.3" → "Muse Spark"): a brand, never translated. */
export function modelDisplayName(model: string): string {
  if (/muse[-_ ]?spark[-_ ]?open/i.test(model)) return 'Muse Spark Open';
  if (/muse[-_ ]?spark/i.test(model)) return 'Muse Spark';
  return model;
}

/** Vendor names (brands); the OpenAI-compatible endpoint is described in the catalog. */
const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  meta: 'Meta',
  baseten: 'Baseten',
};

/** Who reads the notes, as the API reports it (`llm.provider` / `llm.model` of the stats). */
export interface NoteReader {
  /** No model at all: the fake provider's rule-based reading (demos, tests). */
  readonly simulated: boolean;
  /** "Muse Spark · Meta", or "Simulated reading (no model)". */
  readonly label: string;
  /** Short name for sentences: "Muse Spark", or "the simulated reading". */
  readonly name: string;
}

export function noteReader(
  t: Messages,
  llm: { provider: string; model: string } | undefined,
): NoteReader {
  if (llm === undefined) {
    return { simulated: false, label: t.labels.reader.generic, name: t.labels.reader.genericName };
  }
  if (llm.provider === 'fake') {
    return {
      simulated: true,
      label: t.labels.reader.simulated,
      name: t.labels.reader.simulatedName,
    };
  }
  const name = modelDisplayName(llm.model);
  const provider =
    llm.provider === 'openai-compatible'
      ? t.labels.reader.openAiCompatible
      : (PROVIDER_NAMES[llm.provider] ?? llm.provider);
  return { simulated: false, label: `${name} · ${provider}`, name };
}

/** Label of an actor in the timeline. */
export function actorLabel(
  t: Messages,
  actor: { type: 'rule' | 'user' | 'patient' | 'system' | 'adjudicator'; id?: string },
): string {
  switch (actor.type) {
    case 'adjudicator':
      return t.labels.actors.adjudicator;
    case 'rule':
      return t.labels.actors.rule;
    case 'system':
      return t.labels.actors.system;
    case 'patient':
      return t.labels.actors.patient;
    case 'user':
      // `inbox-user` is the API's default when the host sends no user.
      return actor.id === undefined || actor.id === 'inbox-user' ? t.labels.actors.team : actor.id;
  }
}

/** Label of a verdict reason: a feedback reason, or the reason a dismissal recorded. */
export function verdictReasonLabel(t: Messages, reason: FeedbackReason | DismissReason): string {
  return reason in t.labels.feedbackReasons
    ? t.labels.feedbackReasons[reason as FeedbackReason]
    : t.labels.dismissReasons[reason as DismissReason];
}
