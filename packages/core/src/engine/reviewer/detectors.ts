import type { FindingCategory, FindingSeverity } from '../../domain/clinical-finding.ts';
import type { SignalTopic, SignalView } from '../../ports/clinical-review-agent.ts';
import type { CitableDocument, MedicationEntry, NoteDocument, ReviewDossier } from './dossier.ts';
import { isoDay } from './dossier.ts';
import {
  ALLERGY_TERMS,
  classKeysOf,
  DRUG_CONDITION_RULES,
  INTERACTION_RULES,
  MEASUREMENTS,
  type MeasurementDefinition,
  NEGATIONS,
  PRE_VISIT_QUESTIONS,
  SCREENING_RULES,
  SYMPTOMS,
  WORKUP_TERMS,
} from './knowledge.ts';
import {
  findTerms,
  firstSentence,
  foldWithMap,
  isNegated,
  mentionsAny,
  sentenceAround,
  sentenceBounds,
} from './text.ts';
import { ckdEpi2021, formatValue, type TrendSummary } from './trends.ts';

const MS_PER_DAY = 86_400_000;

/**
 * A deterministic finding candidate: what code alone can see in the record,
 * with the exact evidence (document handles and verbatim quotes). The agent
 * confirms, merges or discards signals and may add findings of its own; a
 * signal is never stored unchecked.
 */
export interface Signal {
  readonly id: string;
  readonly category: FindingCategory;
  readonly severity: FindingSeverity;
  readonly summary: string;
  readonly rationale: string;
  readonly suggestion: string;
  readonly evidence: readonly { readonly handle: string; readonly quote: string }[];
  readonly topic?: SignalTopic;
  /** Which detector rule produced it (`lab_trend:creatinine`), for evals and logs. */
  readonly rule: string;
}

type SignalDraft = Omit<Signal, 'id'>;

const daysAgo = (dossier: ReviewDossier, days: number): number =>
  dossier.snapshot.now.getTime() - days * MS_PER_DAY;

function quoteOf(document: CitableDocument): { handle: string; quote: string } {
  return { handle: document.handle, quote: document.text };
}

function seriesText(trend: TrendSummary, count: number, decimals: number): string {
  return trend.points
    .slice(-count)
    .map((point) => formatValue(point.value, decimals))
    .join(' → ');
}

function measurementOf(trend: TrendSummary): MeasurementDefinition | undefined {
  return MEASUREMENTS.find((measurement) => measurement.key === trend.test);
}

/** A note after `since` that names the measurement: the doctor commented on it. */
function commentedAfter(
  dossier: ReviewDossier,
  measurement: MeasurementDefinition,
  since: Date,
): boolean {
  const terms = measurement.mentions.map((term) => term.trim());
  return dossier.notes.some(
    (note) => note.occurredAt >= since && findTerms(foldWithMap(note.text), terms).length > 0,
  );
}

// Lab trends ------------------------------------------------------------------------

function labTrends(dossier: ReviewDossier): SignalDraft[] {
  const signals: SignalDraft[] = [];
  for (const trend of dossier.trends) {
    const measurement = measurementOf(trend);
    if (measurement === undefined || trend.kind !== 'lab' || trend.points.length < 3) continue;
    if (trend.consecutiveWorsening < 2) continue;
    const run = trend.points.slice(-(trend.consecutiveWorsening + 1));
    const first = run[0];
    const last = run.at(-1);
    if (first === undefined || last === undefined || first.value === 0) continue;
    const change = ((last.value - first.value) / Math.abs(first.value)) * 100;
    if (Math.abs(change) < measurement.minChangePct) continue;
    if (!trend.latestOutOfRange && Math.abs(change) < 2 * measurement.minChangePct) continue;
    // A trend the doctor already wrote about is not silent.
    if (commentedAfter(dossier, measurement, run[1]?.at ?? first.at)) continue;
    const rising = change > 0;
    const severity: FindingSeverity =
      trend.latestOutOfRange && Math.abs(change) >= 2 * measurement.minChangePct
        ? 'high'
        : 'medium';
    const documents = run.flatMap((point) => {
      const document = dossier.documents.get(point.handle);
      return document === undefined ? [] : [quoteOf(document)];
    });
    signals.push({
      category: 'lab_trend',
      severity,
      ...dossier.copy.labTrend({
        label: trend.label,
        rising,
        count: run.length,
        series: seriesText(trend, run.length, measurement.decimals),
        unit: measurement.unit,
        changePct: change,
        from: isoDay(first.at),
        to: isoDay(last.at),
        outOfRange: trend.latestOutOfRange,
        renal: measurement.key === 'creatinine' || measurement.key === 'egfr',
      }),
      evidence: documents,
      topic: { test: measurement.key },
      rule: `lab_trend:${measurement.key}`,
    });
  }
  return signals;
}

// Vital trends ----------------------------------------------------------------------

function vitalTrends(dossier: ReviewDossier): SignalDraft[] {
  const signals: SignalDraft[] = [];
  for (const trend of dossier.trends) {
    const measurement = measurementOf(trend);
    if (measurement === undefined || trend.kind !== 'vital') continue;
    const recent = trend.points.filter((point) => point.at.getTime() >= daysAgo(dossier, 540));
    if (recent.length < 3 || trend.consecutiveWorsening < 2) continue;
    const run = recent.slice(-(Math.min(trend.consecutiveWorsening, recent.length - 1) + 1));
    const first = run[0];
    const last = run.at(-1);
    if (first === undefined || last === undefined || run.length < 3 || first.value === 0) continue;
    const delta = last.value - first.value;
    const change = (delta / first.value) * 100;
    let severity: FindingSeverity;
    if (measurement.key === 'weight') {
      if (Math.abs(change) < measurement.minChangePct) continue;
      severity = Math.abs(change) >= 10 ? 'medium' : 'low';
    } else if (measurement.key === 'systolic_bp') {
      if (!(last.value >= (measurement.high ?? 140) || delta >= 15)) continue;
      severity = last.value >= 160 ? 'high' : 'medium';
    } else {
      continue;
    }
    const documents = run.flatMap((point) => {
      const document = dossier.documents.get(point.handle);
      return document === undefined ? [] : [quoteOf(document)];
    });
    const values = run.map((point) => formatValue(point.value, measurement.decimals)).join(' → ');
    signals.push({
      category: 'vital_trend',
      severity,
      ...dossier.copy.vitalTrend({
        kind: measurement.key === 'weight' ? 'weight' : 'systolic',
        values,
        delta,
        changePct: change,
        count: run.length,
        from: isoDay(first.at),
        to: isoDay(last.at),
      }),
      evidence: documents,
      topic: { test: measurement.key },
      rule: `vital_trend:${measurement.key}`,
    });
  }
  return signals;
}

// Abnormal result without follow-up ----------------------------------------------------

function abnormalWithoutFollowUp(
  dossier: ReviewDossier,
  trended: ReadonlySet<string>,
): SignalDraft[] {
  const signals: SignalDraft[] = [];
  for (const trend of dossier.trends) {
    const measurement = measurementOf(trend);
    const latest = trend.points.at(-1);
    if (measurement === undefined || trend.kind !== 'lab' || latest === undefined) continue;
    if (trended.has(latest.handle)) continue;
    const high = measurement.high;
    const low = measurement.low;
    const markedlyHigh = high !== undefined && latest.value >= high * 1.25;
    const markedlyLow = low !== undefined && latest.value <= low * 0.75;
    if (!markedlyHigh && !markedlyLow) continue;
    const ageDays = (dossier.snapshot.now.getTime() - latest.at.getTime()) / MS_PER_DAY;
    if (ageDays < 14) continue;
    const visitedAfter = dossier.encounters.some((encounter) => encounter.occurredAt > latest.at);
    const commented = commentedAfter(dossier, measurement, latest.at);
    const bookedSoon =
      dossier.upcomingAppointmentAt !== undefined &&
      dossier.upcomingAppointmentAt.getTime() - dossier.snapshot.now.getTime() <= 30 * MS_PER_DAY;
    if (visitedAfter || commented || bookedSoon) continue;
    const document = dossier.documents.get(latest.handle);
    if (document === undefined) continue;
    const severe =
      (high !== undefined && latest.value >= high * 1.5) ||
      (low !== undefined && latest.value <= low * 0.5);
    signals.push({
      category: 'abnormal_result_no_followup',
      severity: severe || (measurement.key === 'hba1c' && latest.value >= 9) ? 'high' : 'medium',
      ...dossier.copy.abnormalResult({
        label: trend.label,
        value: formatValue(latest.value, measurement.decimals),
        unit: measurement.unit,
        date: isoDay(latest.at),
        high: markedlyHigh,
        threshold: String(markedlyHigh ? high : low),
        days: Math.round(ageDays),
      }),
      evidence: [quoteOf(document)],
      topic: { test: measurement.key },
      rule: `abnormal_result:${measurement.key}`,
    });
  }
  return signals;
}

// Medication safety ---------------------------------------------------------------------

function drugLabel(medication: MedicationEntry): string {
  return medication.name.split(/\s+\d/)[0]?.trim() ?? medication.name;
}

function drugInteractions(dossier: ReviewDossier): SignalDraft[] {
  const active = dossier.medications.filter((medication) => medication.active);
  const signals: SignalDraft[] = [];
  const reported = new Set<string>();
  for (const rule of INTERACTION_RULES) {
    const involved: MedicationEntry[] = [];
    let complete = true;
    for (const drugClass of rule.classes) {
      const candidates = active.filter((medication) => classKeysOf(medication.atc).has(drugClass));
      const match =
        candidates.find((medication) => !involved.includes(medication)) ?? candidates[0];
      if (match === undefined) {
        complete = false;
        break;
      }
      if (!involved.includes(match)) involved.push(match);
    }
    if (!complete) continue;
    const key = involved
      .map((medication) => medication.handle)
      .sort()
      .join('+');
    // A pair already reported inside a larger combination is not reported again.
    if (
      [...reported].some((done) => involved.every((medication) => done.includes(medication.handle)))
    ) {
      continue;
    }
    reported.add(key);
    const names = involved.map(drugLabel);
    const text = dossier.copy.interactions[rule.key];
    if (text === undefined) continue;
    signals.push({
      category: 'drug_interaction',
      severity: rule.severity,
      summary: dossier.copy.interactionSummary(names),
      rationale: text.risk,
      suggestion: text.suggestion,
      evidence: involved.flatMap((medication) => {
        const document = dossier.documents.get(medication.handle);
        return document === undefined ? [] : [quoteOf(document)];
      }),
      topic: { drugs: names },
      rule: `interaction:${rule.key}`,
    });
  }
  return signals;
}

/** The latest eGFR: measured, else estimated from the latest creatinine (CKD-EPI 2021). */
function latestEgfr(
  dossier: ReviewDossier,
): { value: number; document: CitableDocument; estimated: boolean } | undefined {
  const egfr = dossier.trends.find((trend) => trend.test === 'egfr')?.points.at(-1);
  const creatinine = dossier.trends.find((trend) => trend.test === 'creatinine')?.points.at(-1);
  if (egfr !== undefined && (creatinine === undefined || egfr.at >= creatinine.at)) {
    const document = dossier.documents.get(egfr.handle);
    return document === undefined ? undefined : { value: egfr.value, document, estimated: false };
  }
  if (creatinine === undefined || dossier.ageYears === undefined || dossier.female === undefined) {
    return undefined;
  }
  const document = dossier.documents.get(creatinine.handle);
  return document === undefined
    ? undefined
    : {
        value: ckdEpi2021(creatinine.value, dossier.ageYears, dossier.female),
        document,
        estimated: true,
      };
}

function conditionDocument(
  dossier: ReviewDossier,
  prefixes: readonly string[],
): CitableDocument | undefined {
  const condition = dossier.conditions.find(
    (entry) =>
      entry.handle !== undefined && prefixes.some((prefix) => entry.code.startsWith(prefix)),
  );
  return condition?.handle === undefined ? undefined : dossier.documents.get(condition.handle);
}

function hasCondition(dossier: ReviewDossier, prefixes: readonly string[]): boolean {
  return dossier.conditionCodes.some((code) => prefixes.some((prefix) => code.startsWith(prefix)));
}

function drugConditionConflicts(dossier: ReviewDossier): SignalDraft[] {
  const signals: SignalDraft[] = [];
  const egfr = latestEgfr(dossier);
  for (const medication of dossier.medications.filter((entry) => entry.active)) {
    const classes = classKeysOf(medication.atc);
    const rule = DRUG_CONDITION_RULES.find((candidate) => {
      if (!classes.has(candidate.drugClass)) return false;
      return candidate.trigger.kind === 'egfr_below'
        ? egfr !== undefined && egfr.value < candidate.trigger.threshold
        : hasCondition(dossier, candidate.trigger.icd10Prefixes);
    });
    if (rule === undefined) continue;
    const medicationDocument = dossier.documents.get(medication.handle);
    if (medicationDocument === undefined) continue;
    const text = dossier.copy.drugConditions[rule.key];
    if (text === undefined) continue;
    let context: CitableDocument | undefined;
    let because: string;
    if (rule.trigger.kind === 'egfr_below') {
      context = egfr?.document;
      because = dossier.copy.egfr(egfr?.value ?? 0, egfr?.estimated === true);
    } else {
      context = conditionDocument(dossier, rule.trigger.icd10Prefixes);
      because = dossier.copy.diagnosisOf(dossier.copy.conditionNames[rule.key] ?? '');
    }
    signals.push({
      category: 'drug_condition_conflict',
      severity: rule.severity,
      summary: dossier.copy.drugConditionSummary(drugLabel(medication), because),
      rationale: text.risk,
      suggestion: text.suggestion,
      evidence: [quoteOf(medicationDocument), ...(context === undefined ? [] : [quoteOf(context)])],
      topic: {
        drugs: [drugLabel(medication)],
        ...(rule.trigger.kind === 'egfr_below' && egfr !== undefined
          ? { test: egfr.estimated ? 'creatinine' : 'egfr' }
          : {}),
      },
      rule: `drug_condition:${rule.key}`,
    });
  }
  return signals;
}

// Symptoms -----------------------------------------------------------------------------------

interface Mention {
  readonly note: NoteDocument;
  readonly quote: string;
  readonly workedUp: boolean;
}

function mentionsOf(note: NoteDocument, terms: readonly string[]): Mention | undefined {
  const text = foldWithMap(note.text);
  for (const hit of findTerms(text, terms)) {
    if (isNegated(text, hit.start, NEGATIONS)) continue;
    const bounds = sentenceBounds(text, hit.start, hit.end);
    const sentence = text.folded.slice(bounds.start, bounds.end);
    return {
      note,
      quote: sentenceAround(text, hit.start, hit.end),
      workedUp: WORKUP_TERMS.some((term) => sentence.includes(term)),
    };
  }
  return undefined;
}

function unaddressedSymptoms(dossier: ReviewDossier): SignalDraft[] {
  const recent = dossier.notes.filter((note) => note.occurredAt.getTime() >= daysAgo(dossier, 365));
  const signals: SignalDraft[] = [];
  for (const symptom of SYMPTOMS) {
    const mentions = recent.flatMap((note) => {
      const mention = mentionsOf(note, symptom.terms);
      return mention === undefined ? [] : [mention];
    });
    const specialties = new Set(mentions.map((mention) => mention.note.specialty ?? 'unknown'));
    if (mentions.length < 3 && !(mentions.length >= 2 && specialties.size >= 2)) continue;
    if (mentions.some((mention) => mention.workedUp)) continue;
    const cited = mentions.slice(-3);
    const urgent = symptom.key === 'chest_pain' || symptom.key === 'dyspnea';
    const text = dossier.copy.symptoms[symptom.key];
    if (text === undefined) continue;
    const labels = [...specialties]
      .filter((specialty) => specialty !== 'unknown')
      .map((specialty) => dossier.copy.specialty(specialty));
    signals.push({
      category: 'unaddressed_symptom',
      severity: urgent ? 'high' : 'medium',
      ...dossier.copy.symptomFinding({
        label: text.label,
        count: mentions.length,
        specialties: labels,
        workup: text.workup,
      }),
      evidence: cited.map((mention) => ({ handle: mention.note.handle, quote: mention.quote })),
      // The search term the agent's `get_notes` uses: the note's own word.
      topic: { symptom: symptom.terms[0] ?? symptom.key },
      rule: `symptom:${symptom.key}`,
    });
  }
  return signals;
}

// Check-ups ------------------------------------------------------------------------------------

function isDiabetic(dossier: ReviewDossier): boolean {
  return (
    hasCondition(dossier, ['E10', 'E11', 'E13', 'E14']) ||
    dossier.medications.some((medication) => medication.atc?.startsWith('A10') === true)
  );
}

/** Evidence that the patient has a condition: its coded diagnosis, else a note that names it. */
function conditionEvidence(
  dossier: ReviewDossier,
  prefixes: readonly string[],
  noteTerms: readonly string[],
): { handle: string; quote: string } | undefined {
  const condition = conditionDocument(dossier, prefixes);
  if (condition !== undefined) return quoteOf(condition);
  for (const note of [...dossier.notes].reverse()) {
    const text = foldWithMap(note.text);
    const hit = findTerms(text, noteTerms)[0];
    if (hit !== undefined && !isNegated(text, hit.start, NEGATIONS)) {
      return { handle: note.handle, quote: sentenceAround(text, hit.start, hit.end) };
    }
  }
  const medication = dossier.medications.find((entry) => entry.atc?.startsWith('A10') === true);
  const document = medication === undefined ? undefined : dossier.documents.get(medication.handle);
  return document === undefined ? undefined : quoteOf(document);
}

const DIABETES_TERMS = ['diabetes', 'dm2', 'dm tipo 2', 'diabetes mellitus'];

function missingScreenings(dossier: ReviewDossier): SignalDraft[] {
  if (!isDiabetic(dossier)) return [];
  const lastNote = dossier.notes.at(-1);
  if (lastNote === undefined || lastNote.occurredAt.getTime() < daysAgo(dossier, 540)) return [];
  const evidence = conditionEvidence(dossier, ['E10', 'E11', 'E13', 'E14'], DIABETES_TERMS);
  if (evidence === undefined) return [];
  const signals: SignalDraft[] = [];
  for (const rule of SCREENING_RULES) {
    const since = daysAgo(dossier, rule.everyDays);
    const noted = dossier.notes.some(
      (note) =>
        note.occurredAt.getTime() >= since &&
        mentionsAny(foldWithMap(note.text).folded, rule.evidenceTerms),
    );
    const resulted = dossier.snapshot.events.some(
      (event) =>
        event.type === 'result.received' &&
        event.occurredAt.getTime() >= since &&
        (rule.resultLoinc ?? []).includes(event.code.code),
    );
    const ordered = dossier.orders.some(
      (order) =>
        order.occurredAt.getTime() >= since &&
        (mentionsAny(
          foldWithMap(`${order.code.display ?? ''} ${order.code.code}`).folded,
          rule.evidenceTerms,
        ) ||
          (rule.resultLoinc ?? []).includes(order.code.code) ||
          (rule.key === 'diabetic_fundus' && order.code.code === 'fundus-exam')),
    );
    if (noted || resulted || ordered) continue;
    const text = dossier.copy.screenings[rule.key];
    if (text === undefined) continue;
    signals.push({
      category: 'missing_screening',
      severity: rule.severity,
      ...dossier.copy.screeningFinding(
        text.label,
        Math.round(rule.everyDays / 30),
        text.suggestion,
      ),
      evidence: [evidence],
      rule: `screening:${rule.key}`,
    });
  }
  return signals;
}

// Record quality -----------------------------------------------------------------------------

function recordQuality(dossier: ReviewDossier): SignalDraft[] {
  const signals: SignalDraft[] = [];
  const active = dossier.medications.filter((medication) => medication.active);
  const allergiesRecorded = dossier.notes.some(
    (note) => findTerms(foldWithMap(note.text), ALLERGY_TERMS).length > 0,
  );
  const latestMedication = [...active]
    .sort((left, right) => left.lastPrescribedAt.getTime() - right.lastPrescribedAt.getTime())
    .at(-1);
  const medicationDocument =
    latestMedication === undefined ? undefined : dossier.documents.get(latestMedication.handle);
  // Prescribing without a documented allergy status: only when a prescription is recent.
  const prescribedRecently =
    latestMedication !== undefined &&
    latestMedication.lastPrescribedAt.getTime() >= daysAgo(dossier, 90);
  if (
    !allergiesRecorded &&
    prescribedRecently &&
    dossier.notes.length > 0 &&
    medicationDocument !== undefined
  ) {
    signals.push({
      category: 'record_quality',
      severity: 'low',
      ...dossier.copy.allergies(dossier.notes.length, active.length),
      evidence: [quoteOf(medicationDocument)],
      rule: 'record_quality:allergies',
    });
  }
  const uncoded = dossier.snapshot.conditions.find(
    (condition) =>
      condition.sourceType === 'extracted_from_note' &&
      (condition.status === 'confirmed' || condition.status === 'probable') &&
      condition.evidence !== undefined &&
      !dossier.snapshot.events.some(
        (event) =>
          event.type === 'condition.recorded' &&
          event.code.code.slice(0, 3) === condition.code.code.slice(0, 3),
      ),
  );
  const uncodedNote = dossier.notes.find(
    (note) => note.source.id === uncoded?.evidence?.sourceDocumentId,
  );
  if (uncoded?.evidence !== undefined && uncodedNote !== undefined) {
    signals.push({
      category: 'record_quality',
      severity: 'low',
      ...dossier.copy.uncodedDiagnosis(uncoded.code.display ?? uncoded.code.code),
      evidence: [{ handle: uncodedNote.handle, quote: uncoded.evidence.quote }],
      rule: 'record_quality:uncoded_diagnosis',
    });
  }
  return signals;
}

// Utilization ----------------------------------------------------------------------------------

function utilizationChange(dossier: ReviewDossier): SignalDraft[] {
  const windowStart = daysAgo(dossier, 90);
  const baselineStart = daysAgo(dossier, 90 + 365);
  const recent = dossier.encounters.filter(
    (encounter) => encounter.occurredAt.getTime() >= windowStart,
  );
  const baseline = dossier.encounters.filter(
    (encounter) =>
      encounter.occurredAt.getTime() >= baselineStart &&
      encounter.occurredAt.getTime() < windowStart,
  );
  const baselinePerQuarter = Math.max(baseline.length / 4, 0.5);
  if (recent.length < 4 || recent.length < 3 * baselinePerQuarter) return [];
  const notes = dossier.notes
    .filter((note) => note.occurredAt.getTime() >= windowStart)
    .slice(-3)
    .map((note) => ({ handle: note.handle, quote: firstSentence(note.text) }))
    .filter((item) => item.quote.trim().length >= 8);
  if (notes.length === 0) return [];
  return [
    {
      category: 'utilization_change',
      severity: 'medium',
      ...dossier.copy.utilization(recent.length, Math.round(baselinePerQuarter * 10) / 10),
      evidence: notes,
      rule: 'utilization:frequent_visits',
    },
  ];
}

// Questions for the next visit -----------------------------------------------------------------

/** A question is for the next visit: only while one is booked within this many days. */
const PRE_VISIT_HORIZON_DAYS = 60;

function preVisitQuestions(dossier: ReviewDossier): SignalDraft[] {
  const next = dossier.upcomingAppointmentAt;
  if (
    next === undefined ||
    next.getTime() - dossier.snapshot.now.getTime() > PRE_VISIT_HORIZON_DAYS * MS_PER_DAY
  ) {
    return [];
  }
  const signals: SignalDraft[] = [];
  for (const rule of PRE_VISIT_QUESTIONS) {
    let evidence: { handle: string; quote: string } | undefined;
    if (rule.icd10Prefixes !== undefined) {
      if (
        !hasCondition(dossier, rule.icd10Prefixes) &&
        !(rule.key === 'diabetic_neuropathy' && isDiabetic(dossier))
      ) {
        continue;
      }
      evidence = conditionEvidence(dossier, rule.icd10Prefixes, DIABETES_TERMS);
    } else if (rule.drugClass !== undefined) {
      const medication = dossier.medications.find(
        (entry) => entry.active && classKeysOf(entry.atc).has(rule.drugClass ?? ''),
      );
      const document =
        medication === undefined ? undefined : dossier.documents.get(medication.handle);
      evidence = document === undefined ? undefined : quoteOf(document);
    }
    if (evidence === undefined) continue;
    const since = daysAgo(dossier, rule.withinDays);
    const answered = dossier.notes.some(
      (note) =>
        note.occurredAt.getTime() >= since &&
        mentionsAny(foldWithMap(note.text).folded, rule.answeredBy),
    );
    if (answered) continue;
    const text = dossier.copy.questions[rule.key];
    if (text === undefined) continue;
    signals.push({
      category: 'pre_visit_question',
      severity: 'low',
      summary: text.question,
      rationale: text.rationale,
      suggestion: dossier.copy.questionSuggestion,
      evidence: [evidence],
      rule: `question:${rule.key}`,
    });
  }
  return signals.slice(0, 2);
}

/**
 * Runs every detector over a dossier. Signals come in a stable order with
 * ids `S1`, `S2`, ... (what the agent refers to). Only the categories
 * `enabled` returns true for are produced.
 */
export function detectSignals(
  dossier: ReviewDossier,
  enabled: (category: FindingCategory) => boolean = () => true,
): Signal[] {
  const trends = labTrends(dossier);
  const trended = new Set(trends.flatMap((signal) => signal.evidence.map((item) => item.handle)));
  const drafts: SignalDraft[] = [
    ...trends,
    ...abnormalWithoutFollowUp(dossier, trended),
    ...vitalTrends(dossier),
    ...drugInteractions(dossier),
    ...drugConditionConflicts(dossier),
    ...unaddressedSymptoms(dossier),
    ...missingScreenings(dossier),
    ...recordQuality(dossier),
    ...utilizationChange(dossier),
    ...preVisitQuestions(dossier),
  ];
  return drafts
    .filter((draft) => draft.evidence.length > 0 && enabled(draft.category))
    .map((draft, index) => ({ ...draft, id: `S${String(index + 1)}` }));
}

/** A signal as the model sees it. */
export function signalView(signal: Signal): SignalView {
  return {
    id: signal.id,
    category: signal.category,
    severity: signal.severity,
    summary: signal.summary,
    rationale: signal.rationale,
    suggestion: signal.suggestion,
    evidence: signal.evidence.map((item) => ({ docId: item.handle, quote: item.quote })),
    ...(signal.topic === undefined ? {} : { topic: signal.topic }),
  };
}
