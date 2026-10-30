import type {
  ClinicId,
  HeldLabReport,
  HeldLabReportStatus,
  HeldLabReportStore,
  PatientId,
} from '@follow-up-engine/core';

function key(clinicId: ClinicId, id: string): string {
  return `${clinicId}\u0000${id}`;
}

/** In-memory {@link HeldLabReportStore}: the offline demo and tests. One per document key per clinic. */
export class MemoryHeldLabReportStore implements HeldLabReportStore {
  readonly #reports = new Map<string, HeldLabReport>();

  hold(report: HeldLabReport): Promise<HeldLabReport> {
    const existing = [...this.#reports.values()].find(
      (item) => item.clinicId === report.clinicId && item.documentKey === report.documentKey,
    );
    if (existing !== undefined) return Promise.resolve(existing);
    this.#reports.set(key(report.clinicId, report.id), report);
    return Promise.resolve(report);
  }

  get(clinicId: ClinicId, id: string): Promise<HeldLabReport | undefined> {
    return Promise.resolve(this.#reports.get(key(clinicId, id)));
  }

  findByDocumentKey(clinicId: ClinicId, documentKey: string): Promise<HeldLabReport | undefined> {
    return Promise.resolve(
      [...this.#reports.values()].find(
        (item) => item.clinicId === clinicId && item.documentKey === documentKey,
      ),
    );
  }

  list(
    clinicId: ClinicId,
    query: { readonly status?: HeldLabReportStatus; readonly patientId?: PatientId } = {},
  ): Promise<readonly HeldLabReport[]> {
    return Promise.resolve(
      [...this.#reports.values()]
        .filter(
          (item) =>
            item.clinicId === clinicId &&
            (query.status === undefined || item.status === query.status) &&
            (query.patientId === undefined || item.patientId === query.patientId),
        )
        .sort(
          (left, right) =>
            right.createdAt.getTime() - left.createdAt.getTime() || left.id.localeCompare(right.id),
        ),
    );
  }

  decide(
    clinicId: ClinicId,
    id: string,
    decision: {
      readonly status: Exclude<HeldLabReportStatus, 'pending'>;
      readonly by: string;
      readonly at: Date;
    },
  ): Promise<HeldLabReport | undefined> {
    const current = this.#reports.get(key(clinicId, id));
    if (current?.status !== 'pending') return Promise.resolve(undefined);
    const decided: HeldLabReport = {
      ...current,
      status: decision.status,
      decidedBy: decision.by,
      decidedAt: decision.at,
    };
    this.#reports.set(key(clinicId, id), decided);
    return Promise.resolve(decided);
  }
}
