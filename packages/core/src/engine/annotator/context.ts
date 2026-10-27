import type { ClinicalEvent } from '../../domain/clinical-event.ts';
import type { Origin } from '../../domain/common.ts';
import type { Expectation } from '../../domain/expectation.ts';
import type { ClinicId, PatientId } from '../../domain/ids.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { TransactionalStores } from '../../ports/unit-of-work.ts';
import type { Catalog } from '../catalog.ts';
import type { EngineSettings } from '../settings.ts';
import type { ExtractedMedicationHint } from './conditions.ts';

/** Everything one annotation run needs, bound to an open transaction. */
export interface AnnotationContext {
  readonly clinicId: ClinicId;
  readonly patientId: PatientId;
  readonly stores: TransactionalStores;
  readonly catalog: Catalog;
  readonly ids: IdGenerator;
  readonly settings: EngineSettings;
  readonly now: Date;
  /** Origin of what the run creates: `live` traffic (default) or the initial `backfill`. */
  readonly origin?: Origin;
  /** Replay mode: the patient's timeline only holds events up to this instant. */
  readonly asOf?: Date;
}

/** Side inputs that only exist when the batch came with a freshly read note. */
export interface AnnotationHints {
  /** Model confidence of note-extracted `condition.recorded` events, by idempotency key. */
  readonly extractedConfidence?: ReadonlyMap<string, number>;
  readonly extractedMedications?: readonly ExtractedMedicationHint[];
}

/** An expectation the run closed, and why. */
export interface ClosedExpectation {
  readonly expectation: Expectation;
  readonly closedBy: ClinicalEvent['type'];
}
