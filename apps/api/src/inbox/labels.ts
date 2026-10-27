import type {
  AppointmentOriginType,
  CaseEvent,
  CaseResolutionKind,
  CaseStatus,
  ContactChannel,
  ContactOutcome,
  ContactSkipReason,
  DismissReason,
  EscalationAction,
  JsonValue,
  PlanItemKind,
} from '@follow-up-engine/core';
import type { ApiMessages } from '../i18n/index.ts';

/*
 * Labels the API composes for the clinic inbox, in the request's language:
 * every word comes from the message catalog (`src/i18n`), this file only
 * puts them together (timeline lines, plan items, escalation steps).
 */

const UNCODED_PLAN_KEYS: Readonly<Record<string, PlanItemKind>> = {
  visit: 'follow_up_visit',
  session: 'session',
  lab: 'lab',
  imaging: 'imaging',
  other: 'other',
};

/**
 * Label of a doctor's-plan expectation from what it waits for (its match
 * key: `visit`, `session`, or a test code such as `loinc:4548-4`), so two
 * items of the same plan read differently ("Follow-up visit in the plan",
 * "Test in the plan: Lipid panel").
 */
export function planItemLabel(
  t: ApiMessages,
  matchKey: string,
  testName: (code: string) => string | undefined,
): string {
  const kind = UNCODED_PLAN_KEYS[matchKey];
  if (kind !== undefined) {
    return t.planItems[kind];
  }
  const code =
    matchKey
      .slice(matchKey.indexOf(':') + 1)
      .split('|')
      .at(-1) ?? '';
  const name = testName(code);
  return name === undefined ? t.planTest : t.planTestNamed(name);
}

/** How the patient is contacted; an attempt without a channel goes by the clinic's own system. */
export function channelLabel(t: ApiMessages, channel: ContactChannel | undefined): string {
  return channel === undefined ? t.hostChannel : t.channels[channel];
}

/** The reason an expectation closed, or `undefined` for a code without copy. */
export function closedReasonLabel(t: ApiMessages, reason: string | undefined): string | undefined {
  return reason === undefined ? undefined : t.closedReasons[reason];
}

/** A step's label, naming the channel of a contact attempt ("Patient contact request: WhatsApp"). */
export function escalationStepLabel(
  t: ApiMessages,
  step: {
    readonly action: EscalationAction;
    readonly channel?: ContactChannel | undefined;
  },
): string {
  if (step.action !== 'request_patient_contact' || step.channel === undefined) {
    return t.escalationSteps[step.action];
  }
  return step.channel === 'phone_call'
    ? t.phoneCallStep
    : t.stepWithChannel(t.escalationSteps[step.action], t.channels[step.channel]);
}

function isCaseStatus(t: ApiMessages, value: string): value is CaseStatus {
  return value in t.transitions.statusPhrases;
}

/**
 * The answer to an action the case's status does not allow, for example
 * "You cannot dismiss this case: it is already resolved." `verb` overrides
 * the one derived from the target status ("request contact for").
 */
export function invalidTransitionMessage(
  t: ApiMessages,
  from: string,
  to: string,
  verb?: string,
): string {
  const { transitions } = t;
  const action = verb ?? (isCaseStatus(t, to) ? transitions.verbs[to] : transitions.changeVerb);
  const state = isCaseStatus(t, from) ? transitions.statusPhrases[from] : transitions.changedState;
  return transitions.cannot(action, state);
}

function text(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function longDay(t: ApiMessages, iso: string | undefined): string {
  if (iso === undefined) {
    return '';
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString(t.intlLocale, { day: 'numeric', month: 'long', timeZone: 'UTC' });
}

/** The internal note a clinic user wrote with an action, if any. */
export function eventNote(event: CaseEvent): string | undefined {
  const note = text(event.payload['note'])?.trim();
  return note === undefined || note === '' ? undefined : note;
}

/**
 * Label of a case timeline entry. `reasonLabel` resolves the reason of an
 * event (its expectation id and rule id, from the payload) to the same label
 * the reason card shows; `personName` an owner id to a display name.
 */
/** The origin of a booking on the case trail (HIP-141); anything else is organic. */
function bookingOrigin(value: unknown): AppointmentOriginType {
  return value === 'follow_up_case' || value === 'patient_contact' ? value : 'organic';
}

export function timelineLabel(
  t: ApiMessages,
  event: CaseEvent,
  reasonLabel: (reason: { expectationId?: string; ruleId?: string }) => string,
  personName: (id: string | undefined) => string,
): string {
  const { payload } = event;
  const line = t.timeline;
  const reason = (): string => {
    const expectationId = text(payload['expectationId']);
    const ruleId = text(payload['ruleId']);
    return reasonLabel({
      ...(expectationId === undefined ? {} : { expectationId }),
      ...(ruleId === undefined ? {} : { ruleId }),
    });
  };
  switch (event.type) {
    case 'opened':
      return line.opened(reason());
    case 'reason_added':
      return line.reasonAdded(reason());
    case 'released':
      return line.released;
    case 'notified':
      return event.actor.type === 'user' ? line.notifiedByUser : line.notifiedBySystem;
    case 'assigned':
      return line.assigned(personName(text(payload['assignee'])));
    case 'snoozed': {
      const until = longDay(t, text(payload['until']));
      return until === '' ? line.snoozed : line.snoozedUntil(until);
    }
    case 'escalated': {
      const action = text(payload['action']) ?? '';
      return action in t.escalationActions
        ? t.escalationActions[action as EscalationAction]
        : line.escalated;
    }
    case 'patient_contact_requested': {
      const channel = text(payload['channel']) as ContactChannel | undefined;
      if (channel === 'phone_call') {
        return text(payload['trigger']) === 'wrong_number' ? line.callAfterWrongNumber : line.call;
      }
      return channel === undefined
        ? line.contactRequested
        : line.contactRequestedVia(t.channels[channel]);
    }
    case 'contact_attempt_skipped': {
      const why = t.contactSkips[text(payload['reason']) as ContactSkipReason] as
        string | undefined;
      return why === undefined ? line.contactSkipped : line.contactSkippedBecause(why);
    }
    case 'contact_outcome_recorded': {
      const outcome = t.outcomes[text(payload['outcome']) as ContactOutcome] as string | undefined;
      const channel = text(payload['channel']) as ContactChannel | undefined;
      return line.contactOutcome(
        outcome ?? line.outcomeRecorded,
        channel === undefined ? undefined : t.channels[channel],
      );
    }
    case 'resolved': {
      const kind = text(payload['kind']) as CaseResolutionKind | undefined;
      const label = kind === undefined ? line.resolved : t.resolutions[kind];
      const closedReasons = payload['closedReasons'];
      const why = [
        ...new Set(
          (Array.isArray(closedReasons) ? closedReasons : []).flatMap((item: JsonValue) => {
            const reasonLabel = closedReasonLabel(t, text(item));
            return reasonLabel === undefined ? [] : [reasonLabel];
          }),
        ),
      ];
      return why.length === 0
        ? label
        : line.resolvedBecause(label, why.join('; ').toLocaleLowerCase(t.intlLocale));
    }
    case 'dismissed': {
      const reasonLabel = t.dismissReasons[text(payload['reason']) as DismissReason] as
        string | undefined;
      return reasonLabel === undefined
        ? line.dismissed
        : line.dismissedBecause(reasonLabel.toLocaleLowerCase(t.intlLocale));
    }
    case 'reopened':
      return line.reopened;
    case 'lost_to_follow_up':
      return line.lostToFollowUp;
    case 'feedback_recorded':
      return payload['useful'] === true ? line.useful : line.notUseful;
    case 'appointment_booked': {
      const origin = line.bookingOrigins[bookingOrigin(payload['originType'])];
      const date = longDay(t, text(payload['scheduledFor']));
      return date === ''
        ? line.appointmentBookedNoDate(origin)
        : line.appointmentBooked(date, origin);
    }
    case 'appointment_attended':
      return line.appointmentAttended;
  }
}
