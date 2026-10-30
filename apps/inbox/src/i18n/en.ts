/**
 * English UI catalog: the source of truth for every word the inbox writes.
 * `es.ts` must provide the same keys with the same parameters (a missing or
 * misnamed key is a type error). Clinical content (notes, quotes, patient
 * and drug names) never goes through a catalog: it is shown as written.
 *
 * Add a key here first, then in `es.ts`, then read it with `useT()`
 * (components) or `messages()` (code outside React).
 */
import type { MetricsCopy } from './metrics-copy.ts';
import type { ValueCopy } from './value-copy.ts';

const plurals = new Intl.PluralRules('en-US');
const numbers = new Intl.NumberFormat('en-US');

/** "1 case", "3 cases". */
function count(n: number, one: string, other: string): string {
  return `${numbers.format(n)} ${plurals.select(n) === 'one' ? one : other}`;
}

const common = {
  appName: 'Follow-up',
  clinicFallback: 'Clinic',
  yourTeam: 'Your team',
  demoSubtitle: 'Demo',
  clinicSubtitle: 'Clinic',
  skipToContent: 'Skip to content',
  mainNav: 'Main',
  retry: 'Retry',
  cancel: 'Cancel',
  gotIt: 'Got it',
  close: 'Close',
  change: 'Change',
  confirm: 'Confirm',
  newBadge: 'New',
  updatedBadge: 'Updated',
  backToInbox: 'Back to the inbox',
  goToInbox: 'Go to the inbox',
  /** Header banner, the hosted demo's evaluator lab: "Evaluating as doctor@example.com". */
  evaluatingAs: (email: string): string => `Evaluating as ${email}`,
  inboxLink: 'Inbox',
  viewPatient: 'View patient',
  noValue: '—',
  /** A short quote inline: “text”. */
  quoted: (text: string): string => `“${text}”`,
  separator: ' · ',
  useLightTheme: 'Use light theme',
  useDarkTheme: 'Use dark theme',
  language: 'Language',
  /** Each language named in itself, as a switch lists them. */
  languageNames: { en: 'English', es: 'Español' },
  /** "Preferred language: Spanish". */
  preferredLanguage: (language: string): string => `Preferred language: ${language}`,
  yes: 'Yes',
  no: 'No',
};

const nav = {
  metrics: 'Metrics',
  value: 'Value',
  inbox: 'Inbox',
  recovery: 'To recover',
  review: 'Clinical review',
  reviewShort: 'Review',
  demo: 'Demo',
  engineTests: 'Engine tests',
  lab: 'Lab',
  agent: 'Agent',
  evaluators: 'Evaluators',
  simulatedDate: 'Simulated date:',
  simulatedDateTitle: 'The API runs on a simulated clock for the demo',
};

const errors = {
  generic: 'Something went wrong. Try again.',
  network: 'We could not reach the server. Check your connection.',
  unexpected: 'The server did not answer as expected. Try again.',
  insufficientScope:
    'Your access does not allow this action. Ask whoever manages the clinic for a key with that permission.',
  rateLimited: 'Too many requests in a row. Wait a few seconds and try again.',
  payloadTooLarge: 'The text is too long. Shorten it and try again.',
  invalidCursor: 'The list changed while you were browsing it. Go back to the first page.',
  validationFallback: 'Check what you entered and try again.',
  loadFailed: 'We could not load this information',
  notFoundBody: 'The link may be wrong, or it no longer exists.',
  pageNotFound: 'This page does not exist',
  pageNotFoundBody: 'Check the address or go back to the inbox.',
};

const time = {
  dueToday: 'Due today',
  dueTodayPassed: 'Was due today',
  overdue: (days: number): string => `Overdue by ${count(days, 'day', 'days')}`,
  days: (days: number): string => count(days, 'day', 'days'),
  /** "1.2 s". */
  seconds: (value: string): string => `${value} s`,
  milliseconds: (value: string): string => `${value} ms`,
};

const labels = {
  layers: {
    universal: 'Order or result',
    doctor_plan: "Doctor's plan",
    cadence: 'Visit frequency',
    protocol: 'Protocol',
  },
  layerDescriptions: {
    universal:
      'An order (test, study, referral) with no result on record, or an abnormal result with no visit since.',
    doctor_plan: 'Something the doctor wrote in the note’s plan that has not happened.',
    cadence: 'The patient has gone longer than usual without a visit.',
    protocol: 'A check-up the protocol for their condition calls for that nobody has ordered.',
  },
  draftProtocol: 'Draft protocol · pending clinical validation',
  draftProtocolHint: 'Your clinic’s clinical team has not validated this protocol yet.',
  readyForSignoff: 'Ready for sign-off · pending clinical validation',
  readyForSignoffHint:
    'A sign-off package is ready for your clinic’s clinical team to review; nobody has approved it yet.',
  protocolPrefix: 'Protocol:',
  statuses: {
    open: 'Open',
    notified: 'Notified',
    snoozed: 'Snoozed',
    escalated: 'Escalated',
    resolved: 'Resolved',
    dismissed: 'Dismissed',
    lost_to_follow_up: 'Lost to follow-up',
  },
  priorities: { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' },
  priorityTitle: (priority: number): string => `Priority ${String(priority)} of 100`,
  priorityPrefix: 'Priority ',
  escalationNone: (total: number): string => `Escalation: no step of ${String(total)}`,
  escalationStep: (passed: number, total: number): string =>
    `Escalation: step ${String(passed)} of ${String(total)}`,
  escalationPrefix: 'Escalation: ',
  escalationNext: (step: string, date: string): string => `Next: ${step}, ${date}`,
  feedbackReasons: {
    wrong_rule: 'The rule does not apply to this patient',
    wrong_interval: 'The deadline is not right',
    bad_extraction: 'The note was misread',
    already_handled: 'It was already handled',
    other: 'Other reason',
  },
  conditionStatuses: {
    confirmed: 'Confirmed',
    probable: 'Probable',
    resolved: 'Resolved',
    rejected: 'Ruled out',
    entered_in_error: 'Entered in error',
  },
  conditionSources: {
    recorded: 'Recorded by the doctor',
    extracted_from_note: 'Read from the note by AI',
    inferred_from_medication: 'Inferred from the medication',
    inferred_from_result: 'Inferred from a result',
  } as Record<string, string>,
  expectationStatuses: {
    open: 'On time',
    fulfilled: 'Fulfilled',
    superseded: 'Superseded',
    expired: 'Overdue',
    cancelled: 'Cancelled',
  },
  planKinds: {
    follow_up_visit: 'Follow-up visit',
    lab: 'Lab test',
    imaging: 'Imaging',
    session: 'Session',
    other: 'Other',
  },
  sexes: { female: 'Female', male: 'Male', other: 'Other', unknown: 'Unknown' },
  sexShort: { female: 'F', male: 'M' },
  specialties: {
    diabetology: 'Diabetology',
    internal_medicine: 'Internal medicine',
    psychology: 'Psychology',
    gynecology: 'Gynecology and obstetrics',
  },
  reader: {
    generic: 'Note reading',
    genericName: 'the note reader',
    simulated: 'Simulated reading (no model)',
    simulatedName: 'the simulated reading',
    openAiCompatible: 'OpenAI-compatible API',
  },
  webhooks: {
    'case.opened': 'Case opened',
    'case.reason_added': 'Reason added to a case',
    'case.escalated': 'Case escalated',
    'case.patient_contact_requested': 'Contact the patient',
    'case.snoozed': 'Case snoozed',
    'case.resolved': 'Case resolved',
    'case.dismissed': 'Case dismissed',
    'case.lost_to_follow_up': 'Patient lost to follow-up',
    'consultation.processed': 'Consultation processed',
    'patient_contact.requested': 'Contact the patient',
    'contact.outcome_recorded': 'Contact outcome recorded',
    'backfill.completed': 'History review finished',
    'backfill.paused': 'History review paused',
  } as Record<string, string>,
  actors: {
    adjudicator: 'Adjudicator (AI)',
    rule: 'Automatic rule',
    system: 'Follow-up engine',
    patient: 'Patient',
    team: 'Clinic team',
  },
  hostChannel: "Clinic's channel",
  channels: { whatsapp: 'WhatsApp', phone_call: 'Phone call', sms: 'SMS', email: 'Email' },
  contactOutcomes: {
    delivered: 'Delivered',
    read: 'Read',
    replied: 'Replied',
    booked: 'Booked a visit',
    declined: 'Declined follow-up',
    treated_elsewhere: 'Treated elsewhere',
    wrong_number: 'Wrong number',
    no_answer: 'No answer',
  },
  callOutcomes: {
    booked: 'Answered and booked',
    treated_elsewhere: 'Answered, treated elsewhere',
    no_answer: 'No answer',
    wrong_number: 'Wrong number',
    declined: 'Declined follow-up',
  },
  attemptStatuses: {
    waiting: 'Waiting for a reply',
    answered: 'Replied',
    unreached: 'Could not be reached',
    unanswered: 'No reply',
    pending_call: 'Call to make',
    closed: 'Closed without a reply',
  },
  dismissReasons: {
    handled_elsewhere: 'Handled elsewhere',
    already_done: 'Already done',
    not_applicable_to_patient: 'Does not apply to this patient',
    wrong_diagnosis: 'The diagnosis is wrong',
    wrong_interval: 'The interval is wrong',
    other: 'Other reason',
  },
  contactFlag: 'Wrong number',
  sourceTypes: {
    ServiceRequest: 'Order',
    DocumentReference: 'Clinical note',
    PlanDefinition: 'Protocol',
    Encounter: 'Visit',
    MedicationRequest: 'Prescription',
    DiagnosticReport: 'Result',
    Observation: 'Result',
    Condition: 'Diagnosis',
    Appointment: 'Appointment',
    Composition: 'Clinical note',
  } as Record<string, string>,
  sourceTypeFallback: 'Clinical record',
  /** "Result — HbA1c". */
  source: (type: string, display: string): string => `${type} — ${display}`,
};

const dismiss = {
  intro:
    'Dismiss the case if no follow-up is needed. The reason also counts as your opinion on the case: that is how we tune the rule.',
  reasonLegend: 'Why are you dismissing it?',
  noteLabelRequired: 'Internal note',
  suppressLabel: 'Stop reminding about it for this patient',
  suppressHint: (patientName: string): string =>
    `The engine will not open it again for ${patientName}; other patients do not change. You can turn it back on from their record.`,
  suppressListTitle: 'Stops reminding about:',
  suppressKept: (kept: readonly string[]): string =>
    `What the doctor ordered or a result asks for stays active for the patient (${kept.join(', ')}): it is only dismissed in this case.`,
  nothingSuppressible:
    'What the doctor ordered or a result asks for cannot be turned off for the patient: only this case is dismissed.',
  wrongDiagnosisBefore: 'If the diagnosis is wrong, rule it out on the',
  wrongDiagnosisLink: 'patient’s record',
  wrongDiagnosisAfter: ': that cancels every reminder that depends on it.',
  reasonHints: {
    handled_elsewhere: 'The patient already took care of it at another center.',
    already_done: 'It happened, but the clinic’s system did not record it.',
    not_applicable_to_patient:
      'Given their situation, this reminder does not apply to this patient.',
    wrong_diagnosis: 'The case rests on a diagnosis the patient does not have.',
    wrong_interval: 'It was asked for too early or with the wrong deadline.',
    other: 'Tell us in the note why you are dismissing it.',
  },
};

const validation = {
  dismissReasonRequired: 'Choose why you are dismissing the case.',
  dismissNoteRequired: 'Tell us the reason in the note.',
  suppressOnlyNotApplicable: 'You can only stop the reminder if it does not apply to this patient.',
  nothingToSuppress:
    'This case has no reminders that can be turned off for the patient: dismiss it without that option.',
  callOutcomeRequired: 'Choose what happened on the call.',
  caseClosed: 'This case is already closed.',
  noPendingCall: 'This case has no pending call.',
  suppressionAlreadyActive: 'That reminder is already active.',
  snoozeDays: (max: number): string => `Enter a number of days between 1 and ${String(max)}.`,
  noteTooLong: (limit: string): string =>
    `The note can be up to ${limit} characters. Shorten it and try again.`,
  commentTooLong: (limit: string): string => `The comment can be up to ${limit} characters.`,
  feedbackReasonRequired: 'Choose a reason to continue: that tells us what to adjust.',
  patientRequired: 'Type the patient’s name or choose an existing one.',
  patientNameTooLong: (limit: string): string => `The name can be up to ${limit} characters.`,
  noteRequired: 'Write the consultation note (at least 20 characters) or use an example.',
  labPatientRequired: 'Pick one of your lab patients, or create a new one.',
  labDateRequired: 'Pick a date.',
  labDateInFuture: 'That date is after your lab’s current date.',
  labDateInPast: 'The lab’s date can only move forward.',
  labDocumentRequired: 'Upload a file or paste the text.',
  labFieldRequired: 'This field is required.',
};

const contact = {
  title: 'Contact with the patient',
  empty:
    'Nobody has tried to reach the patient about this case yet. The engine asks for it following the escalation policy.',
  attemptTitle: (attempt: number, channel: string): string =>
    `Attempt ${String(attempt)} · ${channel}`,
  waitsUntil: (date: string): string => `waits for an answer until ${date}`,
  answerWindow: (date: string): string => `answer window: ${date}`,
  outcomePrefix: 'Outcome:',
  senderTeam: 'the team',
  senderHost: 'clinic system',
  triggers: {
    policy: 'Following the case’s policy',
    user: 'Requested by the team',
    wrong_number: 'Moved forward by a wrong number',
  },
  flagBody: (when: string): string =>
    `${when}: the phone on record is not the patient’s. We send no more messages until the clinic’s system updates it; the team’s calls go on.`,
  callTitle: 'Call the patient',
  callOutcomesGroup: 'What happened on the call?',
  callWrongNumber: (patientName: string): string =>
    `The message reached someone else: call ${patientName} and confirm their phone number.`,
  callUnanswered: (patientName: string): string =>
    `The messages got no answer: call ${patientName} and tell us what happened.`,
  callOverdue: (date: string): string => `It was due by ${date}.`,
  callDue: (date: string): string => `Make it by ${date}.`,
  dismissalTitle: 'Why it was dismissed',
  dismissalFeedbackNote:
    'The reason counts as your opinion on the case: that is how we tune the rule.',
  suppressedTitle: 'No longer reminded for this patient',
  reactivatedSuffix: ' (turned back on)',
  dismissalPatientLink: 'View or turn back on in the patient’s record',
};

const suppressions = {
  title: 'Reminders turned off',
  intro:
    'Reminders the team marked as “Does not apply to this patient”. The engine does not open them again for this patient; they still apply to every other patient.',
  empty: 'No reminder turned off.',
  history: (n: number): string => `Turned back on (${String(n)})`,
  caseLink: 'View the dismissed case',
  reactivate: 'Turn back on',
  reactivatedBadge: 'Turned back on',
  reactivatedBy: (by: string | undefined, date: string): string =>
    `Turned back on${by ? ` by ${by}` : ''} on ${date}`,
  reactivatedDone: 'Done: the engine reminds about it again for this patient.',
};

const stats = {
  loading: 'Loading summary',
  error: 'We could not load the summary',
  region: 'Summary',
  activeCases: 'Active cases',
  /** HIP-141: the inbox counts patients first (one card each), their cases second. */
  activePatients: 'Patients with active cases',
  cases: (n: number): string => count(n, 'case', 'cases'),
  escalated: (n: number): string => count(n, 'escalated', 'escalated'),
  snoozed: (n: number): string => count(n, 'snoozed', 'snoozed'),
  byLayer: 'By layer',
  usefulness: 'Usefulness according to the team',
  noFeedback: 'No rated cases yet',
  usefulOf: (n: number): string => `useful, out of ${count(n, 'rated case', 'rated cases')}`,
  readingCost: 'Reading cost this month',
  aiCost: 'AI cost this month',
  notesRead: (n: number): string => count(n, 'note read', 'notes read'),
  perNote: (cost: string): string => `${cost} per note`,
};

const evidence = {
  title: 'Verbatim quote from the note',
  readBy: (name: string): string => `Read by ${name}`,
  noteOf: (date: string): string => `note of ${date}`,
};

const caseActions = {
  notifyTitle: 'Ask to contact the patient',
  notifyConfirm: 'Ask for contact',
  notifyDone: 'Done: we asked the clinic’s system to contact the patient.',
  snoozeTitle: 'Snooze the case',
  snoozeConfirm: 'Snooze',
  snoozeDone: 'Case snoozed.',
  resolveTitle: 'Resolve the case',
  resolveConfirm: 'Resolve case',
  resolveDone: 'Case resolved.',
  dismissTitle: 'Dismiss the case',
  dismissConfirm: 'Dismiss case',
  dismissDone: 'Case dismissed.',
  notify: 'Ask for contact',
  snooze: 'Snooze',
  resolve: 'Resolve',
  dismiss: 'Dismiss',
  /** The generic message the patient receives: no diagnosis, result or test name. */
  patientMessage: (firstName: string): string =>
    `Hi ${firstName}. You have a pending check-up with your care team. Reply to this message to book your visit.`,
  noMessages: (patientName: string): string =>
    `${patientName} does not accept messages from the clinic. Reach them another way and then resolve the case.`,
  notifyBody: (patientName: string): string =>
    `We will send a notice to the clinic’s system so it contacts ${patientName} through their usual channel.`,
  messagePreview: 'Message the patient will receive',
  messagePrivacy: 'No diagnoses, results or test names.',
  snoozeFor: 'Snooze for',
  snoozeOther: 'Other period (days)',
  snoozeBack: (date: string): string => `It comes back to the inbox on ${date}.`,
  snoozePlaceholder: 'For example, 10',
  noteOptional: 'Internal note (optional)',
  noteHint: (limit: string): string => `Only the team sees it. Up to ${limit} characters.`,
  resolvePlaceholder: 'For example: they brought the result, it is already on file',
};

const caseDetail = {
  dueBefore: (date: string): string => `Was due by ${date}`,
  origin: (source: string): string => `Source: ${source}`,
  internalNote: 'Internal note: ',
  stepSkipped: 'Did not apply to this case',
  stepDoneOn: (date: string): string => `Done on ${date}`,
  stepDone: 'Done',
  stepScheduled: (date: string): string => `Scheduled for ${date}`,
  stepPlanned: (date: string): string => `Planned for ${date} if nobody acts`,
  stepNeverRan: 'Never ran: the case closed first',
  stepOnEntry: 'When the case enters the inbox',
  stepAfterDays: (days: number): string =>
    `${count(days, 'day', 'days')} without an answer, following the policy`,
  noMessages: 'Does not accept messages',
  contactNotAllowed: 'Contact not allowed',
  contactAllowed: 'Contact allowed',
  lastContact: (when: string): string => `Last contact ${when}`,
  noContacts: 'No contacts on record',
  owner: (name: string): string => `Owner: ${name}`,
  recovered: 'Recovered from history',
  openedAgo: (when: string): string => `Opened ${when}`,
  suggestedStep: 'Suggested next step',
  snoozedUntil: (date: string): string => `Snoozed until ${date}`,
  closedNotice: (status: string): string =>
    `This case is closed (${status}). If the patient has something pending again, the engine opens a new case.`,
  reasons: 'Reasons',
  quotesNote: 'Highlighted quotes are verbatim text from the doctor’s note, not a paraphrase.',
  escalation: 'Escalation',
  escalationIntro:
    'What the engine does if nobody answers, following this case’s policy. Asking for contact or snoozing the case restarts the wait.',
  escalationSnoozed: (date: string): string =>
    `Snoozed until ${date}: meanwhile it does not move, and each step’s wait counts from that day.`,
  feedbackTitle: 'Was this case useful?',
  history: 'Case history',
  loading: 'Loading case',
  error: 'We could not load the case',
  notFound: 'We could not find that case',
  standaloneTitle: 'Case details',
};

const feedback = {
  useful: 'Useful',
  notUseful: 'Not useful',
  markedUseful: 'You marked this case as useful.',
  markedNotUseful: 'You marked this case as not useful',
  reasonSuffix: (reason: string): string => `: ${reason}.`,
  whyNot: 'Why was it not useful?',
  comment: 'Comment (optional)',
  send: 'Send comment',
};

const inbox = {
  title: 'Follow-up inbox',
  intro:
    'Patients with something pending, sorted by priority. Each card gathers every reason of one patient; act on each of their cases inside it.',
  /** Evaluator lab hint, shown only to an identified evaluator (docs/deploy.md#hosted-demo). */
  tryYourOwnDocuments: 'To try your own documents, go to',
  views: { active: 'Active', closed: 'Closed', all: 'All' },
  viewGroup: 'Case status',
  empty: {
    active: {
      title: 'No active cases',
      body: 'Every patient’s follow-up is up to date. New cases show up here as soon as an expectation is overdue.',
    },
    closed: { title: 'No closed cases yet', body: 'Resolved or dismissed cases show up here.' },
    all: { title: 'No cases yet', body: 'Cases show up when an expectation is overdue and unmet.' },
  },
  noResults: 'No results',
  noMatches: (search: string): string => `No patients matching “${search}” in this view.`,
  noOwnerCases: (owner: string): string => `No patients with cases of ${owner} in this view.`,
  thisOwner: 'this owner',
  cases: 'Cases',
  patients: 'Patients',
  searchLabel: 'Search patient',
  searchPlaceholder: 'Search patient by name',
  clearSearch: 'Clear search',
  ownerLabel: 'Owner',
  allOwners: 'All owners',
  /** The reason-type and condition filter bar of the queue (HIP-141). */
  filters: {
    groupLabel: 'Filter the queue',
    reasonType: 'Reason type',
    condition: 'Condition',
    clear: 'Clear filters',
    title: 'No matches',
    body: 'No patients match these filters in this view.',
  },
  loading: 'Loading patients',
  error: 'We could not load the patients',
  showing: (shown: number, total: number): string =>
    `Showing ${String(shown)} of ${count(total, 'case', 'cases')}`,
  /** The patient queue (HIP-141): patients first, their cases second. */
  showingPatients: (shown: number, total: number, cases: number): string =>
    `Showing ${String(shown)} of ${count(total, 'patient', 'patients')} · ${count(cases, 'case', 'cases')}`,
  loadMore: 'Load more patients',
  selectTitle: 'Choose a patient from the list',
  selectBody:
    'You will see every case of the patient, the quoted evidence from the note and the suggested next step.',
};

/** The patient card of the inbox (HIP-141): one patient, every case. */
const patientCard = {
  cases: (n: number): string => count(n, 'case', 'cases'),
  activeCases: (n: number): string => count(n, 'active case', 'active cases'),
  reasons: (n: number): string => count(n, 'reason', 'reasons'),
  owners: (names: string): string => `Owner: ${names}`,
  contactAllowed: 'Contact allowed',
  contactNotAllowed: 'Contact not allowed',
  optedOut: 'Does not accept messages',
  lastContact: (when: string): string => `Last contact ${when}`,
  noContacts: 'No contacts recorded',
  requestContact: 'Request contact',
  requestHint: 'One request covers every case of the patient: at most one message every 14 days.',
  requestTitle: 'Request contact with the patient',
  requestBody: (name: string, cases: number): string =>
    `We will ask the clinic’s system to contact ${name} through their usual channel, once for their ${count(cases, 'case', 'cases')}.`,
  blocked: (name: string): string =>
    `${name} does not accept messages from the clinic. Reach them another way, then resolve the cases.`,
  done: 'Done: the clinic’s system will contact the patient, once for all their cases.',
  casesTitle: 'Cases',
  closedTitle: 'Closed cases',
  loading: 'Loading patient',
  error: 'We could not load the patient',
  caseError: 'We could not load this case',
};

/** One-click review of a plan item the AI read (HIP-141). */
const planReview = {
  reading: 'AI reading',
  question: 'Read by the AI from the note. Is it what the doctor asked for?',
  pending: 'Not reviewed yet',
  confirmedBy: (who: string): string => `Confirmed by ${who}`,
  confirmed: 'Confirmed',
  correctedBy: (who: string): string => `Corrected by ${who}`,
  correctedShort: 'Corrected',
  superseded: 'Corrected: replaced by the clinician’s correction',
  rejected: 'Rejected: the note did not ask for it',
  confirm: 'Confirm',
  correct: 'Correct',
  reject: 'Reject',
  confirmedDone: 'Plan item confirmed.',
  correctedDone: 'Plan item corrected.',
  rejectedDone: 'Plan item rejected.',
  correctTitle: 'Correct the plan item',
  correctBody:
    'Change what the note asked for. The correction keeps the quote as evidence; the original reading stays in the record as corrected.',
  kindLabel: 'What it asks for',
  dueDateLabel: 'Due date',
  dueDateHint: 'The clinic’s calendar day.',
  save: 'Save correction',
  nothingChanged: 'Change the due date or what it asks for to correct the item.',
  invalidDate: 'Enter a valid date.',
  rejectTitle: 'Reject the plan item',
  rejectBody:
    'The engine stops expecting it. If it was the only pending reason of its case, the case is resolved.',
  rejectConfirm: 'Reject item',
};

/** The adjudicator's decision on an ambiguous plan item (PRD V2). */
const adjudication = {
  title: 'Adjudicator',
  hint: 'The AI read this item with low confidence, so a second model checked the note.',
  decisions: {
    open: 'The note asks for it',
    discard: 'The note does not ask for it',
    needs_human: 'Needs your review',
  },
  reasons: {
    explicit_instruction: 'Explicit instruction',
    timing_explicit: 'Timing written next to it',
    timing_vague: 'Vague timing',
    conditional_plan: 'Only if something happens',
    hypothetical_mention: 'Mentioned as a possibility',
    already_done: 'Already done',
    negated: 'Not needed',
    patient_declined: 'The patient declined',
    deferred_to_other_provider: 'Another provider takes care of it',
    contradictory_signals: 'Contradictory',
    insufficient_context: 'Not enough context',
    no_verifiable_quote: 'No quote found in the note',
    low_probability: 'Too uncertain',
  },
  probability: (percent: string): string => `${percent} likely a real follow-up`,
  shadow: 'Shadow mode',
  shadowHint: 'Recorded only: nothing was changed.',
  applied: 'Suppressed by the adjudicator',
  quotesLabel: 'From the note',
  rationaleLabel: 'Why',
  keep: 'Keep it',
  discard: 'Discard',
  overriddenKeep: (date: string): string => `You kept it (${date})`,
  overriddenDiscard: (date: string): string => `You discarded it (${date})`,
  keptDone: 'Kept and confirmed.',
  discardedDone: 'Discarded.',
  discardTitle: 'Discard this plan item',
  discardBody:
    'The engine stops expecting it. If it was the only pending reason of its case, the case is resolved.',
  discardConfirm: 'Discard item',
  model: (model: string): string => `Model: ${model}`,
};

const caseRow = {
  age: (years: number): string => `${String(years)} y`,
  moreReasons: (n: number): string => `+${count(n, 'reason', 'reasons')}`,
  releaseNever: 'Does not enter the inbox on its own (very old pending item)',
  releaseToday: (date: string): string => `Enters the inbox today (${date})`,
  releaseTomorrow: (date: string): string => `Enters the inbox tomorrow (${date})`,
  releaseOn: (date: string): string => `Enters the inbox on ${date}`,
};

const patient = {
  confidence: 'Confidence',
  confidenceValue: (percent: string): string => `${percent} confidence`,
  icd10: (code: string): string => `ICD-10 ${code}`,
  readFromNoteSimulated: 'Read from the note (simulated reading)',
  rejectedBy: { host: 'Ruled out by the clinic’s system', clinician: 'Ruled out by the team' },
  evidence: 'Evidence:',
  reviewPrompt:
    'Is it right? If you confirm it, its protocol check-ups stand; if you rule it out, they are cancelled.',
  confirm: 'Confirm',
  reject: 'Rule out',
  deadline: (date: string): string => `Deadline: ${date}`,
  closedReason: (reason: string): string => `Why it closed: ${reason}`,
  back: 'Inbox',
  age: (years: number): string => count(years, 'year old', 'years old'),
  noDemographics: 'No age or sex on record',
  noMessages: 'Does not accept messages',
  contactAllowed: 'Contact allowed',
  lastContact: (when: string): string => `Last contact ${when}`,
  noContacts: 'No contacts on record',
  conditions: 'Conditions',
  probableOne:
    'There is one probable condition read from the notes. Review it: until you confirm it, nobody contacts the patient about it.',
  probableMany: (n: number): string =>
    `There are ${String(n)} probable conditions read from the notes. Review them: until you confirm them, nobody contacts the patient about them.`,
  noConditions: 'No conditions on record.',
  ruledOut: (n: number): string => `Ruled out (${String(n)})`,
  openExpectations: 'Open expectations',
  nothingPending: 'Nothing pending.',
  closedExpectations: 'Closed expectations',
  noClosed: 'No closed expectations yet.',
  quality: 'Documentation quality',
  qualityOk: 'This patient’s notes have a follow-up plan.',
  truncated: (date: string): string =>
    `The note of ${date} is longer than what is read: its beginning and end were read, not the middle. Check the note in case the plan asks for more.`,
  noPlan: (date: string): string =>
    `The note of ${date} does not say when the patient should come back. Without a plan, follow-up relies on the specialty’s usual frequency.`,
  loading: 'Loading patient',
  error: 'We could not load the patient',
  notFound: 'We could not find that patient',
};

const recovery = {
  title: 'Patients to recover',
  intro: 'Patients who lost their follow-up before the clinic used the engine.',
  noticeTitle: 'These are not notifications.',
  noticeBody:
    'They came from reviewing the clinic’s history. Nobody gets alerts about them yet: they enter the inbox little by little, by priority and with a daily cap per owner, so the team can handle them without being swamped.',
  loading: 'Loading patients',
  error: 'We could not load the list',
  emptyTitle: 'No patients left to recover',
  emptyBody: 'Every patient from the history is already in the inbox.',
  waiting: (n: number): string => `${count(n, 'patient', 'patients')} waiting, by priority`,
};

const demo = {
  daysButton: (days: number): string => `+${count(days, 'day', 'days')}`,
  releasedNone: (left: number): string =>
    `No patient from “To recover” entered the inbox (${String(left)} left).`,
  released: (released: number, left: number): string =>
    `${count(released, 'patient', 'patients')} from “To recover” entered the inbox (${
      left === 0 ? 'none left' : `${String(left)} left`
    }).`,
  simulatedDate: 'Simulated date',
  advance: 'Move time forward',
  passed: (days: number): string => `${count(days, 'day', 'days')} passed`,
  engineRan: '. The engine checked the deadlines and escalated the unanswered cases',
  activeCases: ': active cases',
  viewInbox: 'View the inbox',
  clockHint:
    'Each jump runs what the engine would do as the days go by: expectations fall due, cases open or merge, and they escalate.',
  evaluatorAdvanceDisabled:
    'As an evaluator, you move your own lab’s clock instead of the shared demo’s: it never changes what another evaluator sees.',
  goToLab: 'Go to the Lab',
  signatureValid: 'Valid signature',
  signatureInvalid: 'Invalid signature',
  delivered: 'Delivered',
  pendingDelivery: 'Pending delivery',
  viewContent: 'View content',
  webhookContent: (type: string): string => `Content of webhook ${type}`,
  webhookFilters: {
    all: 'All events',
    opened: 'Opened cases',
    escalated: 'Escalated cases',
    contact: 'Contact requests',
    resolved: 'Closed cases',
    backfill: 'History review',
  },
  webhooksTitle: 'Events sent to the clinic’s system',
  webhooksIntro:
    'Signed webhooks: this is how the clinic’s system learns about each case and decides how to contact the patient. The last 30 are shown.',
  eventType: 'Event type',
  loadingEvents: 'Loading events',
  eventsError: 'We could not load the events',
  noEvents: 'No events yet',
  noEventsBody: 'They show up when the engine opens, escalates or closes a case.',
  loading: 'Loading the demo',
  clockError: 'We could not read the API’s clock',
  unavailableTitle: 'Demo not available',
  unavailableBody: 'The demo panel only works when the API runs on the simulated clock.',
  title: 'Demo',
  introSimulated:
    'From consultation to case: save a note, see what the simulated reading understands, and move the clock to watch the engine open and escalate cases.',
  introModel: (name: string): string =>
    `From consultation to case: save a note, see what ${name} reads, and move the clock to watch the engine open and escalate cases.`,
};

const consultation = {
  title: 'New consultation',
  introSimulated:
    'Simulates the doctor saving a consultation in the clinic’s system. The engine receives it as FHIR and reads it with rules (simulated reading, no model).',
  introModel: (name: string): string =>
    `Simulates the doctor saving a consultation in the clinic’s system. The engine receives it as FHIR and ${name} reads the note.`,
  useExample: 'Use an example',
  patient: 'Patient',
  newPatient: 'New patient',
  specialty: 'Specialty',
  newPatientName: 'New patient’s name',
  namePlaceholder: 'First and last name (fictional)',
  note: 'Consultation note',
  noteHint: (limit: string): string =>
    `Write it the way the doctor would. Fictional data only, up to ${limit} characters.`,
  orders: 'Lab orders (optional)',
  reading: 'Reading the note…',
  save: 'Save consultation',
  examples: {
    'diabetes-plan': 'Diabetes with a plan',
    'psychology-plan': 'Psychology with sessions',
    'gynecology-no-plan': 'Gynecology without a plan',
    'english-hypertension': 'Hypertension (English note)',
  } as Record<string, string>,
  labs: {
    '4548-4': 'HbA1c',
    '57698-3': 'Lipid panel',
    '14957-5': 'Microalbuminuria',
    '2160-0': 'Serum creatinine',
    '3016-3': 'TSH',
    '58410-2': 'Complete blood count',
  } as Record<string, string>,
};

const extraction = {
  legend: { plan: 'Doctor’s plan', condition: 'Condition', medication: 'Medication' },
  annotatedNote: 'Note with the quotes marked',
  noCaseYet:
    'There is no open case for this patient yet: it opens when an expectation is overdue and unmet. Move the clock forward to see it.',
  casesOpened: (n: number): string =>
    n === 1
      ? 'The engine opened a case for this patient'
      : `The engine opened ${String(n)} cases for this patient`,
  viewCase: 'View case',
  viewCaseOf: (name: string): string => ` for ${name}`,
  readingOf: (model: string): string => `Reading by ${model}`,
  introSimulated:
    'What the demo’s rules understood from the note (no AI model read it), with the exact quote for each item.',
  introModel: 'What the model understood from the note, with the exact quote for each item.',
  noteLanguage: (language: string): string => `Note read as: ${language}`,
  noPlanTitle: 'Note without a follow-up plan.',
  noPlanBody:
    'It was recorded as a quality finding. Follow-up falls to the usual frequency and the protocol.',
  plan: 'Doctor’s plan',
  noPlanItems: 'The note gives no next steps.',
  dueConfidence: (date: string, percent: string): string => `By ${date} · ${percent} confidence`,
  // "Lab: HbA1c", never two items both titled "Lab".
  planItemNamed: (kind: string, testName: string): string => `${kind}: ${testName}`,
  conditions: 'Conditions',
  probable: (percent: string): string => `Probable · ${percent}`,
  medications: 'Medications',
  expectations: 'Expectations created',
  expectationsIntro:
    'What the engine expects to happen. If a date passes without it, a case opens in the inbox.',
  dueBefore: (date: string): string => `By ${date}`,
  viewBundle: 'View the FHIR Bundle the engine received',
  bundleRegion: 'FHIR Bundle as JSON',
  placeholderTitle: 'Note reading',
  readingNote: 'Reading the note',
  placeholderBody:
    'Save a consultation to see what is understood from the note: the doctor’s plan with its verbatim quote, the probable conditions and the expectations the engine creates.',
};

const review = {
  categories: {
    pre_visit_question: 'To ask at the next visit',
    lab_trend: 'Lab trend',
    vital_trend: 'Vital sign trend',
    abnormal_result_no_followup: 'Abnormal result without follow-up',
    drug_interaction: 'Drug interaction',
    drug_condition_conflict: 'Drug and condition',
    unaddressed_symptom: 'Symptom without workup',
    missing_screening: 'Missing check-up',
    record_quality: 'Record quality',
    utilization_change: 'Change in clinic use',
    similar_patients: 'Similar patients',
  },
  severities: { high: 'High', medium: 'Medium', low: 'Low' },
  verdicts: { relevant: 'Relevant', already_known: 'Already knew', not_relevant: 'Not relevant' },
  citationKinds: {
    note: 'Clinical note',
    result: 'Result',
    medication: 'Medication',
    condition: 'Diagnosis',
  },
  testNames: {
    creatinine: 'creatinine',
    egfr: 'eGFR',
    hba1c: 'HbA1c',
    glucose: 'glucose',
    ldl: 'LDL cholesterol',
    potassium: 'potassium',
    hemoglobin: 'hemoglobin',
    uacr: 'albuminuria',
    systolic_bp: 'systolic pressure',
    diastolic_bp: 'diastolic pressure',
    weight: 'weight',
  } as Record<string, string>,
  steps: {
    labTrend: (test: string | undefined): string =>
      test === undefined ? 'Looked up the trend of a value' : `Looked up the ${test} trend`,
    searchNotes: (query: string): string => `Searched the notes for “${query}”`,
    readNotes: (n: number): string =>
      n > 0 ? `Read ${count(n, 'full note', 'full notes')}` : 'Read notes',
    medications: 'Reviewed the medication list',
    openFollowUps: 'Reviewed the follow-ups the engine already has open',
    interaction: (a: string | undefined, b: string | undefined): string =>
      a && b ? `Checked the interaction ${a} + ${b}` : 'Checked an interaction',
    submitted: (n: number | undefined): string =>
      n === undefined ? 'Submitted its findings' : `Submitted ${count(n, 'finding', 'findings')}`,
    unknownTool: (tool: string): string => `Asked for an unknown tool (${tool})`,
  },
  outcomes: {
    ok: 'OK',
    invalid_arguments: 'Invalid arguments: the error was sent back to it',
    unknown_tool: 'Unknown tool: the error was sent back to it',
    tool_budget_exhausted: 'No calls left: it was asked to submit',
  } as Record<string, string>,
  summaries: {
    points: (n: string): string => `${n} values`,
    notFound: 'no data in the record',
    expectations: (expectations: string, cases: string): string =>
      `${expectations} expectations, ${cases} cases`,
    notesMatch: (n: string): string => `${n} notes match`,
    notes: (n: string): string => `${n} notes`,
    medications: (n: string): string => `${n} medications`,
    findings: (n: string): string => `${n} findings`,
    noInteraction: 'no interaction in the table',
    interaction: (severity: string): string => `${severity} interaction`,
    severityWords: { low: 'low', medium: 'medium', high: 'high' } as Record<string, string>,
  },
  stopReasons: {
    submitted: 'Submitted its findings',
    step_limit: 'Hit the step limit',
    token_budget: 'Hit the token limit',
    llm_budget: 'Monthly AI budget used up',
    error: 'The model did not answer',
    detectors_only: 'Detectors only (no model)',
    no_enabled_category: 'No category enabled',
  } as Record<string, string>,
  discards: {
    no_citation: 'without a quote',
    unknown_document: 'quoted a document that does not exist',
    quote_not_found: 'the quote was not in the document',
    quote_too_short: 'quote too short',
    category_disabled: 'category turned off',
    category_reserved: 'reserved category',
    patient_directed: 'addressed to the patient',
    duplicate: 'repeated (last 90 days)',
    merged: 'merged with another',
  } as Record<string, string>,
  origins: {
    confirmed: 'Detected by rules and confirmed by the agent',
    added: 'Found by the agent',
    fallback: 'Detected by rules (the agent could not review it)',
  },
  page: {
    title: 'Clinical review',
    intro:
      'What the clinical reviewer found in the records: suggestions with quoted evidence, never decisions. Rate each one to measure its precision by category.',
    categoriesLink: 'Categories',
    selectTitle: 'Choose a finding from the list',
    selectBody: 'You will see the quoted evidence, how the agent reached it, and you can rate it.',
  },
  banner: {
    shadowStrong: 'Shadow mode: the medical team does not see these findings.',
    shadowRest: 'Review them to validate each category before turning it on.',
    liveStrong: 'Live:',
    liveRest:
      'these findings are from categories already validated, and the medical team sees them.',
  },
  metrics: {
    ariaLabel: 'Reviewer metrics',
    loading: 'Loading metrics',
    error: 'We could not load the metrics',
    patients: 'Patients reviewed',
    patientsHint: (runs: number): string => `${count(runs, 'review', 'reviews')} in 90 days`,
    per100: 'Findings per 100 patients',
    per100Hint: (discarded: number): string =>
      `${count(discarded, 'discarded', 'discarded')} for lacking a valid quote`,
    cost: 'Average cost per review',
    costHint: (calls: string): string => `${calls} agent calls per review`,
    precision: 'Precision so far',
    precisionNone: 'No rated findings yet',
    precisionHint: (reviewed: number): string => `relevant, out of ${String(reviewed)} rated`,
  },
  list: {
    title: 'Findings',
    modeGroup: 'Mode',
    modeShadow: 'Shadow',
    modeLive: 'Live',
    statusGroup: 'Finding status',
    tabOpen: 'To review',
    tabReviewed: 'Reviewed',
    categoryLabel: 'Category',
    allCategories: 'All categories',
    severityLabel: 'Severity',
    allSeverities: 'Any severity',
    optionWithCount: (label: string, n: number): string => `${label} (${String(n)})`,
    loading: 'Loading findings',
    error: 'We could not load the findings',
    emptyTitle: 'No findings here',
    emptyOpen: 'No findings left to review with these filters.',
    emptyReviewed: 'You have not rated findings with these filters yet.',
    loadMore: 'Load more findings',
  },
  row: { severityPrefix: 'Severity: ', covered: 'Already covered' },
  detail: {
    back: 'Back to the review',
    shadowBadge: 'Shadow mode',
    liveBadge: 'Live',
    detectedOn: (date: string): string => `Detected on ${date}`,
    suggestionTitle: 'Suggestion for the team',
    suggestionNote: 'It is a suggestion, not an order: the doctor decides.',
    coveredTitle: 'Follow-up already covers it',
    evidenceTitle: 'Quoted evidence',
    evidenceNote:
      'Each quote was checked word for word against the document before the finding was saved.',
    citationCaption: (kind: string, date: string): string => `${kind} · ${date}`,
    traceTitle: 'How the reviewer got here',
    traceToggle: 'See the steps',
    traceFacts: {
      steps: 'Steps',
      toolCalls: 'Tool calls',
      cost: 'Cost',
      model: 'Model',
      stop: 'Ending',
      signals: 'Rule signals',
    },
    traceValidatedBy: 'Confirmed by this quote',
    discardedPrefix: 'Discarded by the engine: ',
    discardedItem: (n: number, reason: string): string => `${String(n)} ${reason}`,
    verdictTitle: 'Is this finding relevant?',
    loading: 'Loading finding',
    error: 'We could not load the finding',
    notFound: 'We could not find that finding',
  },
  trend: {
    caption: (label: string, unit: string): string => `${label} (${unit})`,
    values: (n: number): string => count(n, 'value', 'values'),
    referenceLegend: ' · dashed line: reference range',
    description: (
      label: string,
      values: string,
      unit: string,
      range: string,
      reference: string,
    ): string => `${label}: ${values} ${unit}${range}${reference}.`,
    range: (from: string, to: string): string => ` between ${from} and ${to}`,
    reference: (parts: string): string => `. Reference range: ${parts}`,
    low: (value: string): string => `low ${value}`,
    high: (value: string): string => `high ${value}`,
    dateHeader: 'Date',
    valueHeader: (unit: string): string => `Value (${unit})`,
    cited: ' (quoted)',
  },
  verdict: {
    groupLabel: 'Rating',
    reasonRequiredLabel: 'Why is it not relevant?',
    commentLabel: 'Comment (optional)',
    submit: 'Send',
    change: 'Change',
    reasonRequired: 'Tell us why it is not relevant: that tells us what to adjust.',
    reasonTooLong: (limit: string): string => `The reason can be up to ${limit} characters.`,
    summaryPrefix: 'Rated as ',
    summaryBy: (user: string, date: string): string => ` by ${user} on ${date}`,
  },
  flags: {
    back: 'Back to the review',
    title: 'Reviewer categories',
    intro:
      'Every category starts off and in shadow mode. It goes live only when the clinical team reviewed its findings and signs off the validation.',
    loading: 'Loading categories',
    error: 'We could not load the categories',
    live: 'Live',
    shadow: 'Shadow',
    enabled: 'On',
    disabled: 'Off',
    noReviews: 'No ratings in shadow mode yet.',
    reviewStats: (reviewed: number, relevant: number, precision: string): string =>
      `${String(reviewed)} rated · ${String(relevant)} relevant · precision ${precision}`,
    validatedBy: (who: string, date: string | undefined): string =>
      `Validated by ${who}${date === undefined ? '' : ` on ${date}`}`,
    promote: 'Go live',
    demote: 'Back to shadow',
    validatorLabel: 'Who on the clinical team validated this category?',
    validatorPlaceholder: 'Name and role, for example Dr. Pérez (medical coordination)',
    validatorRequired: 'Say who on the clinical team validated this category.',
    validatorHint: 'Live, doctors see this category’s findings and the host system receives them.',
    confirm: 'Confirm',
    cancel: 'Cancel',
    reservedBody:
      'Reserved: it does not exist yet. It needs data from several clinics and its own clinical validation, because a correlation is not a recommendation.',
  },
  beforeVisit: {
    title: 'Before the visit',
    appointmentOn: (date: string): string => `Next appointment: ${date}`,
    emptyWithAppointment: 'Nothing to flag before this visit.',
    loading: 'Loading what to check before the visit',
    error: 'We could not load what to check before the visit',
    shadowBadge: 'Suggestion, not validated yet',
    citationCaption: (title: string, date: string): string => `${title} · ${date}`,
    askedAction: 'Asked',
    notRelevantAction: 'Not relevant',
    reasonLabel: 'Why is it not relevant?',
    reasonRequired: 'Tell us why it is not relevant.',
    cancel: 'Cancel',
    submit: 'Save',
  },
};

/** The Metrics view (HIP-141). */
const metrics: MetricsCopy = {
  title: 'Metrics',
  subtitle:
    'What happened to the cases that reached the inbox in the period: how many ended in a visit, how fast the team acted, and what the AI cost.',
  periodLegend: 'Period',
  preset: (days) => (days === 365 ? 'Last year' : `Last ${String(days)} days`),
  periodRange: (from, to) => `${from} – ${to}`,
  loading: 'Loading metrics',
  errorTitle: 'We could not load the metrics',
  empty: {
    title: 'No cases in this period',
    body: 'Pick a longer period, or come back once cases reach the inbox.',
  },
  tiles: {
    opened: 'Cases opened',
    openedHint: (live, backfill) => `${String(live)} live · ${String(backfill)} from history`,
    booked: 'Ended in a booking',
    bookedHint: (rate) => `${rate} of cases`,
    attended: 'Visit attended',
    attendedHint: (rate) => `${rate} of bookings`,
    firstAction: 'Median time to first action',
    firstActionHint: (measured, pending) =>
      `${String(measured)} acted on · ${String(pending)} still waiting`,
    useful: 'Useful, per the team',
    usefulHint: (count) => `of ${String(count)} ${count === 1 ? 'rated case' : 'rated cases'}`,
    costPerCase: 'AI cost per case',
    costPerCaseHint: (total) => `${total} in the period`,
    lost: 'Lost to follow-up',
    lostHint: (dismissed) => `${String(dismissed)} dismissed by the team`,
    recovered: 'Patients recovered from history',
    recoveredHint: (cases) => `${String(cases)} ${cases === 1 ? 'case' : 'cases'} resolved`,
    none: '—',
  },
  funnel: {
    title: 'From case to visit',
    description:
      'Cases opened in the period, the ones that got a booking and the ones whose visit took place. Attributed bookings came from working the case or from a contact request; organic ones did not.',
    opened: 'Opened',
    booked: 'Booked',
    attended: 'Attended',
    resolvedByBooking: 'Resolved by the booking',
    byOrigin: 'The bookings, by origin',
    origin: {
      followUpCase: 'From the case',
      patientContact: 'After a contact request',
      organic: 'Organic',
    },
    summary: (stage, total, parts) => `${stage}: ${String(total)}${parts ? ` (${parts})` : ''}`,
  },
  timing: {
    title: 'Time to first action',
    description:
      'From the case reaching the inbox to the first thing the team did or the first contact request.',
    median: 'Median',
    p75: '75th percentile',
    p90: '90th percentile',
    none: 'No case was acted on in this period yet.',
    summary: (median, p75, p90) =>
      `Median ${median}, 75th percentile ${p75}, 90th percentile ${p90}`,
  },
  dismissals: {
    title: 'Dismissals by reason',
    description: (total) =>
      `${String(total)} ${total === 1 ? 'case' : 'cases'} dismissed by the team. A reason that repeats points at the rule to tune.`,
    none: 'No case of the period was dismissed.',
    reasons: {
      handled_elsewhere: 'Handled elsewhere',
      already_done: 'Already done',
      not_applicable_to_patient: 'Not for this patient',
      wrong_diagnosis: 'Wrong diagnosis',
      wrong_interval: 'Wrong interval',
      other: 'Other',
    },
  },
  extraction: {
    title: 'What the doctors corrected',
    description:
      'Conditions read from notes that a clinician confirmed or rejected in the period, and corrections to plan items.',
    conditions: 'Conditions read from notes',
    confirmed: 'Confirmed',
    rejected: 'Rejected',
    pending: 'Waiting for review',
    legend: (label, count) => `${label} ${String(count)}`,
    corrections: (rate) => `${rate} rejected`,
    planItems: 'Plan items',
    planItemsNone: 'No plan item was reviewed in this period.',
    planItemsCounts: (confirmed, corrected, rejected) =>
      `${String(confirmed)} confirmed · ${String(corrected)} corrected · ${String(rejected)} rejected`,
  },
  ai: {
    title: 'AI cost',
    description:
      'Every model call of the clinic in the period, by task. Reading a note is charged to the cases its plan opened.',
    tasks: {
      note_extraction: 'Reading notes',
      clinical_review: 'Clinical review',
    },
    calls: (count) => `${String(count)} ${count === 1 ? 'call' : 'calls'}`,
    tokens: (count) => `${count} tokens`,
    perReviewRun: (cost, runs) =>
      `${cost} per review (${String(runs)} ${runs === 1 ? 'review' : 'reviews'})`,
    attributed: (cost, cases) =>
      `${cost} of note reading behind ${String(cases)} ${cases === 1 ? 'case' : 'cases'}`,
    none: 'No model call in this period.',
  },
  ruleVersion: {
    rule: 'Rule',
    protocol: 'Protocol',
    version: (version) => `version ${version}`,
  },
  hours: (hours) => {
    // Intl, not toFixed: arithmetic and formatting only (the catalog test passes a boxed sample).
    const value = hours;
    const one = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
    if (value < 1) return `${String(Math.round(value * 60))} min`;
    return value < 48 ? `${one.format(value)} h` : `${one.format(value / 24)} d`;
  },
};

const why = {
  button: 'Why this?',
  hide: 'Hide why',
  regionLabel: (label: string): string => `Why this: ${label}`,
  dueDate: 'How the due date was computed',
  doctorsPlan: 'What the doctor wrote',
  noteOf: (date: string): string => `Note of ${date}`,
  aiRead: (description: string): string => `What the AI read: ${description}`,
  records: 'Records it counts from',
  protocol: 'Care protocol',
  enrolledBecause: 'Why the patient is in this protocol',
  interval: 'Interval',
  pattern: 'Visit pattern',
  inPattern: 'part of the pattern',
  outOfPattern: 'closed episode, not part of the pattern',
  fulfilledBy: 'What would close it',
  equivalents: (codes: string): string => `Equivalent codes that also count: ${codes}`,
  closedBy: 'Closed by',
  viewDocuments: 'View documents',
  showInDocuments: 'Show in documents',
  documentsTitle: (name: string): string => `Documents of ${name}`,
  documentsDescription:
    'Every record the clinic’s system sent for this patient, newest first. Check each reason against them.',
  documentsCount: (n: number): string => count(n, 'document', 'documents'),
  filterLabel: 'Show',
  filters: {
    all: 'All',
    note: 'Notes',
    result: 'Results',
    order: 'Orders',
    prescription: 'Prescriptions',
    visit: 'Visits',
    appointment: 'Appointments',
    diagnosis: 'Diagnoses',
    allergy: 'Allergies',
    other: 'Other',
  },
  withdrawn: 'Withdrawn by the clinic’s system',
  cited: 'Cited',
  loading: 'Loading documents…',
  error: 'We could not load the documents.',
  empty: 'No documents of this kind.',
  code: (code: string): string => `Code ${code}`,
  status: (status: string): string => `Status: ${status}`,
  by: (author: string): string => `by ${author}`,
  statuses: {
    final: 'final',
    amended: 'amended',
    corrected: 'corrected',
    preliminary: 'preliminary',
    finished: 'finished',
    active: 'active',
    completed: 'completed',
    current: 'current',
    booked: 'booked',
    cancelled: 'cancelled',
    stopped: 'stopped',
    'on-hold': 'on hold',
    'entered-in-error': 'entered in error',
    noshow: 'no-show',
    fulfilled: 'fulfilled',
  },
  conditionQuote: 'Quote from the note',
};

/** Already-resolved param text for an `engineTests.checks` entry (see `check-message.ts`). */
type CheckParams = Record<string, string>;

const engineTests = {
  title: 'Engine tests',
  intro:
    'Verify, one behavior at a time, that the engine does what the product promises — built live in your own lab clinic, never a canned demo.',
  progress: (reviewed: number, total: number): string =>
    `${String(reviewed)} of ${String(total)} tests reviewed`,
  groups: { data_intake: 'Data intake', expectations: 'Expectations', rules: 'Rules' },
  loading: 'Loading the engine tests',
  loadError: 'We could not load the engine tests',
  runTest: 'Run the test',
  runAgain: 'Run again',
  running: 'Running…',
  tryOwnData: 'Try with my own data',
  reviewed: 'Reviewed',
  worksAsExpected: 'Works as I expect',
  doesNotWork: 'Doesn’t work',
  savingVerdict: 'Saving…',
  verdictSaved: 'Verdict saved',
  verdictError: 'We could not save your verdict',
  commentLabel: 'Comment (optional)',
  commentPlaceholder: 'Anything you noticed…',
  autoCheck: {
    expected: 'Expected',
    observed: 'Observed',
    pass: 'Automatic check: pass',
    fail: 'Automatic check: fail',
    notSupported: 'Not supported yet',
    /** A status param whose expectation was not found. */
    missing: 'Not found',
    /** An event-type or source param with nothing to show. */
    none: 'None',
    source: { rules: 'rules', ai: 'the model', none: 'none' },
    calls: (n: number): string => count(n, 'call', 'calls'),
    findings: (n: number): string => count(n, 'quality finding', 'quality findings'),
    ways: (n: number): string => count(n, 'way', 'ways'),
    items: (n: number): string => count(n, 'protocol expectation', 'protocol expectations'),
  },
  timelineTitle: 'What happened',
  timelineEmpty: 'No events yet.',
  expectationsTitle: 'Expectations',
  expectationsEmpty: 'No expectations yet.',
  diffTags: {
    new: 'New',
    fulfilled: 'Fulfilled',
    superseded: 'Superseded',
    expired: 'Expired',
    cancelled: 'Cancelled',
    still_open: 'Still open',
  },
  columns: { rule: 'Rule', layer: 'Layer', version: 'Version', due: 'Due', status: 'Status' },
  readByRules: 'Read by rules',
  readByAi: 'Read by AI',
  verification: { confirmed: 'Confirmed', provisional: 'Provisional' },
  ruleCard: {
    trigger: 'Trigger',
    fulfilledBy: 'Fulfilled by',
    supersededBy: 'Superseded by',
    escalationPolicy: 'Escalation policy',
    version: 'Version',
    dueInDays: (days: number): string => count(days, 'day', 'days'),
  },
  eventTypes: {
    'service_request.created': 'Order placed',
    'result.received': 'Result received',
    'medication.prescribed': 'Medication prescribed',
    'condition.recorded': 'Diagnosis recorded',
    'encounter.finished': 'Visit',
    'appointment.booked': 'Appointment booked',
    'appointment.cancelled': 'Appointment cancelled',
    'note.received': 'Note saved',
    'plan.extracted': 'Plan extracted',
  } as Record<string, string>,
  startTest: 'Start the test',
  starting: 'Starting…',
  stepOf: (step: number, total: number): string => `Step ${String(step)} of ${String(total)}`,
  whatShouldHappen: 'What should happen',
  loadButton: 'Load',
  saveButton: 'Save',
  confirmButton: 'Confirm',
  viewRuleButton: 'Load the rule card',
  startOver: 'Start over',
  stepChecksTitle: 'Checks so far',
  moveLabDateLabel: "Move your lab's date to",
  ruleTimeframeLabel: 'New timeframe (days)',
  confirmPlanStepHint: 'Confirms the plan item above as correct.',
  ruleCardStepHint: 'Reads the rule straight from its own configuration — nothing to edit.',
  diagnosisAttachedHint: 'Attached to the same note, so the patient enrolls in the protocol.',
  visitStepHint: 'A visit alone — no document, nothing else to fill in.',
  tryAnythingElse: {
    title: 'Try anything else',
    intro:
      'Order another test, add a result, prescribe a treatment, or upload a document — on the same patient.',
    loadButton: 'Load',
  },
  scenarios: {
    'structured-no-llm': {
      title: 'Structured data skips the AI',
      statement:
        'An order, a prescription with a duration and a result are each read by rules — never by the language model.',
      steps: [
        {
          title: 'Order a test',
          whatShouldHappen: 'The order is read by rules — no language model is involved.',
        },
        {
          title: 'Prescribe a treatment',
          whatShouldHappen: 'The prescription is read by rules too.',
        },
        {
          title: 'Add the result',
          whatShouldHappen: 'The result closes the order automatically, still with zero AI calls.',
        },
      ],
    },
    'note-ai-once-per-save': {
      title: 'A note is read by AI only when it is saved',
      statement:
        'Saving a note reads it once with the model; moving the clock forward afterward never reads it again.',
      steps: [
        {
          title: 'Upload a report or paste a note',
          whatShouldHappen: 'Saving the note reads it once with the model.',
        },
        {
          title: "Move your lab's date forward",
          whatShouldHappen: 'Moving the clock alone never reads the note again.',
        },
      ],
    },
    'note-extraction-quotes': {
      title: 'Diagnoses, medications and the plan come with quotes',
      statement:
        'A diagnosis (ICD-10), a medication and the doctor’s plan are each extracted from the note with the exact quote that supports them.',
      steps: [
        {
          title: 'Upload a report or paste a note',
          whatShouldHappen:
            'The diagnosis, the medication and the plan each come back with the exact quote that supports them.',
        },
      ],
    },
    'plan-item-confirm': {
      title: 'The doctor confirms a plan item with one click',
      statement:
        'A follow-up item the AI read from the note can be confirmed as correct in one action.',
      steps: [
        {
          title: 'Upload a report or paste a note',
          whatShouldHappen: "The note's plan (“control in a month”) opens a plan item to confirm.",
        },
        {
          title: 'Confirm the plan item',
          whatShouldHappen: 'The plan item is marked confirmed by you, in one click.',
        },
      ],
    },
    'condition-inferred': {
      title: 'A condition can be inferred from treatment or a result',
      statement:
        'Prescribing metformin, or an HbA1c of 6.5% or higher, each suggest diabetes on their own, with no diagnosis typed anywhere.',
      steps: [
        {
          title: 'Prescribe a treatment',
          whatShouldHappen: 'Metformin alone suggests diabetes, with no diagnosis typed anywhere.',
        },
        {
          title: 'Add a result',
          whatShouldHappen: 'An HbA1c of 6.5% or higher suggests diabetes on its own too.',
        },
      ],
    },
    'expectation-has-due-date': {
      title: 'Every event opens an expectation with a due date',
      statement:
        'Each clinical event the engine reads creates an expectation with a concrete due date.',
      steps: [
        {
          title: 'Order a test',
          whatShouldHappen: 'The order opens an expectation with a concrete due date.',
        },
      ],
    },
    'universal-layer': {
      title: 'The universal layer catches orders and treatments with no follow-up',
      statement:
        'An order with no result, and a short treatment with no control visit, each open their own expectation — for any clinic, any specialty.',
      steps: [
        {
          title: 'Order a test',
          whatShouldHappen: 'The order with no result opens its own expectation.',
        },
        {
          title: 'Prescribe a short treatment',
          whatShouldHappen:
            'The short treatment opens its own expectation too, independent of the order.',
        },
      ],
    },
    'doctor-plan-layer': {
      title: 'The doctor’s own plan opens its own expectation',
      statement: 'A note that says “control in a month” opens an expectation due in about 30 days.',
      steps: [
        {
          title: 'Upload a report or paste a note',
          whatShouldHappen: '“Control in a month” opens an expectation due in about 30 days.',
        },
      ],
    },
    'cadence-break': {
      title: 'A broken visit rhythm becomes a case — but only with a pattern',
      statement:
        'A patient with two or more prior visits who breaks their rhythm opens a case; a single prior visit opens nothing.',
      steps: [
        {
          title: 'Record a visit',
          whatShouldHappen: 'One visit alone opens nothing yet.',
        },
        {
          title: "Move your lab's date forward 30 days",
          whatShouldHappen: 'Moving the clock alone changes nothing by itself.',
        },
        {
          title: 'Record another visit',
          whatShouldHappen: 'A second visit, 30 days later, opens a cadence-break expectation.',
        },
        {
          title: "Move your lab's date past its due date",
          whatShouldHappen: 'Past due, the cadence expectation expires and becomes a case.',
        },
      ],
    },
    'protocol-fills-gaps': {
      title: 'A chronic-care protocol fills what the plan left open',
      statement:
        'Once enrolled in the diabetes protocol, routine checks the doctor’s plan did not mention (a lipid panel, an eye exam, a routine visit) still get scheduled.',
      steps: [
        {
          title: 'Upload a note enrolling the patient',
          whatShouldHappen: "The doctor's own plan opens the HbA1c control it asked for.",
        },
        {
          title: 'Record a visit a few days later',
          whatShouldHappen: 'The diabetes protocol fills what the plan did not cover.',
        },
      ],
    },
    'plan-beats-protocol': {
      title: 'The doctor’s plan always outranks the protocol',
      statement:
        'When the doctor’s own plan already asks for a test, the chronic-care protocol never opens a second, duplicate expectation for it.',
      steps: [
        {
          title: 'Upload a note enrolling the patient',
          whatShouldHappen: "The doctor's own plan opens the HbA1c control.",
        },
        {
          title: 'Record a visit a few days later',
          whatShouldHappen: 'The protocol never opens a second, duplicate HbA1c control.',
        },
      ],
    },
    'auto-close-fulfilled': {
      title: 'A result closes its order automatically',
      statement:
        'An order followed by its result is marked fulfilled with no one having to act on it.',
      steps: [
        {
          title: 'Order a test',
          whatShouldHappen: 'The order opens its own expectation.',
        },
        {
          title: 'Add the result',
          whatShouldHappen: 'The result closes the order automatically — no one has to act.',
        },
      ],
    },
    supersession: {
      title: 'A repeated order supersedes the one before it',
      statement:
        'Ordering the same test again marks the earlier order superseded and starts a brand-new due date from the new order.',
      steps: [
        {
          title: 'Order a test',
          whatShouldHappen: 'The order opens a new expectation with a due date.',
        },
        {
          title: 'Order the same test again',
          whatShouldHappen: 'The new order supersedes the old one and starts its own 15-day clock.',
        },
      ],
    },
    'independent-clocks': {
      title: 'Different tests keep separate clocks',
      statement:
        'Two different tests ordered for the same patient are each tracked on their own due date, independent of each other.',
      steps: [
        {
          title: 'Order a test',
          whatShouldHappen: 'The order opens its own expectation, due in 15 days.',
        },
        {
          title: 'Order a different test',
          whatShouldHappen: 'The new test keeps its own 15-day clock, independent of the first.',
        },
      ],
    },
    'visit-closes-controls-not-tests': {
      title: 'A visit closes pending controls, never pending tests',
      statement:
        'A visit fulfills a pending follow-up control, but a pending lab or imaging result still needs its own result to close.',
      steps: [
        {
          title: 'Order a test',
          whatShouldHappen: 'The lab order opens its own expectation.',
        },
        {
          title: 'Prescribe a short treatment',
          whatShouldHappen: 'The short treatment opens its own control expectation.',
        },
        {
          title: 'Record a visit',
          whatShouldHappen:
            'The visit closes the pending control, but the pending lab test stays open.',
        },
      ],
    },
    'note-without-plan-finding': {
      title: 'A note with no plan becomes a quality finding',
      statement:
        'A note that states no follow-up plan at all is recorded as a documentation-quality finding for the clinical team.',
      steps: [
        {
          title: 'Upload a report or paste a note',
          whatShouldHappen:
            'A note with no follow-up plan is recorded as a documentation-quality finding.',
        },
      ],
    },
    'rule-is-configuration': {
      title: 'Rules are configuration, not code',
      statement:
        'Every rule’s trigger, how it is fulfilled and superseded, its escalation policy and its version are read straight from the rule’s own configuration.',
      steps: [
        {
          title: 'Load the rule card',
          whatShouldHappen: "Every field reads straight from the rule's own configuration.",
        },
      ],
    },
    'case-keeps-rule-version': {
      title: 'A case keeps the rule version it opened with',
      statement:
        'Once a case opens, it keeps the exact rule version that created it, even after the clinic later changes that rule.',
      steps: [
        {
          title: 'Order a test',
          whatShouldHappen: "The order opens an expectation carrying today's rule version.",
        },
        {
          title: "Move your lab's date past its due date",
          whatShouldHappen: 'Past due, the expectation expires and becomes a case.',
        },
        {
          title: "Change the clinic's timeframe",
          whatShouldHappen:
            "The case keeps the rule version it opened with, even after the clinic's rule changes.",
        },
      ],
    },
    'per-clinic-override': {
      title: 'A clinic can adjust its own timeframes',
      statement:
        'This lab clinic’s own override moves a rule’s due date (for example 15 days to 10), without changing it for any other clinic.',
      steps: [
        {
          title: 'Order a test',
          whatShouldHappen: "Before any override, the rule's own default timeframe applies.",
        },
        {
          title: "Change the clinic's timeframe",
          whatShouldHappen: "This lab clinic's own override is now active.",
        },
        {
          title: 'Order the test again',
          whatShouldHappen: "Ordering it again now uses this clinic's own timeframe.",
        },
      ],
    },
  } as Record<
    string,
    {
      readonly title: string;
      readonly statement: string;
      readonly steps: readonly { readonly title: string; readonly whatShouldHappen: string }[];
    }
  >,
  /**
   * Every automatic check's `expected`/`observed`, and every timeline
   * entry's `detail` (docs/deploy.md#engine-tests): the API sends a code
   * plus typed params (`CheckMessage`, `check-message.ts` resolves each
   * into text), this catalog writes the sentence. Never literal English
   * from the API.
   */
  checks: {
    // structured-no-llm
    snOrderExpected: 'The order is read by rules; no language model is involved.',
    snRxExpected: 'The prescription is read by rules too; no language model is involved.',
    snRxObserved: (p: CheckParams): string =>
      `Most recent event: ${p['eventType'] ?? ''} (${p['source'] ?? ''}).`,
    snResultExpected: 'The result closes the order automatically — still zero AI calls so far.',
    // note-ai-once-per-save
    naoSaveExpected: '1 note-extraction call on save.',
    naoSaveObserved: (p: CheckParams): string => `${p['calls'] ?? ''} on save.`,
    naoClockExpected: '0 more note-extraction calls just from moving the clock forward.',
    naoClockObserved: 'No new document was saved — moving the clock alone triggers no new call.',
    // note-extraction-quotes
    neqExpected: 'A diagnosis (ICD-10), a medication and a plan item, each with a verbatim quote.',
    neqMissing: 'No extraction was recorded.',
    neqObserved: (p: CheckParams): string =>
      `Diagnosis with quote: ${p['diagnosisOk'] ?? ''}. Medication with quote: ${p['medicationOk'] ?? ''}. Plan item with quote: ${p['planOk'] ?? ''}.`,
    // plan-item-confirm
    picNoteExpected: 'The note opens a doctor-plan expectation to confirm.',
    picNoPlan: 'No doctor-plan expectation was created.',
    picConfirmExpected: 'The plan item is marked confirmed by you with one action.',
    picNotConfirmed: 'The plan item was not confirmed.',
    picConfirmedBy: (p: CheckParams): string => `Confirmed by ${p['who'] ?? ''}.`,
    // condition-inferred
    ciMedExpected: 'A diabetes condition is inferred from the metformin prescription.',
    ciMedFound: 'Found — inferred from the medication.',
    ciResultExpected: 'A diabetes condition is inferred from the HbA1c result on its own.',
    ciResultFound: 'Found — inferred from the result.',
    ciNotFound: 'Not found.',
    // expectation-has-due-date
    ehdExpected: 'The order creates an expectation with a concrete due date.',
    // universal-layer
    ulOrderExpected: 'An order with no result opens a universal-layer expectation.',
    ulRxExpected:
      'A short treatment with no control opens its own expectation, independent of the order.',
    ulRxObserved: (p: CheckParams): string =>
      `Pending order: ${p['orderStatus'] ?? ''}. Short-treatment control: ${p['treatmentStatus'] ?? ''}.`,
    // doctor-plan-layer
    dplExpected:
      'The doctor’s plan “control in a month” opens an expectation due in about 30 days.',
    // cadence-break
    cbVisit1Expected: 'One visit alone opens no cadence expectation yet.',
    cbClockExpected: 'The lab’s date moves forward 30 days.',
    cbClockObserved: 'Clock moved.',
    cbVisit2Expected: 'A second visit, 30 days after the first, opens a cadence-break expectation.',
    cbExpireExpected: 'Past its due date, the cadence expectation expires and becomes a case.',
    // protocol-fills-gaps
    pfgEnrollExpected: 'The doctor’s own plan opens the HbA1c control it asked for.',
    pfgVisitExpected:
      'The diabetes protocol fills what the doctor’s plan did not cover (lipid panel, fundus exam, routine visit).',
    pfgVisitFound: (p: CheckParams): string => `${p['count'] ?? ''} from the protocol layer.`,
    pfgVisitNone: 'No protocol-layer expectation opened.',
    // plan-beats-protocol
    pbpEnrollExpected: 'The doctor’s own plan opens the HbA1c control.',
    pbpVisitExpected:
      'The doctor’s own HbA1c control wins; the protocol does not open a second one for the same test.',
    pbpVisitObserved: (p: CheckParams): string =>
      `Doctor-plan expectation: ${p['planFound'] ?? ''}. Protocol HbA1c expectation: ${p['protocolFound'] ?? ''}.`,
    // auto-close-fulfilled
    acfOrderExpected: 'The order opens its own expectation.',
    acfResultExpected: 'The result closes the order automatically: fulfilled, no human action.',
    // supersession
    supOrderExpected: 'The order opens a new expectation with a due date.',
    supSupersedeExpected:
      'The new order supersedes the old one; its own 15-day clock starts from the new order’s date.',
    supSupersedeObserved: (p: CheckParams): string =>
      `Old status: ${p['oldStatus'] ?? ''}. New due in ${p['dueDays'] ?? ''} from the new order.`,
    supSupersedeObservedUnknown: (p: CheckParams): string =>
      `Old status: ${p['oldStatus'] ?? ''}. The new expectation was not found.`,
    // independent-clocks
    icFirstExpected: 'The HbA1c order opens its own expectation, due in 15 days.',
    icSecondExpected: 'Each test keeps its own 15-day due date, independent of the other’s clock.',
    icMissing: 'One of the two expectations is missing.',
    icBothDue: (p: CheckParams): string =>
      `HbA1c still due ${p['firstDue'] ?? ''} after its own order; lipid panel due ${p['secondDue'] ?? ''} after its own.`,
    // visit-closes-controls-not-tests
    vccOrderExpected: 'The lab order opens its own expectation.',
    vccRxExpected: 'The short treatment opens its own control expectation.',
    vccVisitExpected: 'The visit closes the pending control but leaves the pending lab test open.',
    vccVisitObserved: (p: CheckParams): string =>
      `Follow-up control: ${p['controlStatus'] ?? ''}. Pending lab test: ${p['orderStatus'] ?? ''}.`,
    // note-without-plan-finding
    nwpExpected: 'A note with no follow-up plan is recorded as a documentation-quality finding.',
    nwpObserved: (p: CheckParams): string => `${p['count'] ?? ''} recorded.`,
    // rule-is-configuration
    ricExpected:
      'The rule card (trigger, fulfilment, supersession, escalation, version) reads straight from configuration.',
    ricNotFound: 'Rule not found in configuration.',
    ricFound: (p: CheckParams): string =>
      `Trigger: ${p['trigger'] ?? ''}. Fulfilled by ${p['fulfilledByCount'] ?? ''}. Superseded by ${p['supersededByCount'] ?? ''}. Escalation policy: ${p['escalationPolicy'] ?? ''}. Version: ${p['version'] ?? ''}.`,
    // case-keeps-rule-version
    ckrvOrderExpected: 'The order opens an expectation carrying the rule version it opened with.',
    ckrvVersion: (p: CheckParams): string => `Rule version: ${p['version'] ?? ''}.`,
    ckrvExpireExpected: 'Past its due date, the expectation expires and becomes a case.',
    ckrvVersionKeptExpected:
      'The case’s expectation keeps the rule version it opened with, even after the clinic’s rules change.',
    ckrvVersionKeptObserved: (p: CheckParams): string =>
      `Expectation rule version: ${p['expectationVersion'] ?? ''}. Current config version: ${p['configVersion'] ?? ''}.`,
    // per-clinic-override
    pcoDefaultExpected: (p: CheckParams): string =>
      `Before any override, the rule’s own default timeframe applies (${p['days'] ?? ''}).`,
    pcoOverrideExpected: 'This lab clinic’s own override is now active.',
    pcoOverrideObserved: (p: CheckParams): string =>
      `Effective timeframe: ${p['afterDays'] ?? ''} (was ${p['beforeDays'] ?? ''}).`,
    pcoSecondOrderExpected:
      'Ordering the test again now uses this clinic’s own override: due in 10 days.',
    // freeform ("try anything else")
    ffExpected: 'Exploration — no fixed expectation for a free-form action.',
    ffObserved: 'Applied to the real engine; see the timeline and expectations above.',
    // generic, reused across scenarios
    obsStatus: (p: CheckParams): string => `Status: ${p['status'] ?? ''}.`,
    obsDueAt: (p: CheckParams): string => `Due at ${p['date'] ?? ''}.`,
    obsDueInDays: (p: CheckParams): string => `Due in ${p['days'] ?? ''}.`,
    obsNone: 'No expectation was created yet.',
    obsExpiredCaseOpened: (p: CheckParams): string =>
      `Status: ${p['status'] ?? ''}; a case opened.`,
    obsExpiredNoCase: (p: CheckParams): string =>
      `Status: ${p['status'] ?? ''}; no case opened yet.`,
    // timeline details
    detailServiceRequestCreated: (p: CheckParams): string =>
      `${p['testName'] ?? ''} (${p['code'] ?? ''}) · ${p['category'] ?? ''}`,
    detailResultReceived: (p: CheckParams): string =>
      `${p['testName'] ?? ''} (${p['code'] ?? ''}): ${p['interpretation'] ?? ''}${p['value'] ?? ''}`,
    detailMedicationPrescribed: (p: CheckParams): string => p['medication'] ?? '',
    detailMedicationPrescribedWithDuration: (p: CheckParams): string =>
      `${p['medication'] ?? ''} · ${p['duration'] ?? ''}`,
    detailConditionRecorded: (p: CheckParams): string =>
      `${p['diagnosis'] ?? ''} (${p['code'] ?? ''}) · ${p['verification'] ?? ''}`,
    detailVisitCompleted: 'Visit completed.',
    detailAppointmentBooked: (p: CheckParams): string =>
      `Appointment booked for ${p['date'] ?? ''}.`,
    detailAppointmentCancelled: 'Appointment cancelled.',
    detailNoteSaved: 'Clinical note saved.',
    detailPlanNone: 'No follow-up plan found.',
    detailPlanItems: (p: CheckParams): string => `Plan: ${p['items'] ?? ''}.`,
    detailAllergyRecorded: 'Allergy recorded.',
    detailLanguageRecorded: 'Patient’s language recorded.',
    detailOptedOut: 'Patient opted out.',
    detailRecordWithdrawn: 'Record withdrawn.',
  } as Record<string, string | ((p: CheckParams) => string)>,
};

const EVALUATOR_ACTION_LABELS = {
  login: 'Logged in',
  case_feedback: 'Gave feedback on a case',
  case_dismiss: 'Dismissed a case',
  case_resolve: 'Resolved a case',
  case_snooze: 'Snoozed a case',
  case_request_contact: 'Requested contact with a patient',
  case_call_outcome: 'Recorded a call outcome',
  suppression_reactivate: 'Reactivated a reminder',
  plan_item_confirm: 'Confirmed a plan item',
  plan_item_correct: 'Corrected a plan item',
  plan_item_reject: 'Rejected a plan item',
  finding_review: 'Reviewed a clinical finding',
  lab_patient_created: 'Created a lab patient',
  lab_document_uploaded: 'Uploaded a lab document',
  lab_record_added: 'Added a lab record',
  lab_date_viewed: 'Moved the lab clock',
  case_viewed: 'Viewed a case',
  patient_documents_viewed: 'Viewed a patient’s documents',
  engine_test_step: 'Loaded an engine-test step',
} as Record<string, string>;

const lab = {
  title: 'Lab',
  intro:
    'Your own sandbox clinic: upload a document, add records, and see the impact on a date — isolated from the shared demo and from every other evaluator.',
  patientsTitle: 'My lab patients',
  loadingPatients: 'Loading your lab patients',
  patientsError: 'We could not load your lab patients',
  noPatients: 'You have not created a lab patient yet.',
  noPatientsBody: 'Create one to start adding documents and records.',
  newPatient: 'New patient',
  newPatientOption: '+ New patient',
  newPatientTitle: 'New lab patient',
  patientName: 'Name',
  patientNamePlaceholder: 'First and last name (fictional)',
  patientSex: 'Sex',
  patientSexUnspecified: 'Not specified',
  patientAge: 'Age',
  patientAgeUnspecified: 'Not specified',
  patientSpecialty: 'Specialty',
  createPatient: 'Create patient',
  creatingPatient: 'Creating patient…',
  selectPatient: 'Select a patient',
  noPatientSelected: 'Select or create a lab patient to add to their record.',
  // "Upload a report or document": the Lab page's primary card.
  uploadTitle: 'Upload a report or document',
  uploadIntro:
    'Drop a file, choose one, or paste the text. It is read the same way a real document would be.',
  dropzoneHint: 'Drag and drop a file here',
  chooseFile: 'Choose file',
  orPasteText: 'or paste the text',
  backToFile: 'Upload a file instead',
  readDocument: 'Read document',
  reading: 'Reading…',
  resultTitle: 'What the engine expects now',
  // The collapsed structured block, below the upload card.
  addWithoutDocumentTitle: 'Add something without a document',
  addWithoutDocumentIntro:
    'A lab/imaging order, a result, a prescription, a visit, a diagnosis or an appointment, with no document and no AI reading.',
  showForm: 'Show',
  hideForm: 'Hide',
  recordType: 'Type',
  recordTypes: {
    order: 'Lab/imaging order',
    result: 'Result',
    prescription: 'Prescription',
    visit: 'Visit',
    appointment_booked: 'Appointment booked',
    appointment_cancelled: 'Appointment cancelled',
    diagnosis: 'Diagnosis',
  },
  date: 'Date',
  dateHint: 'Defaults to your lab’s current date. Past dates are allowed; future dates are not.',
  documentType: 'Type',
  documentTypes: {
    consultation_note: 'Consultation note',
    lab_result: 'Lab report',
    imaging_report: 'Imaging report',
    prescription: 'Prescription or order',
    other: 'Other',
  },
  fileLabel: 'File',
  fileHint: 'PDF, DOCX or TXT, up to 2 MB.',
  textLabel: 'Text',
  textPlaceholder: 'Paste the document’s text here…',
  orderLoinc: 'Test code (LOINC)',
  orderDisplay: 'Test name',
  orderCategory: 'Category',
  orderCategories: { laboratory: 'Laboratory', imaging: 'Imaging', other: 'Other' },
  resultValue: 'Value',
  resultUnit: 'Unit',
  resultInterpretation: 'Interpretation',
  interpretations: { normal: 'Normal', abnormal: 'Abnormal', unknown: 'No interpretation' },
  resultBasedOnOrder: 'Fulfils an order (optional)',
  resultBasedOnOrderNone: 'No specific order',
  prescriptionDrug: 'Drug',
  prescriptionDrugPlaceholder: 'For example, Metformin 850 mg',
  prescriptionDuration: 'Duration (days, optional)',
  diagnosisIcd10: 'Diagnosis (ICD-10)',
  diagnosisOther: 'Other (type the code)',
  diagnosisCode: 'ICD-10 code',
  diagnosisCodePlaceholder: 'E11',
  diagnosisDisplay: 'Description',
  appointmentScheduledFor: 'Scheduled for',
  appointmentSpecialty: 'Specialty (optional)',
  appointmentToCancel: 'Appointment to cancel',
  appointmentToCancelNone: 'No booked appointment yet',
  save: 'Save',
  saving: 'Saving…',
  readByTitle: (model: string): string => `Read by ${model}`,
  savedTitle: 'Saved to the record',
  documentUploadedTitle: (documentType: string): string => `Document uploaded: ${documentType}`,
  timelineTitle: 'Timeline',
  timelineEmpty: 'Nothing in this patient’s record yet.',
  expectationsTitle: 'Expectations',
  expectationsIntro:
    'What the engine expects to happen for this patient. Changes since your last action are highlighted.',
  expectationsEmpty: 'No expectations yet for this patient.',
  due: (date: string): string => `Due ${date}`,
  ruleVersion: (version: string): string => `Rule ${version}`,
  impactTitle: 'What happens on a date?',
  impactIntro:
    'Moves your lab’s own clock forward (never the shared demo’s). Expectations fall due, cases open, merge and escalate, exactly as the engine would over that stretch of time.',
  impactDate: 'Date',
  impactButton: 'See the impact',
  impactSeeing: 'Moving the clock…',
  impactSummary: (expired: number, opened: number, escalated: number): string =>
    `${count(expired, 'expectation', 'expectations')} expired, ${count(opened, 'case', 'cases')} opened, ${count(escalated, 'case', 'cases')} escalated.`,
  impactNone: 'Nothing changed on that date.',
  impactMovedTo: (date: string): string => `Your lab is now on ${date}.`,
  viewLabCases: 'View your lab’s cases',
  labCasesTitle: 'Your lab’s cases',
  labCasesEmpty: 'No open cases in your lab yet.',
  labCasesEmptyBody: 'Add records and move the clock forward to see cases open.',
};

const evaluators = {
  title: 'Evaluators',
  intro: 'Everyone who has opened the hosted demo, and what they have done with it.',
  loading: 'Loading evaluators',
  error: 'We could not load the evaluators',
  empty: 'No evaluator has logged in yet.',
  email: 'Evaluator',
  lastSeen: 'Last seen',
  firstSeen: 'First seen',
  totalActions: 'Actions',
  actionsByType: 'By action',
  activityLogTitle: 'Activity log',
  activityLogEmpty: 'No activity yet.',
  activityLogError: 'We could not load the activity log',
  filterByEvaluator: 'Filter by evaluator',
  allEvaluators: 'All evaluators',
  downloadCsv: 'Download CSV',
  action: EVALUATOR_ACTION_LABELS,
};

type AgentParams = Readonly<Record<string, string | number | boolean | null | readonly string[]>>;
type Params = AgentParams;

function str(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}
function num(value: unknown): string {
  return typeof value === 'number' ? numbers.format(value) : '0';
}
function list(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** Codes the agent's trace carries (triggers, tracks, refusals, categories), in words. */
const AGENT_CODES: Readonly<Record<string, string>> = {
  take_ownership: 'taking ownership',
  inbound_message: 'a message from Maria',
  ladder_rung: 'a ladder rung',
  phone_fixed: 'phone updated',
  routine: 'routine track',
  urgent: 'urgent track',
  undelivered: 'undelivered',
  reply: 'a reply',
  proactive: 'proactive',
  earliest: 'earliest',
  other_time: 'another time',
  saturday: 'Saturday',
  nearer_lab: 'nearer lab',
  opted_out: 'opted out',
  phone_undelivered: 'phone not reachable',
  cap_reached: 'weekly cap reached',
  reply_limit: 'reply limit reached',
  not_an_open_order: 'not one of the open orders',
  unknown_or_taken_slot: 'unknown or taken slot',
  not_a_photo_message: 'not a photo',
  photo_does_not_answer_order: 'the photo does not answer this order',
  name_on_report_does_not_match: 'the name on the report does not match',
  unknown_tool: 'unknown tool',
  invalid_arguments: 'invalid arguments',
  no_tool_call: 'it answered in prose, so the turn ends',
  message_not_found: 'message not found',
  not_inbound: 'not a patient message',
  not_latest_inbound: 'not her latest message',
  slot_not_offered: 'slot never offered',
  offer_for_other_order: 'offered for another order',
  slot_not_free: 'slot no longer free',
  not_affirmative: 'not an explicit yes',
  ambiguous_choice: 'no single option chosen',
  matches: 'matches',
  mismatch: 'does not match',
  absent: 'not printed',
  delivered: 'delivered',
  read: 'read',
  call_patient: 'call the patient',
  update_phone: 'update the phone',
  call_other_contact: 'call another contact',
  doctor_notice: 'notice for the doctor',
  normal: 'normal',
  high: 'high',
  result_value: 'a result value',
  result_judgement: 'a verdict on a result',
  condition_term: 'a condition name',
  diagnosis_word: 'a diagnosis',
  medical_advice: 'medical advice',
  missing_screening: 'missing screening',
  pre_visit_question: 'pre-visit question',
  lab_trend: 'lab trend',
  abnormal_result_no_followup: 'abnormal result without follow-up',
  abnormal_result_followup: 'follow-up of an abnormal result',
  doctor_plan_followup: 'doctor’s plan',
  protocol_diabetes_hba1c: 'diabetes protocol: HbA1c',
  protocol_diabetes_visit: 'diabetes protocol: visit',
  protocol_diabetes_lipids: 'diabetes protocol: lipids',
  protocol_diabetes_fundus: 'diabetes protocol: fundus exam',
  'fasting glucose': 'fasting glucose',
  vital_trend: 'vital-sign trend',
  record_quality: 'record quality',
};

function code(value: unknown): string {
  const raw = str(value);
  return AGENT_CODES[raw] ?? raw.replace(/_/g, ' ');
}

const RUNG_TRACKS: Readonly<Record<string, string>> = {
  routine: 'Routine',
  urgent: 'Urgent',
  undelivered: 'Undelivered',
};
const RUNG_ACTIONS: Readonly<Record<string, string>> = {
  message: 'message',
  call_task: 'call task for reception',
  doctor_notice: 'notice to the doctor',
  update_phone_task: 'task to update the phone',
  other_contact_task: 'call via other contact data',
  unreachable: 'unreachable',
};

/** "routine:14d" → "Routine rung, day 14: call task for reception". */
function rung(id: unknown, action: unknown): string {
  const match = /^([a-z]+):(\d+)([dh])$/.exec(str(id));
  if (match === null) return str(id);
  const [, track = '', count = '0', unit] = match;
  const when = unit === 'h' ? `hour ${count}` : `day ${count}`;
  const what = RUNG_ACTIONS[str(action) || 'message'] ?? code(action);
  return `${RUNG_TRACKS[track] ?? track} rung, ${when}: ${what}`;
}

const agent = {
  title: 'Order-to-completion agent',
  subtitle:
    'The agent owns every order the doctor wrote until the engine says it is done. The agent acts, the engine verifies, the doctor decides.',
  storyTitle: 'Maria’s story',
  storyBodies: {
    maria:
      'Maria (synthetic) has type 2 diabetes. At her last visit, months ago, her doctor ordered an HbA1c test and a control in three months, and she never came back. Start the story: the agent takes over her open orders in your own sandbox clinic, on its own clock.',
    maria_urgent:
      'Maria (synthetic) has type 2 diabetes and missed her control. Three days ago her lab sent the clinic an HbA1c of 8.4\u00a0%, flagged abnormal: the engine asks for a visit soon and the doctor already sees what the result means. The agent has a few days, not weeks: it follows the urgent ladder in your own sandbox clinic, on its own clock.',
  } as Record<string, string>,
  storyLabel: 'Story',
  stories: {
    maria: 'Routine: she stopped coming',
    maria_urgent: 'Urgent: her abnormal HbA1c reached the clinic',
  } as Record<string, string>,
  modeLabel: 'Agent model',
  modes: { live: 'Muse Spark (live)', scripted: 'Scripted (offline)' } as Record<string, string>,
  modeHints: {
    live: 'Real calls to Muse Spark, Muse Voice and vision through the gateway, within the demo budget.',
    scripted:
      'A deterministic player of the same story, through the same tools and guardrails. No key needed.',
  } as Record<string, string>,
  liveUnavailable: 'Live mode needs a Meta API key on the server.',
  languageLabel: 'Maria writes in',
  start: 'Start the story',
  restart: 'Restart with a new Maria',
  starting: 'Loading Maria’s chart and handing her orders to the agent…',
  modelBadge: (model: string): string => `Model: ${model}`,
  scriptedModel: 'scripted player, no model calls',
  phone: {
    title: 'Simulated WhatsApp',
    contact: 'Clinic follow-up',
    subtitle: 'You play Maria',
    working: 'The agent is working…',
    placeholder: 'Write as Maria…',
    send: 'Send',
    sampleVoice: 'Sample voice note',
    samplePhoto: 'Sample lab photo',
    uploadVoice: 'Upload a WAV voice note',
    uploadPhoto: 'Upload a photo',
    attachments: 'Send media',
    suggested: 'Suggested replies',
    voiceNote: 'Voice note',
    transcriptLabel: 'Transcript',
    transcribing: 'Transcribing…',
    photo: 'Photo',
    photoAlt: 'Photo Maria sent',
    reading: 'Reading the photo…',
    statuses: {
      sent: 'Sent',
      delivered: 'Delivered',
      read: 'Read',
      undelivered: 'Not delivered',
    } as Record<string, string>,
    markRead: 'Mark read',
    markUndelivered: 'Mark undelivered',
    statusActions: 'Delivery status',
    undeliveredBanner: 'A message did not reach this phone: the agent stopped messaging.',
    fixPhone: 'Reception updated the phone',
    optedOutBanner: 'Maria asked not to be contacted: the agent stopped.',
    doneBanner: 'Every order is booked or done: the agent is standing by.',
    unreachableBanner: (date: string): string => `Unreachable: orders stay open, retry on ${date}.`,
    flagBanner: 'Unreachable on the urgent track: flagged for her next contact with the clinic.',
    empty: 'No messages yet.',
  },
  console: {
    title: 'Live agent console',
    subtitle: 'Every model call, tool call and engine event, as it happens.',
    empty: 'Start the story to see the agent work.',
    reason: 'Reason',
    read: 'Read',
    args: 'Arguments',
    tokens: (input: number, output: number): string =>
      `${String(input)} in / ${String(output)} out tokens`,
    runTotal: (cost: string, calls: number): string => `${String(calls)} model calls · ${cost}`,
    kinds: {
      model: 'Model',
      tool: 'Tool',
      engine: 'Engine',
      transcription: 'Voice',
      vision: 'Vision',
      guardrail: 'Guardrail',
      ladder: 'Ladder',
      policy: 'Policy',
    } as Record<string, string>,
    outcomes: { ok: 'OK', rejected: 'Refused', error: 'Error', info: 'Info' } as Record<
      string,
      string
    >,
  },
  orders: {
    title: 'The doctor’s orders',
    visit: 'Follow-up visit',
    test: (name: string): string => `${name} test`,
    unknownTest: 'Lab test',
    due: (date: string): string => `Due ${date}`,
    urgent: 'Urgent',
    sources: {
      doctor_note: 'From the doctor’s note',
      doctor_order: 'Doctor’s order',
      abnormal_result: 'Asked for by an abnormal result',
    } as Record<string, string>,
    stages: {
      open: 'Open',
      contacted: 'Contacted',
      booked: 'Booked',
      result_received: 'Result received',
      fulfilled: 'Fulfilled by the engine',
      unreachable: 'Unreachable',
    } as Record<string, string>,
    closedBy: (resource: string): string => `Closed by ${resource}`,
    closedByVisit: (when: string): string => `Closed by the visit on ${when}`,
    closedByResult: (when: string, value: string): string =>
      `Closed by the result of ${when}${value === '' ? '' : ` (${value})`}`,
    ignored: (count: number): string =>
      `${String(count)} engine ${count === 1 ? 'suggestion' : 'suggestions'} (protocol items) not pursued: only doctor’s orders.`,
    empty: 'No open orders.',
  },
  clock: {
    title: 'Clinic clock',
    today: (date: string): string => `Today in your sandbox: ${date}`,
    jump: (days: number): string => `+${String(days)} ${days === 1 ? 'day' : 'days'}`,
    hint: 'The ladder runs on this clock, day by day: jump ahead to see what happens when Maria does not answer.',
    ladder: 'No-response ladder',
    tracks: {
      routine: 'Routine track',
      urgent: 'Urgent track',
      undelivered: 'Undelivered track',
    } as Record<string, string>,
    actions: {
      message: 'Message',
      call_task: 'Call task for reception',
      doctor_notice: 'Doctor notified',
      update_phone_task: 'Task: update the phone',
      other_contact_task: 'Call via other contact data',
      unreachable: 'Unreachable',
    } as Record<string, string>,
    rungDone: 'Done',
    stopped: 'Stopped: every order is booked or fulfilled.',
  },
  doctor: {
    title: 'For the doctor',
    subtitle:
      'What the clinical reviewer found after the result came in: suggestions for the doctor, never sent to Maria.',
    empty: 'Nothing yet.',
    shadow: 'Shadow mode',
    routine: (count: number): string =>
      `${String(count)} routine ${count === 1 ? 'gap' : 'gaps'} (screenings, record)`,
  },
  tasks: {
    title: 'Staff tasks',
    empty: 'No tasks.',
    kinds: {
      call_patient: 'Call the patient',
      update_phone: 'Update the phone number',
      call_other_contact: 'Call another contact',
      doctor_notice: 'Notice for the doctor',
    } as Record<string, string>,
    high: 'High priority',
    due: (date: string): string => `Due ${date}`,
    ordersLine: (orders: string): string => `Open orders: ${orders}.`,
    noOrders: 'No open orders left.',
    outreachLine: (
      count: number,
      last: string | undefined,
      status: string | undefined,
      replied: boolean,
    ): string =>
      `${String(count)} ${count === 1 ? 'message' : 'messages'} sent${last === undefined ? '' : `, last on ${last}`}${status === undefined ? '' : ` (${status})`}; ${replied ? 'she has replied before' : 'no reply'}.`,
    asks: {
      book_orders: 'Call her to book the visit and the test; offer a Saturday or the nearer lab.',
      update_phone: 'Messages are not delivered: get a working phone number today.',
      reach_other_contact: 'Still no working phone: try her other contact data.',
      patient_unreachable:
        'Unreachable after three weeks: orders stay open, the agent retries in a month.',
      urgent_unanswered: 'Urgent order unanswered: reach her today.',
      patient_question: 'She asked something only the team can answer: call her back.',
      opted_out: 'She asked not to be messaged: follow up by phone if needed.',
    } as Record<string, string>,
  },
  events: {
    ownership_taken: (p: Params): string =>
      `Took ownership of ${num(p['orders'])} doctor’s orders (${num(p['ignoredEngineItems'])} engine suggestions ignored), ${code(p['track'])}.`,
    turn_started: (p: Params): string =>
      `Turn started: ${code(p['trigger'])}${p['rung'] === undefined ? '' : ` (${rung(p['rung'], 'message')})`}.`,
    model_called: (p: Params): string => `The model chose ${str(p['tool']) || 'its next tool'}.`,
    orders_listed: (p: Params): string => `${num(p['open'])} open orders read.`,
    patient_summary_read: (): string => 'Pseudonymous summary read (no name, no phone).',
    policy_read: (p: Params): string =>
      p['canSend'] === true
        ? `May send (${code(p['sendKind'])}); ${num(p['proactiveRemaining'])} proactive messages left this week.`
        : 'May not send now.',
    slots_found: (p: Params): string =>
      `${num(p['count'])} free slots computed by code (${code(p['preference'])}).`,
    message_sent: (p: Params): string => `Message sent (${code(p['sendKind'])}).`,
    slots_offered: (p: Params): string =>
      `Offered ${String(list(p['slots']).length)} slot(s) (${code(p['sendKind'])}).`,
    send_blocked: (p: Params): string => `Send blocked by the contact policy: ${code(p['block'])}.`,
    unsafe_message_blocked: (p: Params): string =>
      `Message refused by the safety check (${list(p['kinds']).map(code).join(', ')}): the model must rewrite it.`,
    tool_refused: (p: Params): string => `Tool refused: ${code(p['error'])}.`,
    booking_refused: (p: Params): string => `Booking refused by code: ${code(p['reason'])}.`,
    appointment_booked: (): string => 'Appointment booked on the patient’s explicit confirmation.',
    appointment_already_booked: (): string => 'Already booked for this confirmation (idempotent).',
    photo_not_a_report: (): string => 'The photo is not a lab report.',
    result_matched: (p: Params): string =>
      `Photo matched to ${list(p['matches']).map(code).join(', ') || 'no order'}${list(p['unmatched']).length === 0 ? '' : ` (not ordered: ${list(p['unmatched']).map(code).join(', ')})`}; name on report: ${code(p['nameCheck'])}.`,
    result_submitted: (p: Params): string => `FHIR Observation submitted: ${str(p['resource'])}.`,
    expectation_fulfilled: (p: Params): string =>
      `Engine: ${p['order'] === 'visit' ? 'follow-up visit' : str(p['order'])} expectation fulfilled by ${str(p['by'])}${p['owned'] === false ? ' (an engine item)' : ''}.`,
    expectation_created: (p: Params): string => `Engine: new expectation (${code(p['ruleId'])}).`,
    expectation_still_open: (): string =>
      'Engine: the order stays open (the result does not fulfill it).',
    clinical_review_completed: (p: Params): string =>
      `Clinical reviewer ran ${p['on'] === 'booking' ? 'for the booked visit' : p['on'] === 'arrival' ? 'on the result the lab sent' : 'on the result'}: ${num(p['findings'])} new findings for the doctor${list(p['categories']).length === 0 ? '' : ` (${list(p['categories']).map(code).join(', ')})`}.`,
    clinical_review_failed: (): string =>
      'The clinical reviewer failed; the result is stored anyway.',
    handed_to_staff: (): string => 'Handed over to the clinic team.',
    turn_ended: (p: Params): string => `Turn ended: ${str(p['summary'])}`,
    call_rejected: (p: Params): string => `Call rejected before running: ${code(p['error'])}.`,
    voice_transcribed: (p: Params): string => `Voice note transcribed: “${str(p['transcript'])}”`,
    photo_read: (p: Params): string =>
      `Photo read: ${list(p['tests']).join('; ') || 'no results'}.`,
    media_unreadable: (): string => 'The media could not be read.',
    budget_fallback_scripted: (): string =>
      'Demo budget reached: this turn runs on the scripted player.',
    turn_failed: (p: Params): string => `Turn failed: ${str(p['error'])}`,
    patient_message_received: (p: Params): string =>
      `Maria sent a ${str(p['kind']) === 'text' ? 'message' : str(p['kind']) === 'voice' ? 'voice note' : 'photo'}.`,
    ladder_reanchored: (): string => 'Ladder restarted from this reply.',
    all_orders_covered: (): string => 'Every order is booked or fulfilled: the ladder stops.',
    rung_due: (p: Params): string => `Due now: ${rung(p['rung'], p['action'])}.`,
    rung_skipped: (p: Params): string => `Rung skipped by the contact policy: ${code(p['block'])}.`,
    staff_task_created: (p: Params): string =>
      `Staff task created (${code(p['kind'])}, ${code(p['priority'])} priority).`,
    patient_unreachable: (p: Params): string =>
      p['urgent'] === true
        ? 'Unreachable: flagged for her next contact.'
        : 'Unreachable: orders stay open, retry in a month.',
    retry_started: (): string => 'A month later: the agent tries again.',
    opted_out: (): string => 'Opt-out detected by code: no more messages.',
    delivery_status: (p: Params): string => `Delivery status: ${code(p['status'])}.`,
    messaging_stopped_undelivered: (): string =>
      'Undelivered: messaging stopped, likely a wrong number.',
    phone_fixed: (): string => 'Phone updated: the ladder restarts.',
  } as Record<string, (params: Params) => string>,
  reasons: {
    'scripted:no_context': 'No turn context.',
    'scripted:done': 'Done for this turn.',
    'scripted:list_orders': "First, which of the doctor's orders are still open.",
    'scripted:check_policy': 'Check whether a message may be sent now.',
    'scripted:find_slots': 'Find slots for the order to book.',
    'scripted:offer_rung': 'Offer a slot, as this rung asks.',
    'scripted:match_photo': 'A photo: which order does it answer?',
    'scripted:photo_unusable': 'The photo is not a usable report.',
    'scripted:submit_result': 'Submit the result to the engine: it decides.',
    'scripted:thank_photo': 'Thank the patient; nothing about the content.',
    'scripted:hand_over': 'A question about a result: hand over to the team.',
    'scripted:tell_handover': 'Tell her the team will contact her.',
    'scripted:confirm_booking': 'Confirm the booking.',
    'scripted:booking_refused': 'The booking was refused: ask which option.',
    'scripted:find_other_slots': 'She cannot make it: find other slots.',
    'scripted:offer_options': 'Offer the new options.',
    'scripted:book_choice': 'An explicit choice of an offered slot: book it.',
    'scripted:ask_which': 'A yes without a choice: ask which one.',
    'scripted:acknowledge': 'Acknowledge.',
    'scripted:answered': 'answered the message.',
    'scripted:outreach_sent': 'outreach sent.',
    'scripted:contact_policy_not_now': 'the contact policy says not now.',
    'scripted:nothing_to_chase': 'nothing left to chase.',
    'scripted:no_free_slot': 'no free slot fits.',
    'scripted:no_patient_message': 'no patient message.',
    'loop:prose_end': 'the model replied in prose, so the turn ended.',
  } as Record<string, string>,
  unknownEvent: (event: string): string => code(event),
};

const value: ValueCopy = {
  title: 'Value',
  subtitle:
    'What the order agent changes for a clinic: a 90-day simulation with a control arm, next to the real numbers of this demo clinic.',
  notice: 'Simulation with synthetic patients and stated assumptions; not a clinical trial.',
  method: 'Method and every assumption: docs/simulation.md in the repository.',
  loading: 'Loading the simulation',
  running: (done, total) =>
    `Running the simulation: ${String(done)} of ${String(total)} runs done…`,
  errorTitle: 'We could not load the simulation',
  headline: {
    title: 'Orders fulfilled within 90 days',
    control: 'Fixed reminders (control)',
    agent: 'Order agent',
    difference: (points, low, high) => `${points} points (95% interval ${low} to ${high})`,
    scope: (patients, seeds, days) =>
      `${patients} synthetic patients per arm · ${String(seeds)} seeded runs · ${String(days)} days · 95% interval across runs`,
    interval: (low, high) => `95% interval ${low} to ${high}`,
    summary: (control, agent, points) =>
      `Orders fulfilled: ${control} with fixed reminders, ${agent} with the order agent, ${points} points.`,
  },
  arms: { control: 'Fixed reminders', agent: 'Order agent' },
  points: (value) => `${value} pts`,
  intervalLegend: '95% interval across runs',
  clinic: {
    title: 'For your clinic',
    description:
      'The simulated difference per patient, scaled to your numbers. Change them: the estimate updates here, nothing is sent.',
    patientsPerMonth: 'Patients with new orders per month',
    patientsHint:
      'Patients who leave a consultation with a test, a study or a control to complete.',
    price: (currency) => `Price per consultation (${currency})`,
    priceHint: 'An assumption: what an attended consultation brings in.',
    invalid: 'Enter a number of zero or more.',
    consultations: 'Extra attended consultations per month',
    consultationsHint: (low, high) => `95% interval ${low} to ${high}`,
    revenue: 'Estimated recovered revenue per month',
    revenueHint: (low, high) => `95% interval ${low} to ${high}; consultations only`,
    orders: 'Extra orders completed per month',
    ordersHint: (low, high) => `95% interval ${low} to ${high}`,
  },
  tiles: {
    urgent7: 'Urgent orders done within 7 days',
    urgent14: (agent, control) => `Within 14 days: ${agent} (fixed reminders: ${control})`,
    median: 'Median days to fulfilment',
    days: (value) => `${value} days`,
    unreachable: 'Patients never reached (order still open)',
    messages: 'Messages per patient',
    messagesHint: (max) =>
      `Never more than ${String(max)} proactive messages to one patient in 7 days`,
    staff: 'Staff tasks per 100 patients',
    staffHint: (calls, notices, phones) =>
      `${calls} calls, ${notices} notices to the doctor, ${phones} phone updates`,
    attended: 'Consultations attended per 100 patients',
    versus: (control) => `Fixed reminders: ${control}`,
  },
  personas: {
    title: 'Who the agent rescues',
    description:
      'Orders fulfilled by patient behaviour, control against agent, with the 95% interval as a thin line. Where the agent does not help, it shows.',
    caption: 'Orders fulfilled by persona and arm',
    share: (value) => `${value} of patients`,
    names: {
      fast_responder: 'Fast responder',
      second_try: 'Needs a second try',
      slot_friction: 'Only after the time changes',
      wrong_number: 'Wrong number',
      reads_never_answers: 'Reads, never answers',
      never_answers: 'Never answers',
      opts_out: 'Opts out',
      elsewhere_photo: 'Test done elsewhere',
    },
    summaries: {
      fast_responder: 'Answers the first message and takes a slot that fits.',
      second_try: 'Misses the first message and answers a later one.',
      slot_friction: 'Answers, but the time never suits ("not Tuesday", only Saturdays).',
      wrong_number: 'The phone on file is wrong until reception fixes it.',
      reads_never_answers: 'Reads messages but never writes back; picks up a call.',
      never_answers: 'No message or call reaches them; only their own initiative.',
      opts_out: 'Asks the clinic to stop writing at the first reply.',
      elsewhere_photo: 'Did the test at an outside lab; sends a photo when asked.',
    },
  },
  kinds: {
    title: 'By kind of order',
    description: 'Orders fulfilled by what the doctor ordered.',
    caption: 'Orders fulfilled by kind of order and arm',
    names: {
      lab: 'Lab tests',
      imaging: 'Imaging studies',
      visit: 'Control visits',
      urgent: 'Urgent visits (abnormal result)',
    },
  },
  workload: {
    title: 'Staff workload',
    description:
      'What the agent hands to people, per 100 patients with orders. Fixed reminders hand over nothing.',
    caption: 'Staff tasks per 100 patients, order agent',
    perHundred: 'per 100 patients',
    tasks: {
      call_patient: 'Reception calls',
      doctor_notice: 'Notices to the doctor',
      update_phone: 'Phone updates',
      call_other_contact: 'Calls to another contact',
    },
  },
  demoClinic: {
    title: 'This demo clinic',
    description:
      'Real engine data of this clinic over the last 90 days: bookings made from an engine case (attribution by the case on the appointment).',
    booked: 'Bookings from engine cases',
    bookedHint: (total) => `of ${String(total)} bookings in the period`,
    attended: 'Attended from engine cases',
    attendedHint: (total) => `of ${String(total)} attended in the period`,
    revenue: 'Estimated revenue from them',
    revenueHint: (price) => `at ${price} per attended consultation`,
    empty: 'No booking from an engine case yet in this clinic.',
    unavailable: 'The clinic metrics could not be loaded.',
  },
  assumptions: {
    title: 'Method and assumptions',
    description: 'Read these before quoting a number.',
    items: [
      'Personas and every probability are plausible values chosen by the team, not measurements; no study is cited. A clinic’s own control group replaces them with measured outcomes.',
      'Without any contact, 10% to 60% of patients (by persona) complete an order on their own; urgent visits half as often. The same draw applies in both arms.',
      'Control arm: one generic reminder when the order is due and one 7 days later, under the same contact cap. No booking help, no calls, no way to send a result back.',
      'Agent arm: the order agent’s real policy code (the follow-up ladder, the urgent and wrong-number tracks, at most 2 proactive messages per 7 days, slots from the schedule). Patients’ replies come from the persona model, not from a language model.',
      'Reception completes 90% of the call tasks on their due day; clinic capacity is not a constraint.',
      'Once an order is booked the agent stops chasing it, as the agent does today: a no-show is not recovered.',
      '“Fulfilled” means the engine closed the order by day 90. A booking made in time closes a visit; it opens again when the date passes with no visit.',
      'Revenue counts only the extra attended consultations at the price you enter; lab and imaging revenue is not counted.',
    ],
  },
};

export const en = {
  metrics,
  value,
  common,
  nav,
  errors,
  time,
  labels,
  dismiss,
  validation,
  contact,
  suppressions,
  stats,
  evidence,
  why,
  caseActions,
  caseDetail,
  feedback,
  inbox,
  patientCard,
  planReview,
  adjudication,
  caseRow,
  patient,
  recovery,
  demo,
  consultation,
  extraction,
  review,
  engineTests,
  lab,
  evaluators,
  agent,
};
