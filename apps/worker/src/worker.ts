import { randomUUID } from 'node:crypto';
import {
  type ClaimedJob,
  type ClinicId,
  type EscalationReport,
  NOTE_EXTRACTION_JOB,
  type WatcherReport,
} from '@follow-up-engine/core';
import { INGEST_BUNDLE_JOB } from './runtime/ingestion.ts';
import { activeClinicIds, type EngineRuntime } from './runtime/runtime.ts';
import type { DrainResult } from './runtime/storage.ts';

/** Job types this worker handles. */
export const WORKER_JOB_TYPES = [INGEST_BUNDLE_JOB, NOTE_EXTRACTION_JOB] as const;

const RETRY_BASE_MS = 5_000;
const RETRY_CAP_MS = 3_600_000;

/** Exponential backoff before retrying a failed job: 5 s, 10 s, 20 s, ... capped at 1 h. */
export function jobRetryDelayMs(attempt: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
}

export interface WorkerOptions {
  readonly workerId?: string;
  /** Jobs claimed per pass. Default 10. */
  readonly batchSize?: number;
  readonly pollMs?: number;
  readonly outboxPollMs?: number;
  readonly sweepIntervalMs?: number;
}

export interface JobPassResult {
  readonly completed: number;
  readonly failed: number;
}

export interface SweepResult {
  readonly clinicId: ClinicId;
  readonly watcher: WatcherReport;
  readonly escalation: EscalationReport;
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * The background worker. Three independent loops, each one pass at a time:
 *
 * - jobs: claims leased jobs (`fhir.ingest_bundle`, `note.extract_plan`) and
 *   runs them; failures are retried with exponential backoff, then dead-lettered.
 * - sweeps: for every active clinic, the deadline watcher then the
 *   escalation sweep (hourly by default).
 * - outbox: delivers pending domain events to the host as signed webhooks.
 *
 * `stop()` stops scheduling and waits for the passes in flight, so a
 * deployment can drain the process gracefully (SIGTERM).
 */
export class Worker {
  readonly #runtime: EngineRuntime;
  readonly #workerId: string;
  readonly #batchSize: number;
  readonly #intervals: { readonly jobs: number; readonly outbox: number; readonly sweeps: number };
  readonly #timers = new Set<NodeJS.Timeout>();
  readonly #inFlight = new Set<Promise<unknown>>();
  #running = false;

  constructor(runtime: EngineRuntime, options: WorkerOptions = {}) {
    this.#runtime = runtime;
    this.#workerId = options.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
    this.#batchSize = options.batchSize ?? 10;
    this.#intervals = {
      jobs: options.pollMs ?? runtime.config.worker.pollMs,
      outbox: options.outboxPollMs ?? runtime.config.worker.outboxPollMs,
      sweeps: options.sweepIntervalMs ?? runtime.config.worker.sweepIntervalMs,
    };
  }

  get running(): boolean {
    return this.#running;
  }

  /** Claims and runs due jobs until none is left (or `maxPasses` is reached). */
  async runJobs(maxPasses = 100): Promise<JobPassResult> {
    let completed = 0;
    let failed = 0;
    for (let pass = 0; pass < maxPasses; pass += 1) {
      const jobs = await this.#runtime.storage.jobs.claim({
        workerId: this.#workerId,
        types: WORKER_JOB_TYPES,
        limit: this.#batchSize,
        leaseFor: { minutes: 5 },
        now: this.#runtime.clock.now(),
      });
      if (jobs.length === 0) {
        break;
      }
      for (const job of jobs) {
        if (await this.#runJob(job)) {
          completed += 1;
        } else {
          failed += 1;
        }
      }
    }
    return { completed, failed };
  }

  /** Watcher then escalation, for the given clinics (default: every active clinic). */
  async runSweeps(clinicIds?: readonly ClinicId[]): Promise<readonly SweepResult[]> {
    const clinics = clinicIds ?? (await activeClinicIds(this.#runtime));
    const results: SweepResult[] = [];
    for (const clinicId of clinics) {
      const now = this.#runtime.clock.now();
      const watcher = await this.#runtime.engine.runWatcher(clinicId, now);
      const escalation = await this.#runtime.engine.runEscalation(clinicId, now);
      if (watcher.expired > 0 || escalation.casesProcessed > 0) {
        this.#runtime.logger.info(
          {
            clinicId,
            expired: watcher.expired,
            casesOpened: watcher.casesOpened.length,
            casesMerged: watcher.casesMerged.length,
            escalated: escalation.steps.length,
            contactsRequested: escalation.contactsRequested.length,
          },
          'sweep',
        );
      }
      results.push({ clinicId, watcher, escalation });
    }
    return results;
  }

  /** Delivers every pending outbox event. */
  async deliverOutbox(): Promise<DrainResult> {
    let delivered = 0;
    let retrying = 0;
    let dead = 0;
    for (;;) {
      const pass = await this.#runtime.storage.drainOutbox(
        this.#runtime.publisher,
        this.#runtime.clock.now(),
        100,
      );
      delivered += pass.delivered;
      retrying += pass.retrying;
      dead += pass.dead;
      if (pass.delivered + pass.retrying + pass.dead < 100 || pass.delivered === 0) {
        break;
      }
    }
    if (delivered + retrying + dead > 0) {
      this.#runtime.logger.info({ delivered, retrying, dead }, 'outbox delivered');
    }
    return { delivered, retrying, dead };
  }

  /** Starts the three loops. Idempotent. */
  start(): void {
    if (this.#running) {
      return;
    }
    this.#running = true;
    this.#loop('jobs', this.#intervals.jobs, () => this.runJobs());
    this.#loop('outbox', this.#intervals.outbox, () => this.deliverOutbox());
    this.#loop('sweeps', this.#intervals.sweeps, () => this.runSweeps());
    this.#runtime.logger.info({ workerId: this.#workerId, ...this.#intervals }, 'worker started');
  }

  /** Stops scheduling and waits for the passes in flight. */
  async stop(): Promise<void> {
    this.#running = false;
    for (const timer of this.#timers) {
      clearTimeout(timer);
    }
    this.#timers.clear();
    await Promise.allSettled([...this.#inFlight]);
    this.#runtime.logger.info({ workerId: this.#workerId }, 'worker stopped');
  }

  #loop(name: string, intervalMs: number, pass: () => Promise<unknown>): void {
    const tick = (): void => {
      if (!this.#running) {
        return;
      }
      const run = pass()
        .catch((error: unknown) => {
          this.#runtime.logger.error({ loop: name, error: describe(error) }, 'worker pass failed');
        })
        .finally(() => {
          this.#inFlight.delete(run);
          if (this.#running) {
            const timer = setTimeout(() => {
              this.#timers.delete(timer);
              tick();
            }, intervalMs);
            this.#timers.add(timer);
          }
        });
      this.#inFlight.add(run);
    };
    tick();
  }

  async #runJob(job: ClaimedJob): Promise<boolean> {
    const { logger, storage, ingestion, engine, clock } = this.#runtime;
    const context = { jobId: job.id, type: job.type, clinicId: job.clinicId, attempt: job.attempt };
    try {
      switch (job.type) {
        case INGEST_BUNDLE_JOB: {
          const reports = await ingestion.processJob(job.clinicId, job.payload);
          logger.info(
            {
              ...context,
              batches: reports.length,
              expectationsCreated: reports.reduce(
                (total, report) => total + report.expectationsCreated.length,
                0,
              ),
              notesFailed: reports.reduce(
                (total, report) =>
                  total + report.notes.filter((note) => note.status === 'failed').length,
                0,
              ),
            },
            'bundle ingested',
          );
          break;
        }
        case NOTE_EXTRACTION_JOB:
          await engine.runNoteExtractionJob(job.clinicId, job.payload);
          logger.info(context, 'note extraction retried');
          break;
        default:
          throw new Error(`No handler for job type ${job.type}`);
      }
      await storage.jobs.complete(job.clinicId, job);
      return true;
    } catch (error) {
      const retryAt = new Date(clock.now().getTime() + jobRetryDelayMs(job.attempt));
      logger.warn(
        {
          ...context,
          error: describe(error),
          final: job.attempt >= job.maxAttempts,
          retryAt: retryAt.toISOString(),
        },
        'job failed',
      );
      await storage.jobs.fail(job.clinicId, job, { error: describe(error), retryAt });
      return false;
    }
  }
}
