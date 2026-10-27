import { FakeNoteExtractor } from '@follow-up-engine/adapter-memory';
import {
  ACTIVE_CASE_STATUSES,
  type Expectation,
  type FollowUpCase,
  type NoteExtraction,
  patientId as toPatientId,
  type PatientId,
  type QualityFinding,
} from '@follow-up-engine/core';
import {
  BASE_DATE,
  type CaseAssertion,
  dayToDate,
  type ExpectationAssertion,
  type LlmFixtureExtraction,
  type Scenario,
  type ScenarioCheckpoint,
} from '@follow-up-engine/testkit';
import { type EngineHarness, ingestBundle } from './harness.ts';

const MS_PER_DAY = 86_400_000;

/** The `NoteExtraction` a scenario's fake LLM returns, with dates revived. */
export function toNoteExtraction(fixture: LlmFixtureExtraction): NoteExtraction {
  return {
    ...fixture,
    planItems: fixture.planItems.map((item) => ({ ...item, dueAt: new Date(item.dueAt) })),
  };
}

/** A fake extractor that answers every note of the scenario with its `llmFixture`. */
export function scenarioExtractor(scenario: Scenario): FakeNoteExtractor {
  const extractor = new FakeNoteExtractor({ model: 'fixture', promptVersion: 'fixture' });
  for (const [documentId, fixture] of Object.entries(scenario.llmFixture)) {
    extractor.setExtraction(documentId, toNoteExtraction(fixture));
  }
  return extractor;
}

/** Whole days from the base date (scenarios compare due dates at day granularity). */
export function dayOf(instant: Date): number {
  return Math.floor((instant.getTime() - BASE_DATE.getTime()) / MS_PER_DAY);
}

/** What the engine holds for one patient, as the checkpoints see it. */
export interface PatientSnapshot {
  readonly expectations: readonly Expectation[];
  readonly cases: readonly (FollowUpCase & { readonly ruleIds: readonly string[] })[];
  readonly findings: readonly QualityFinding[];
}

export async function snapshotPatient(
  harness: EngineHarness,
  patient: PatientId,
): Promise<PatientSnapshot> {
  return harness.read(async (stores) => {
    const expectations = await stores.expectations.listByPatient(harness.clinicId, patient);
    const byId = new Map(expectations.map((expectation) => [expectation.id, expectation]));
    const page = await stores.cases.list(harness.clinicId, { patientId: patient, limit: 1000 });
    const findings = await stores.qualityFindings.listByPatient(harness.clinicId, patient);
    return {
      expectations,
      cases: page.items.map((followUpCase) => ({
        ...followUpCase,
        ruleIds: followUpCase.reasons.map(
          (reason) => byId.get(reason.expectationId)?.ruleId ?? reason.reasonCode,
        ),
      })),
      findings,
    };
  });
}

function matches(expectation: Expectation, assertion: ExpectationAssertion): boolean {
  return (
    expectation.ruleId === assertion.ruleId &&
    (assertion.matchKey === undefined || expectation.matchKey === assertion.matchKey) &&
    (assertion.dueDay === undefined || dayOf(expectation.dueAt) === assertion.dueDay)
  );
}

function describeExpectation(expectation: Expectation): string {
  return `${expectation.ruleId}[${expectation.matchKey}] due day ${String(dayOf(expectation.dueAt))} ${expectation.status}`;
}

/** Assigns each assertion a distinct case that has all its reasons. */
function assignCases(
  assertions: readonly CaseAssertion[],
  cases: PatientSnapshot['cases'],
): boolean {
  const used = new Set<string>();
  return assertions.every((assertion) => {
    const found = cases.find(
      (candidate) =>
        !used.has(candidate.id) &&
        assertion.reasons.every((ruleId) => candidate.ruleIds.includes(ruleId)) &&
        (assertion.resolution === undefined || candidate.resolution?.kind === assertion.resolution),
    );
    if (found !== undefined) {
      used.add(found.id);
    }
    return found !== undefined;
  });
}

/** Every way the snapshot breaks the checkpoint (empty when it holds). */
export function checkCheckpoint(
  checkpoint: ScenarioCheckpoint,
  snapshot: PatientSnapshot,
): string[] {
  const failures: string[] = [];
  const at = `day ${String(checkpoint.day)}`;
  const open = snapshot.expectations.filter((expectation) => expectation.status === 'open');
  const constrained = new Set([
    ...(checkpoint.openExpectations ?? []).map((assertion) => assertion.ruleId),
    ...(checkpoint.absentRuleIds ?? []),
  ]);
  for (const ruleId of constrained) {
    const expected = (checkpoint.openExpectations ?? []).filter(
      (assertion) => assertion.ruleId === ruleId,
    );
    const actual = open.filter((expectation) => expectation.ruleId === ruleId);
    const remaining = [...actual];
    const unmatched = expected.filter((assertion) => {
      const index = remaining.findIndex((expectation) => matches(expectation, assertion));
      if (index === -1) {
        return true;
      }
      remaining.splice(index, 1);
      return false;
    });
    if (unmatched.length > 0 || remaining.length > 0) {
      failures.push(
        `${at}: open ${ruleId} expected ${JSON.stringify(expected)}, found [${actual.map(describeExpectation).join('; ')}]`,
      );
    }
  }
  for (const assertion of checkpoint.closedExpectations ?? []) {
    const found = snapshot.expectations.some(
      (expectation) => expectation.status === assertion.status && matches(expectation, assertion),
    );
    if (!found) {
      failures.push(
        `${at}: no ${assertion.status} expectation ${JSON.stringify(assertion)} in [${snapshot.expectations.map(describeExpectation).join('; ')}]`,
      );
    }
  }
  const active = snapshot.cases.filter((followUpCase) =>
    (ACTIVE_CASE_STATUSES as readonly string[]).includes(followUpCase.status),
  );
  const describeCases = (cases: PatientSnapshot['cases']) =>
    cases.map((c) => `${c.status}[${c.ruleIds.join(',')}]`).join('; ');
  if (checkpoint.activeCases !== undefined) {
    if (
      active.length !== checkpoint.activeCases.length ||
      !assignCases(checkpoint.activeCases, active)
    ) {
      failures.push(
        `${at}: active cases expected ${JSON.stringify(checkpoint.activeCases)}, found [${describeCases(active)}]`,
      );
    }
  }
  if (checkpoint.resolvedCases !== undefined) {
    const resolved = snapshot.cases.filter((followUpCase) => followUpCase.status === 'resolved');
    if (!assignCases(checkpoint.resolvedCases, resolved)) {
      failures.push(
        `${at}: resolved cases expected ${JSON.stringify(checkpoint.resolvedCases)}, found [${describeCases(resolved)}]`,
      );
    }
  }
  if (checkpoint.qualityFindings !== undefined) {
    const kinds = snapshot.findings.map((finding) => finding.kind).sort();
    if (JSON.stringify(kinds) !== JSON.stringify([...checkpoint.qualityFindings].sort())) {
      failures.push(
        `${at}: quality findings expected ${JSON.stringify(checkpoint.qualityFindings)}, found ${JSON.stringify(kinds)}`,
      );
    }
  }
  return failures;
}

/**
 * Replays a scenario day by day, like production: each day the clock moves
 * to `BASE_DATE + day`, that day's bundles go through FHIR mapping and
 * `ingest`, then the watcher and the escalation sweep run; checkpoints are
 * checked at the end of their day.
 *
 * @returns every checkpoint failure (empty when the scenario holds).
 */
export async function runScenario(harness: EngineHarness, scenario: Scenario): Promise<string[]> {
  const patient = toPatientId(scenario.patientId);
  const lastDay = Math.max(
    ...scenario.steps.map((step) => step.day),
    ...scenario.expect.map((checkpoint) => checkpoint.day),
  );
  const failures: string[] = [];
  for (let day = 0; day <= lastDay; day += 1) {
    const now = dayToDate(day);
    harness.clock.set(now);
    for (const step of scenario.steps.filter((candidate) => candidate.day === day)) {
      await ingestBundle(harness, step.bundle, now);
    }
    await harness.engine.runWatcher(harness.clinicId, now);
    await harness.engine.runEscalation(harness.clinicId, now);
    for (const checkpoint of scenario.expect.filter((candidate) => candidate.day === day)) {
      failures.push(...checkCheckpoint(checkpoint, await snapshotPatient(harness, patient)));
    }
  }
  return failures;
}
