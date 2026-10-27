/**
 * English UI catalog: the source of truth for every word the inbox writes.
 * `es.ts` must provide the same keys with the same parameters (a missing or
 * misnamed key is a type error). Clinical content (notes, quotes, patient
 * and drug names) never goes through a catalog: it is shown as written.
 *
 * Add a key here first, then in `es.ts`, then read it with `useT()`
 * (components) or `messages()` (code outside React).
 */

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
  backToInbox: 'Back to the inbox',
  goToInbox: 'Go to the inbox',
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
};

const nav = {
  inbox: 'Inbox',
  recovery: 'To recover',
  review: 'Clinical review',
  reviewShort: 'Review',
  demo: 'Demo',
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
  priorities: { urgente: 'Urgent', alta: 'High', media: 'Medium', baja: 'Low' },
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
    'Patients with something pending, sorted by priority. Each case gathers a patient’s reasons for one kind of follow-up: a patient with pending items of different kinds shows up in more than one case.',
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
  noMatches: (search: string): string => `No cases of patients matching “${search}” in this view.`,
  noOwnerCases: (owner: string): string => `No cases of ${owner} in this view.`,
  thisOwner: 'this owner',
  cases: 'Cases',
  searchLabel: 'Search patient',
  searchPlaceholder: 'Search patient by name',
  clearSearch: 'Clear search',
  ownerLabel: 'Owner',
  allOwners: 'All owners',
  loading: 'Loading cases',
  error: 'We could not load the cases',
  showing: (shown: number, total: number): string =>
    `Showing ${String(shown)} of ${count(total, 'case', 'cases')}`,
  loadMore: 'Load more cases',
  selectTitle: 'Choose a case from the list',
  selectBody:
    'You will see all the patient’s reasons, the quoted evidence from the note and the suggested next step.',
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
    traceTitle: 'How it got here',
    traceToggle: 'See the steps',
    traceFacts: {
      steps: 'Steps',
      toolCalls: 'Tool calls',
      cost: 'Cost',
      model: 'Model',
      stop: 'Ending',
      signals: 'Rule signals',
    },
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
  preVisit: {
    title: 'To ask at the next visit',
    suggestedOn: (date: string): string => `Suggested by the clinical reviewer on ${date}`,
  },
};

export const en = {
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
  caseActions,
  caseDetail,
  feedback,
  inbox,
  caseRow,
  patient,
  recovery,
  demo,
  consultation,
  extraction,
  review,
};
