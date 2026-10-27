import type { ClinicalBatch } from '../../domain/clinical-event.ts';
import type { ClinicId } from '../../domain/ids.ts';
import type { ClinicDirectory } from '../../ports/clinic-directory.ts';
import type { Clock } from '../../ports/clock.ts';
import type { ProtocolSource, RuleSource } from '../../ports/config-sources.ts';
import type { IdGenerator } from '../../ports/id-generator.ts';
import type { NoteExtractor } from '../../ports/note-extractor.ts';
import type { UnitOfWork } from '../../ports/unit-of-work.ts';
import { Catalog } from '../catalog.ts';
import { DEFAULT_ENGINE_SETTINGS, type EngineSettings } from '../settings.ts';
import { runWatcher, type WatcherReport } from '../watcher/watcher.ts';
import { ingest, type IngestReport, runNoteExtractionJob } from './ingest.ts';

/** The ports the engine runs on. Apps wire adapters (Postgres, memory, LLM) into them. */
export interface FollowUpEngineDeps {
  readonly unitOfWork: UnitOfWork;
  readonly noteExtractor: NoteExtractor;
  readonly rules: RuleSource;
  readonly protocols: ProtocolSource;
  readonly clinics: ClinicDirectory;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly settings?: Partial<EngineSettings>;
}

/**
 * The follow-up engine: the application services over the pure domain.
 * Every method is scoped to a clinic and runs in `UnitOfWork` transactions.
 */
export interface FollowUpEngine {
  /** "A consultation was saved": annotate a batch of clinical events. Idempotent. */
  ingest(batch: ClinicalBatch): Promise<IngestReport>;
  /** Deadline sweep: expire due expectations and open or merge cases. */
  runWatcher(clinicId: ClinicId, now: Date): Promise<WatcherReport>;
  /** Handler of the `note.extract_plan` job (retry of a failed extraction). Throws to retry. */
  runNoteExtractionJob(
    clinicId: ClinicId,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<IngestReport>;
  /** The rules and protocols enabled for a clinic (labels, suggested actions, policies). */
  catalog(clinicId: ClinicId): Promise<Catalog>;
}

/**
 * Builds the engine from its ports.
 *
 * @example
 * ```ts
 * const engine = createFollowUpEngine({ unitOfWork, noteExtractor, rules, protocols, clinics, clock, ids });
 * await engine.ingest(batch);
 * await engine.runWatcher(clinicId, clock.now());
 * ```
 */
export function createFollowUpEngine(deps: FollowUpEngineDeps): FollowUpEngine {
  const settings: EngineSettings = { ...DEFAULT_ENGINE_SETTINGS, ...deps.settings };
  async function loadCatalog(clinicId: ClinicId): Promise<Catalog> {
    const [rules, protocols] = await Promise.all([
      deps.rules.listRules(clinicId),
      deps.protocols.listProtocols(clinicId),
    ]);
    return new Catalog(rules, protocols);
  }
  const shared = { unitOfWork: deps.unitOfWork, ids: deps.ids, settings, loadCatalog };
  const ingestDeps = { ...shared, noteExtractor: deps.noteExtractor, clock: deps.clock };

  return {
    ingest: (batch) => ingest(ingestDeps, batch),
    runWatcher: (clinicId, now) => runWatcher(shared, clinicId, now),
    runNoteExtractionJob: (clinicId, payload) =>
      runNoteExtractionJob(ingestDeps, clinicId, payload),
    catalog: loadCatalog,
  };
}
