import { describe, expect, it } from 'vitest';
import {
  ALL_RULE_IDS,
  BASE_DATE,
  dayToDate,
  type FhirResource,
  generateSyntheticClinic,
  type GoldNote,
  loadGoldNotes,
  loadScenarios,
  loadSyntheticClinic,
  noteTextOf,
  RULE_IDS,
  SPECIALTIES,
  validateFhirR4,
} from '../src/index.ts';
import { buildScenarios } from '../src/scenarios/definitions.ts';

const MS_PER_DAY = 86_400_000;
const clinic = loadSyntheticClinic();
const goldNotes = loadGoldNotes();
const scenarios = loadScenarios();

function resourcesOf(bundle: { readonly entry: readonly { readonly resource: FhirResource }[] }) {
  return bundle.entry.map((entry) => entry.resource);
}

/** JSON round trip, the way the fixtures are stored. */
const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe('synthetic clinic', () => {
  // About 4.5 s on an idle machine (2,268 bundles against the full R4
  // schema): past the 5 s default when the machine is busy, so 30 s.
  it('validates every bundle and directory resource against FHIR R4', { timeout: 30_000 }, () => {
    const invalid: string[] = [];
    for (const resource of [
      clinic.clinic.organization,
      ...clinic.clinic.practitioners,
      ...clinic.clinic.practitionerRoles,
    ]) {
      if (!validateFhirR4(resource).valid) invalid.push(`${resource.resourceType}/${resource.id}`);
    }
    for (const patient of clinic.patients) {
      for (const entry of patient.entries) {
        const result = validateFhirR4(entry.bundle);
        if (!result.valid)
          invalid.push(
            `${patient.patientId} ${entry.bundle.id}: ${JSON.stringify(result.issues[0])}`,
          );
      }
    }
    expect(invalid).toEqual([]);
  });

  it('has ~150 patients across the four specialties', () => {
    const bySpecialty = Object.fromEntries(
      SPECIALTIES.map((s) => [s, clinic.patients.filter((p) => p.specialty === s).length]),
    );
    expect(clinic.patients).toHaveLength(148);
    expect(bySpecialty).toEqual({
      diabetology: 35,
      internal_medicine: 43,
      psychology: 35,
      gynecology: 35,
    });
    expect(clinic.clinic.practitioners).toHaveLength(8);
    expect(clinic.clinic.stats.patients).toBe(148);
  });

  it('has patients for every protocol: dated pregnancies, deliveries, losses, dose changes, kidney labs', () => {
    const all = clinic.patients.flatMap((patient) =>
      patient.entries.flatMap((entry) =>
        resourcesOf(entry.bundle).map((resource) => ({ patient, entry, resource })),
      ),
    );
    const codeOf = (resource: FhirResource) =>
      (resource['code'] as { coding: { code: string }[] } | undefined)?.coding[0]?.code ?? '';
    const conditions = all.filter(({ resource }) => resource.resourceType === 'Condition');
    for (const prefix of ['O80', 'O82', 'O03', 'E03', 'E78', 'N18.3', 'N18.4', 'F32.1'])
      expect(
        conditions.some(({ resource }) => codeOf(resource).startsWith(prefix)),
        prefix,
      ).toBe(true);
    // A delivery the hospital reported: on the problem list, with no encounter.
    const reported = conditions.filter(({ entry }) => entry.kind === 'diagnosis');
    expect(reported.length).toBeGreaterThan(0);
    expect(reported.every(({ resource }) => resource['encounter'] === undefined)).toBe(true);
    // FUM and FPP as date-valued Observations.
    const dates = all.filter(({ resource }) => typeof resource['valueDateTime'] === 'string');
    expect(new Set(dates.map(({ resource }) => codeOf(resource)))).toEqual(
      new Set(['8665-2', '11778-8']),
    );
    // A dose change: the same drug prescribed at a different strength.
    const texts = new Set(
      all
        .filter(({ resource }) => resource.resourceType === 'MedicationRequest')
        .map(
          ({ resource }) =>
            (resource['medicationCodeableConcept'] as { text: string } | undefined)?.text,
        ),
    );
    for (const text of ['Sertralina 100 mg', 'Levotiroxina 75 mcg', 'Atorvastatina 40 mg'])
      expect(texts.has(text), text).toBe(true);
    // Kidney function and albuminuria results, and the OGTT.
    for (const loinc of ['62238-1', '9318-7', '1518-0'])
      expect(
        all.some(
          ({ resource }) => resource.resourceType === 'Observation' && codeOf(resource) === loinc,
        ),
        loinc,
      ).toBe(true);
  });

  it('covers two years of history ending at the base date, oldest first', () => {
    const start = BASE_DATE.getTime() - 730 * MS_PER_DAY;
    for (const patient of clinic.patients) {
      const times = patient.entries.map((entry) => Date.parse(entry.at));
      expect(times).toEqual([...times].sort((x, y) => x - y));
      expect(Math.min(...times)).toBeGreaterThanOrEqual(start);
      expect(Math.max(...times)).toBeLessThanOrEqual(BASE_DATE.getTime());
      expect(patient.entries.every((entry) => entry.at === entry.bundle.timestamp)).toBe(true);
    }
  });

  it('has about a quarter of notes without a plan', () => {
    const { consultations, notesWithoutPlan } = clinic.clinic.stats;
    expect(notesWithoutPlan / consultations).toBeGreaterThan(0.2);
    expect(notesWithoutPlan / consultations).toBeLessThan(0.32);
  });

  it('sends the Patient once, in the first consultation, and keeps ids unique and references resolvable', () => {
    const seen = new Set<string>();
    const practitioners = new Set(clinic.clinic.practitioners.map((p) => `Practitioner/${p.id}`));
    for (const patient of clinic.patients) {
      const patientBundles = patient.entries.filter((entry) =>
        resourcesOf(entry.bundle).some((r) => r.resourceType === 'Patient'),
      );
      expect(patientBundles.map((entry) => entry.kind)).toEqual(['consultation']);
      expect(patientBundles[0]).toBe(
        patient.entries.find((entry) => entry.kind === 'consultation'),
      );
      for (const entry of patient.entries) {
        for (const resource of resourcesOf(entry.bundle)) {
          const key = `${resource.resourceType}/${resource.id}`;
          // Appointments are re-sent when cancelled; everything else is sent once.
          if (resource.resourceType !== 'Appointment') expect(seen.has(key), key).toBe(false);
          seen.add(key);
          const json = JSON.stringify(resource);
          for (const [, ref] of json.matchAll(/"reference":"(Patient\/[^"]+)"/g))
            expect(ref).toBe(`Patient/${patient.patientId}`);
          for (const [, ref] of json.matchAll(/"reference":"(Practitioner\/[^"]+)"/g))
            expect(practitioners.has(ref ?? '')).toBe(true);
        }
      }
    }
  });

  it('writes notes as base64 UTF-8 text and keeps psychology notes free of crisis content', () => {
    const crisis =
      /suicid|autolesi|autoagres|ideaci[oó]n|crisis suicida|hospitaliz|muerte|morir|abuso|violencia/i;
    for (const patient of clinic.patients) {
      for (const entry of patient.entries) {
        for (const resource of resourcesOf(entry.bundle).filter(
          (r) => r.resourceType === 'DocumentReference',
        )) {
          const text = noteTextOf(resource);
          expect(text.length).toBeGreaterThan(20);
          if (patient.specialty === 'psychology') expect(text).not.toMatch(crisis);
        }
      }
    }
  });

  it('marks short treatments with expectedSupplyDuration only', () => {
    let short = 0;
    for (const patient of clinic.patients) {
      for (const entry of patient.entries) {
        for (const resource of resourcesOf(entry.bundle).filter(
          (r) => r.resourceType === 'MedicationRequest',
        )) {
          const supply = (
            resource['dispenseRequest'] as
              { expectedSupplyDuration?: { value: number } } | undefined
          )?.expectedSupplyDuration;
          if (supply) {
            short += 1;
            expect(supply.value).toBeLessThanOrEqual(14);
          }
        }
      }
    }
    expect(short).toBeGreaterThan(5);
  });

  it('records the allergy status of most patients, in a bundle of its own (HIP-139)', () => {
    const NO_KNOWN_ALLERGY = '716186003';
    const statuses = clinic.patients.map((patient) => {
      const allergies = patient.entries.filter((entry) => entry.kind === 'allergy');
      expect(allergies.length, patient.patientId).toBeLessThanOrEqual(1);
      const [entry] = allergies;
      if (entry === undefined) return 'none';
      // Its own bundle, after the first consultation sent the Patient.
      expect(entry.bundle.id).toBe(`${patient.patientId}-allergy01`);
      const first = patient.entries.find((item) => item.kind === 'consultation');
      expect(entry.at > (first?.at ?? '')).toBe(true);
      const resources = resourcesOf(entry.bundle);
      expect(resources.every((resource) => resource.resourceType === 'AllergyIntolerance')).toBe(
        true,
      );
      const codes = resources.map(
        (resource) =>
          (resource['code'] as { coding: { system: string; code: string }[] }).coding[0],
      );
      expect(codes.every((coding) => coding?.system === 'http://snomed.info/sct')).toBe(true);
      return codes.some((coding) => coding?.code === NO_KNOWN_ALLERGY) ? 'nka' : 'drug';
    });
    const count = (status: string) => statuses.filter((item) => item === status).length;
    expect(count('nka')).toBeGreaterThan(40);
    expect(count('drug')).toBeGreaterThan(10);
    // Not everyone: the reviewer still has records without an allergy status to find.
    expect(count('none')).toBeGreaterThan(20);
  });

  it('is in sync with its deterministic generator', () => {
    const generated = generateSyntheticClinic();
    expect(asJson(generated.clinic)).toEqual(clinic.clinic);
    expect(asJson(generated.patients)).toEqual(clinic.patients);
  });
});

describe('gold notes', () => {
  const bySpecialty = (specialty: string) =>
    goldNotes.filter((note) => note.specialty === specialty);
  const items = (note: GoldNote) => note.expected.planItems;

  it('has at least 15 English notes in US clinical style, every specialty included', () => {
    const english = goldNotes.filter((note) => note.language === 'en');
    expect(english.length).toBeGreaterThanOrEqual(15);
    expect(new Set(english.map((note) => note.specialty))).toEqual(new Set(SPECIALTIES));
    const texts = english.map((note) => note.text);
    for (const style of [/\bf\/u\b/i, /\bRTC\b/, /\bdenies\b/i, /d\/c'd/, /\bPRN\b/, /\bA1c\b/]) {
      expect(
        texts.some((text) => style.test(text)),
        String(style),
      ).toBe(true);
    }
  });

  it('has at least 40 notes, 10 per specialty, unique ids', () => {
    expect(goldNotes.length).toBeGreaterThanOrEqual(40);
    for (const specialty of SPECIALTIES)
      expect(bySpecialty(specialty).length).toBeGreaterThanOrEqual(10);
    expect(new Set(goldNotes.map((note) => note.id)).size).toBe(goldNotes.length);
  });

  it('every evidence quote is an exact substring of the note', () => {
    const missing: string[] = [];
    for (const note of goldNotes) {
      const quotes = [
        ...note.expected.conditions.map((c) => c.evidenceQuote),
        ...note.expected.medications.map((m) => m.evidenceQuote),
        ...note.expected.planItems.map((p) => p.evidenceQuote),
        ...(note.expected.discharge ? [note.expected.discharge.evidenceQuote] : []),
        ...(note.expected.pregnancy?.datingEvidenceQuote
          ? [note.expected.pregnancy.datingEvidenceQuote]
          : []),
        ...(note.expected.pregnancy?.outcome
          ? [note.expected.pregnancy.outcome.evidenceQuote]
          : []),
      ];
      for (const quote of quotes)
        if (!note.text.includes(quote)) missing.push(`${note.id}: "${quote}"`);
    }
    expect(missing).toEqual([]);
  });

  it('covers notes without a plan, multi-item plans, relative and absolute dates', () => {
    const noPlan = goldNotes.filter((note) => !note.expected.hasPlan);
    expect(noPlan.length).toBeGreaterThanOrEqual(8);
    expect(noPlan.every((note) => items(note).length === 0)).toBe(true);
    expect(goldNotes.filter((note) => items(note).length >= 2).length).toBeGreaterThanOrEqual(5);
    const quotes = goldNotes.flatMap(items).map((item) => item.evidenceQuote);
    expect(quotes.some((q) => /\d+\s*d[ií]as/i.test(q))).toBe(true);
    expect(quotes.some((q) => /\d+\s*(semanas?|sem)\b/i.test(q))).toBe(true);
    expect(quotes.some((q) => /\d+\s*mes(es)?/i.test(q))).toBe(true);
    expect(quotes.filter((q) => /\d{2}\/\d{2}\/\d{4}/.test(q)).length).toBeGreaterThanOrEqual(3);
  });

  it('covers the round-1 QA cases: discharge, negation, conditional phrasing, emoji, injection', () => {
    const texts = goldNotes.map((note) => note.text);
    expect(goldNotes.filter((note) => note.expected.discharge).length).toBeGreaterThanOrEqual(3);
    expect(texts.some((text) => /niega HTA y diabetes/i.test(text))).toBe(true);
    expect(texts.some((text) => /solo si|en caso de/i.test(text))).toBe(true);
    expect(texts.some((text) => /\p{Extended_Pictographic}/u.test(text))).toBe(true);
    expect(texts.some((text) => /<\/clinical_note>|IGNORA LAS INSTRUCCIONES/i.test(text))).toBe(
      true,
    );
  });

  it('labels pregnancy dating and outcomes, and the traps that are neither', () => {
    const pregnancy = goldNotes.flatMap((note) =>
      note.expected.pregnancy ? [note.expected.pregnancy] : [],
    );
    expect(new Set(pregnancy.flatMap((p) => (p.outcome ? [p.outcome.kind] : [])))).toEqual(
      new Set(['vaginal_delivery', 'cesarean_delivery', 'loss']),
    );
    expect(pregnancy.filter((p) => p.gestationalWeeks !== undefined).length).toBeGreaterThanOrEqual(
      3,
    );
    expect(pregnancy.some((p) => p.lastMenstrualPeriod !== undefined)).toBe(true);
    expect(pregnancy.some((p) => p.estimatedDeliveryDate !== undefined)).toBe(true);
    // A pregnancy that ended is not dated in the same note.
    expect(pregnancy.every((p) => !p.outcome || p.gestationalWeeks === undefined)).toBe(true);
    // Traps: a routine FUM and obstetric history ("cesárea previa") without a pregnancy label.
    const unlabeled = goldNotes.filter((note) => !note.expected.pregnancy).map((note) => note.text);
    expect(unlabeled.filter((text) => /\bFUM\b/.test(text)).length).toBeGreaterThanOrEqual(2);
    expect(unlabeled.some((text) => text.includes('cesárea previa'))).toBe(true);
  });

  it('resolves absolute dates in plan items against authoredAt', () => {
    for (const note of goldNotes) {
      for (const item of items(note)) {
        const match = /(\d{2})\/(\d{2})\/(\d{4})/.exec(item.evidenceQuote);
        if (!match) continue;
        // Spanish notes write dd/mm/yyyy, English (US) ones mm/dd/yyyy.
        const [, first, second, year] = match;
        const [day, month] = note.language === 'en' ? [second, first] : [first, second];
        const due = Date.UTC(Number(year), Number(month) - 1, Number(day));
        expect((due - Date.parse(`${note.authoredAt}T00:00:00Z`)) / MS_PER_DAY, note.id).toBe(
          item.dueInDays,
        );
      }
    }
  });
});

describe('scenarios', () => {
  const required = [
    'diabetic_6_months_no_plan',
    'diabetic_single_visit_plan_3_months',
    'lab_order_repeated_same_test',
    'lab_order_repeated_different_test',
    'psychology_monthly_dropout',
    'short_treatment_no_followup',
    'gynecology_postpartum_6_weeks',
    'postpartum_booked_resolves',
    'three_layers_one_case',
  ];

  it('has one parseable scenario per PRD acceptance case', () => {
    expect(scenarios.map((s) => s.name).sort()).toEqual([...required].sort());
  });

  it('validates every step against FHIR R4 and stamps it at BASE_DATE + day', () => {
    for (const scenario of scenarios) {
      for (const step of scenario.steps) {
        expect(
          validateFhirR4(step.bundle).issues,
          `${scenario.name} day ${String(step.day)}`,
        ).toEqual([]);
        expect(step.bundle.timestamp).toBe(dayToDate(step.day).toISOString());
      }
      const days = scenario.steps.map((step) => step.day);
      expect(days).toEqual([...days].sort((x, y) => x - y));
    }
  });

  it('has an LLM fixture for every note, with quotes taken from the note', () => {
    for (const scenario of scenarios) {
      const notes = scenario.steps
        .flatMap((step) => resourcesOf(step.bundle))
        .filter((r) => r.resourceType === 'DocumentReference');
      expect(Object.keys(scenario.llmFixture).sort()).toEqual(notes.map((n) => n.id).sort());
      for (const note of notes) {
        const text = noteTextOf(note);
        const extraction = scenario.llmFixture[note.id];
        if (!extraction) throw new Error(`missing fixture for ${note.id}`);
        const quotes = [
          ...extraction.conditions,
          ...extraction.medications,
          ...extraction.planItems,
        ].map((x) => x.evidenceQuote);
        for (const quote of quotes) expect(text, `${scenario.name}: "${quote}"`).toContain(quote);
        if (!extraction.hasPlan) expect(extraction.planItems).toEqual([]);
      }
    }
  });

  it('only refers to known rule ids and checks after the last relevant step', () => {
    const known = new Set<string>(ALL_RULE_IDS);
    expect(known.has(RULE_IDS.doctorPlanFollowup)).toBe(true);
    for (const scenario of scenarios) {
      for (const checkpoint of scenario.expect) {
        const ids = [
          ...(checkpoint.openExpectations ?? []).map((e) => e.ruleId),
          ...(checkpoint.absentRuleIds ?? []),
          ...(checkpoint.activeCases ?? []).flatMap((c) => c.reasons),
        ];
        for (const id of ids) expect(known.has(id), `${scenario.name}: ${id}`).toBe(true);
        // An expectation and its absence are never asserted together.
        const open = new Set((checkpoint.openExpectations ?? []).map((e) => e.ruleId));
        for (const absent of checkpoint.absentRuleIds ?? []) expect(open.has(absent)).toBe(false);
      }
    }
  });

  it('is in sync with the scenario definitions', () => {
    expect(asJson(buildScenarios())).toEqual(
      [...scenarios].sort((x, y) => required.indexOf(x.name) - required.indexOf(y.name)),
    );
  });
});
