import {
  ACTIVE_CASE_STATUSES,
  type CaseEvent,
  type CaseStatus,
  type ClinicalBatch,
  type ClinicalEvent,
  clinicId as toClinicId,
  type ClinicId,
  type DomainEvent,
  type ClinicSettings,
  type EngineSettings,
  type EscalationReport,
  type Expectation,
  type ExpectationLayer,
  type ExpectationStatus,
  FakeClock,
  type FollowUpCase,
  type IngestReport,
  patientId as toPatientId,
  type PatientId,
  type WatcherReport,
} from '@follow-up-engine/core';
import { FakeNoteExtractor } from '../fake-note-extractor.ts';
import { createMemoryEngine, demoClinic, type MemoryEngine } from '../memory-adapters.ts';
import { batchOf, consultation, type ConsultationSpec, type EventContext } from './events.ts';

/** Day 0 of every scenario (shared with the testkit fixtures). */
export const SCENARIO_BASE_DATE = new Date('2026-01-05T12:00:00.000Z');
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/** A failed scenario expectation, naming the step and showing what was found. */
export class ScenarioAssertionError extends Error {
  override readonly name = 'ScenarioAssertionError';
}

export interface ScenarioOptions {
  readonly clinicId?: string;
  readonly patientId?: string;
  readonly allowPatientContact?: boolean;
  readonly settings?: Partial<EngineSettings>;
  readonly extractor?: FakeNoteExtractor;
  /** More clinic settings (the adjudicator's, for example). */
  readonly clinicSettings?: Partial<ClinicSettings>;
}

/** Matches an active case. `reasons` are rule ids, order-insensitive. */
export interface CaseMatcher {
  readonly reasons?: readonly string[];
  readonly status?: CaseStatus;
  readonly assignee?: string;
  readonly minPriority?: number;
}

export interface ExpectationMatcher {
  readonly ruleId: string;
  readonly matchKey?: string;
  readonly layer?: ExpectationLayer;
  readonly status?: ExpectationStatus;
  /** Due on this scenario day (whole days from the base date). */
  readonly dueDay?: number;
}

/** The running scenario: the engine, its clock, and helpers to look at the state. */
export class ScenarioWorld {
  readonly harness: MemoryEngine;
  readonly clock: FakeClock;
  readonly clinicId: ClinicId;
  readonly patientId: PatientId;
  lastIngest?: IngestReport;
  lastWatcher?: WatcherReport;
  lastEscalation?: EscalationReport;

  constructor(harness: MemoryEngine, clock: FakeClock, clinicId: ClinicId, patientId: PatientId) {
    this.harness = harness;
    this.clock = clock;
    this.clinicId = clinicId;
    this.patientId = patientId;
  }

  get engine(): MemoryEngine['engine'] {
    return this.harness.engine;
  }

  /** Days elapsed since {@link SCENARIO_BASE_DATE}. */
  get day(): number {
    return (this.clock.now().getTime() - SCENARIO_BASE_DATE.getTime()) / MS_PER_DAY;
  }

  dayAt(day: number): Date {
    return new Date(SCENARIO_BASE_DATE.getTime() + day * MS_PER_DAY);
  }

  context(patient: string = this.patientId): EventContext {
    return { clinicId: this.clinicId, patientId: toPatientId(patient), at: this.clock.now() };
  }

  async cases(patient: string = this.patientId): Promise<readonly FollowUpCase[]> {
    const page = await this.harness.stores.cases.list(this.clinicId, {
      patientId: toPatientId(patient),
      limit: 1_000,
      orderBy: 'created_at',
    });
    return page.items;
  }

  async activeCases(patient: string = this.patientId): Promise<readonly FollowUpCase[]> {
    const statuses: readonly CaseStatus[] = ACTIVE_CASE_STATUSES;
    return (await this.cases(patient)).filter((followUpCase) =>
      statuses.includes(followUpCase.status),
    );
  }

  expectations(patient: string = this.patientId): readonly Expectation[] {
    return this.harness.stores.expectations
      .listAll(this.clinicId)
      .filter((expectation) => expectation.patientId === patient);
  }

  outbox(): readonly DomainEvent[] {
    return this.harness.stores.outbox.list(this.clinicId);
  }

  audit(caseId: FollowUpCase['id']): Promise<readonly CaseEvent[]> {
    return this.harness.stores.audit.listForCase(this.clinicId, caseId);
  }
}

interface Step {
  readonly label: string;
  readonly run: (world: ScenarioWorld) => Promise<void>;
}

function parseDuration(duration: number | string): number {
  if (typeof duration === 'number') {
    return duration * MS_PER_DAY;
  }
  const match = /^(\d+(?:\.\d+)?)([dhw])$/u.exec(duration);
  if (match === null) {
    throw new Error(`Invalid duration "${duration}": use a number of days or "16d", "2w", "12h"`);
  }
  const amount = Number(match[1]);
  const unit = match[2] === 'h' ? MS_PER_HOUR : match[2] === 'w' ? 7 * MS_PER_DAY : MS_PER_DAY;
  return amount * unit;
}

function describeCase(followUpCase: FollowUpCase): string {
  return `${followUpCase.id} [${followUpCase.status}] reasons=${followUpCase.reasons
    .map((reason) => reason.reasonCode)
    .join(',')} priority=${String(followUpCase.priority)} assignee=${followUpCase.assignee ?? '-'}`;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index])
  );
}

function caseMatches(followUpCase: FollowUpCase, matcher: CaseMatcher): boolean {
  return (
    (matcher.reasons === undefined ||
      sameSet(
        followUpCase.reasons.map((reason) => reason.reasonCode),
        matcher.reasons,
      )) &&
    (matcher.status === undefined || followUpCase.status === matcher.status) &&
    (matcher.assignee === undefined || followUpCase.assignee === matcher.assignee) &&
    (matcher.minPriority === undefined || followUpCase.priority >= matcher.minPriority)
  );
}

function expectationMatches(
  expectation: Expectation,
  matcher: ExpectationMatcher,
  world: ScenarioWorld,
): boolean {
  return (
    expectation.ruleId === matcher.ruleId &&
    (matcher.matchKey === undefined || expectation.matchKey === matcher.matchKey) &&
    (matcher.layer === undefined || expectation.layer === matcher.layer) &&
    (matcher.dueDay === undefined ||
      Math.floor((expectation.dueAt.getTime() - world.dayAt(0).getTime()) / MS_PER_DAY) ===
        matcher.dueDay)
  );
}

/** Pairs each matcher with a distinct item; returns the matchers left unmatched. */
function unmatched<TItem, TMatcher>(
  items: readonly TItem[],
  matchers: readonly TMatcher[],
  matches: (item: TItem, matcher: TMatcher) => boolean,
): TMatcher[] {
  const used = new Set<number>();
  return matchers.filter((matcher) => {
    const index = items.findIndex(
      (item, position) => !used.has(position) && matches(item, matcher),
    );
    if (index === -1) {
      return true;
    }
    used.add(index);
    return false;
  });
}

/**
 * A readable, deterministic scenario over the in-memory engine and a fake
 * clock. Steps are queued and run in order by {@link Scenario.run}.
 *
 * @example
 * ```ts
 * await scenario()
 *   .at(0).consult({ encounterId: 'enc-1', labs: [{ id: 'sr-1', code: CODES.hba1c }] })
 *   .advance('16d').runWatcher()
 *   .expectCases([{ reasons: ['lab_order_result_pending'] }])
 *   .run();
 * ```
 */
export class Scenario {
  readonly #options: ScenarioOptions;
  readonly #steps: Step[] = [];

  constructor(options: ScenarioOptions = {}) {
    this.#options = options;
  }

  #push(label: string, run: (world: ScenarioWorld) => Promise<void>): this {
    this.#steps.push({ label, run });
    return this;
  }

  /** Moves the clock to `day` days after the base date (forwards or backwards). */
  at(day: number): this {
    return this.#push(`at day ${String(day)}`, (world) => {
      world.clock.set(world.dayAt(day));
      return Promise.resolve();
    });
  }

  /** Moves the clock forward: a number of days, or `"16d"`, `"2w"`, `"12h"`. */
  advance(duration: number | string): this {
    const ms = parseDuration(duration);
    return this.#push(`advance ${String(duration)}`, (world) => {
      world.clock.advance({ milliseconds: ms });
      return Promise.resolve();
    });
  }

  /** Ingests a batch (or events of the scenario patient) built at the current time. */
  ingest(build: (world: ScenarioWorld) => ClinicalBatch | readonly ClinicalEvent[]): this {
    return this.#push('ingest', async (world) => {
      const built = build(world);
      const batch = Array.isArray(built)
        ? batchOf(world.context(), built as readonly ClinicalEvent[])
        : (built as ClinicalBatch);
      world.lastIngest = await world.engine.ingest(batch);
    });
  }

  /** Ingests a consultation of the scenario patient (or `patient`) at the current time. */
  consult(
    spec: ConsultationSpec | ((world: ScenarioWorld) => ConsultationSpec),
    patient?: string,
  ): this {
    return this.#push(`consult`, async (world) => {
      const resolved = typeof spec === 'function' ? spec(world) : spec;
      world.lastIngest = await world.engine.ingest(consultation(world.context(patient), resolved));
    });
  }

  runWatcher(): this {
    return this.#push('runWatcher', async (world) => {
      world.lastWatcher = await world.engine.runWatcher(world.clinicId, world.clock.now());
    });
  }

  runEscalation(): this {
    return this.#push('runEscalation', async (world) => {
      world.lastEscalation = await world.engine.runEscalation(world.clinicId, world.clock.now());
    });
  }

  /** Runs the watcher and escalation once a day for `days` days, like the worker's cron. */
  daily(days: number): this {
    return this.#push(`daily x${String(days)}`, async (world) => {
      for (let index = 0; index < days; index += 1) {
        world.clock.advance({ days: 1 });
        world.lastWatcher = await world.engine.runWatcher(world.clinicId, world.clock.now());
        world.lastEscalation = await world.engine.runEscalation(world.clinicId, world.clock.now());
      }
    });
  }

  /** Any action on the world (case commands, extractor setup, ...). */
  act(label: string, run: (world: ScenarioWorld) => Promise<void> | void): this {
    return this.#push(label, async (world) => {
      await run(world);
    });
  }

  /** Exactly these active cases for the patient (default: the scenario patient). */
  expectCases(matchers: readonly CaseMatcher[], patient?: string): this {
    return this.#push(`expectCases(${String(matchers.length)})`, async (world) => {
      const active = await world.activeCases(patient);
      const missing = unmatched(active, matchers, caseMatches);
      if (active.length !== matchers.length || missing.length > 0) {
        throw new ScenarioAssertionError(
          `expected ${String(matchers.length)} active case(s) ${JSON.stringify(matchers)}, found ${String(
            active.length,
          )}:\n${active.map(describeCase).join('\n') || '(none)'}`,
        );
      }
    });
  }

  expectNoCases(patient?: string): this {
    return this.expectCases([], patient);
  }

  /** Exactly these open expectations for the patient (default: the scenario patient). */
  expectOpenExpectations(matchers: readonly ExpectationMatcher[], patient?: string): this {
    return this.#push(`expectOpenExpectations(${String(matchers.length)})`, (world) => {
      const open = world
        .expectations(patient)
        .filter((expectation) => expectation.status === 'open');
      const missing = unmatched(open, matchers, (expectation, matcher) =>
        expectationMatches(expectation, matcher, world),
      );
      if (open.length !== matchers.length || missing.length > 0) {
        throw new ScenarioAssertionError(
          `expected open expectations ${JSON.stringify(matchers)}, found:\n${
            open
              .map(
                (expectation) =>
                  `${expectation.ruleId} ${expectation.matchKey} due ${expectation.dueAt.toISOString()} (${expectation.layer})`,
              )
              .join('\n') || '(none)'
          }`,
        );
      }
      return Promise.resolve();
    });
  }

  /** How many outbound events of each type exist so far (types not listed are not checked). */
  expectOutbox(counts: Readonly<Partial<Record<DomainEvent['type'], number>>>): this {
    return this.#push(`expectOutbox`, (world) => {
      const actual = new Map<string, number>();
      for (const event of world.outbox()) {
        actual.set(event.type, (actual.get(event.type) ?? 0) + 1);
      }
      for (const [type, count] of Object.entries(counts)) {
        if ((actual.get(type) ?? 0) !== count) {
          throw new ScenarioAssertionError(
            `expected ${String(count)} "${type}" outbox event(s), found ${String(actual.get(type) ?? 0)}`,
          );
        }
      }
      return Promise.resolve();
    });
  }

  /** Free-form assertions (use vitest's `expect` inside). */
  check(run: (world: ScenarioWorld) => Promise<void> | void): this {
    return this.act('check', run);
  }

  /** Runs every step in order. Errors name the failing step. */
  async run(): Promise<ScenarioWorld> {
    const world = createWorld(this.#options);
    for (const [index, step] of this.#steps.entries()) {
      try {
        await step.run(world);
      } catch (error) {
        const where = `step ${String(index + 1)} "${step.label}" at day ${world.day.toFixed(2)}`;
        if (error instanceof Error) {
          error.message = `${where}: ${error.message}`;
        }
        throw error;
      }
    }
    return world;
  }
}

function createWorld(options: ScenarioOptions): ScenarioWorld {
  const clock = new FakeClock(SCENARIO_BASE_DATE);
  const clinicId = toClinicId(options.clinicId ?? 'clinic-demo');
  const harness = createMemoryEngine({
    clock,
    clinics: [
      demoClinic(clinicId, {
        allowPatientContact: options.allowPatientContact ?? false,
        ...options.clinicSettings,
      }),
    ],
    extractor: options.extractor ?? new FakeNoteExtractor(),
    ...(options.settings === undefined ? {} : { settings: options.settings }),
  });
  return new ScenarioWorld(harness, clock, clinicId, toPatientId(options.patientId ?? 'pat-1'));
}

/** Narrows away `undefined` in tests, failing with a clear message. */
export function defined<TValue>(value: TValue | undefined, what = 'value'): TValue {
  if (value === undefined) {
    throw new ScenarioAssertionError(`expected ${what} to be defined`);
  }
  return value;
}

/** Starts a scenario. */
export function scenario(options?: ScenarioOptions): Scenario {
  return new Scenario(options);
}
