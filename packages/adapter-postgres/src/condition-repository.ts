import {
  TenantMismatchError,
  type ClinicId,
  type ConditionRepository,
  type ConditionSourceType,
  type Evidence,
  type PatientCondition,
  type PatientConditionStatus,
  type PatientId,
  type QualityFinding,
  type QualityFindingKind,
  type QualityFindingRepository,
} from '@follow-up-engine/core';
import { jsonParam, optional, type RepositoryContext } from './sql.ts';

export interface ConditionRow {
  readonly clinic_id: string;
  readonly patient_id: string;
  readonly code_system: string;
  readonly code: string;
  readonly code_display: string | null;
  readonly status: PatientConditionStatus;
  readonly confidence: number;
  readonly source_type: ConditionSourceType;
  readonly source_resource_type: string;
  readonly source_resource_id: string;
  readonly confirmed_by: string | null;
  readonly evidence: Evidence | null;
  readonly updated_at: Date;
}

export const CONDITION_COLUMNS = `clinic_id, patient_id, code_system, code, code_display, status, confidence,
  source_type, source_resource_type, source_resource_id, confirmed_by, evidence, updated_at`;

/** Conditions per patient (`patient_conditions`), unique per patient and code. */
export class PostgresConditionRepository implements ConditionRepository {
  readonly #ctx: RepositoryContext;

  constructor(ctx: RepositoryContext) {
    this.#ctx = ctx;
  }

  async upsert(clinicId: ClinicId, condition: PatientCondition): Promise<void> {
    if (condition.clinicId !== clinicId) {
      throw new TenantMismatchError();
    }
    await this.#ctx.db().query(
      `INSERT INTO ${this.#ctx.tables.patient_conditions} (${CONDITION_COLUMNS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)
       ON CONFLICT (clinic_id, patient_id, code_system, code) DO UPDATE SET
         code_display = EXCLUDED.code_display,
         status = EXCLUDED.status,
         confidence = EXCLUDED.confidence,
         source_type = EXCLUDED.source_type,
         source_resource_type = EXCLUDED.source_resource_type,
         source_resource_id = EXCLUDED.source_resource_id,
         confirmed_by = EXCLUDED.confirmed_by,
         evidence = EXCLUDED.evidence,
         updated_at = EXCLUDED.updated_at`,
      [
        clinicId,
        condition.patientId,
        condition.code.system,
        condition.code.code,
        condition.code.display ?? null,
        condition.status,
        condition.confidence,
        condition.sourceType,
        condition.source.resourceType,
        condition.source.id,
        condition.confirmedBy ?? null,
        condition.evidence === undefined ? null : jsonParam(condition.evidence),
        condition.updatedAt,
      ],
    );
  }

  async listByPatient(
    clinicId: ClinicId,
    patientId: PatientId,
    statuses?: readonly PatientConditionStatus[],
  ): Promise<readonly PatientCondition[]> {
    const { rows } = await this.#ctx.db().query<ConditionRow>(
      `SELECT ${CONDITION_COLUMNS} FROM ${this.#ctx.tables.patient_conditions}
       WHERE clinic_id = $1 AND patient_id = $2
         AND ($3::text[] IS NULL OR status = ANY($3::text[]))
       ORDER BY code_system, code`,
      [clinicId, patientId, statuses ?? null],
    );
    return rows.map(toCondition);
  }
}

export function toCondition(row: ConditionRow): PatientCondition {
  return {
    clinicId: row.clinic_id as ClinicId,
    patientId: row.patient_id as PatientId,
    code: {
      system: row.code_system,
      code: row.code,
      ...optional('display', row.code_display),
    },
    status: row.status,
    confidence: row.confidence,
    sourceType: row.source_type,
    source: { resourceType: row.source_resource_type, id: row.source_resource_id },
    ...optional('confirmedBy', row.confirmed_by),
    ...optional('evidence', row.evidence),
    updatedAt: row.updated_at,
  };
}

interface FindingRow {
  readonly clinic_id: string;
  readonly id: string;
  readonly patient_id: string;
  readonly kind: QualityFindingKind;
  readonly source_type: string;
  readonly source_id: string;
  readonly detected_at: Date;
}

/** Documentation-quality findings (`quality_findings`). */
export class PostgresQualityFindingRepository implements QualityFindingRepository {
  readonly #ctx: RepositoryContext;

  constructor(ctx: RepositoryContext) {
    this.#ctx = ctx;
  }

  /** Idempotent on `id`: saving an existing finding again keeps the stored one. */
  async save(clinicId: ClinicId, finding: QualityFinding): Promise<void> {
    if (finding.clinicId !== clinicId) {
      throw new TenantMismatchError();
    }
    await this.#ctx.db().query(
      `INSERT INTO ${this.#ctx.tables.quality_findings}
         (clinic_id, id, patient_id, kind, source_type, source_id, detected_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (clinic_id, id) DO NOTHING`,
      [
        clinicId,
        finding.id,
        finding.patientId,
        finding.kind,
        finding.source.resourceType,
        finding.source.id,
        finding.detectedAt,
      ],
    );
  }

  async listByPatient(
    clinicId: ClinicId,
    patientId: PatientId,
  ): Promise<readonly QualityFinding[]> {
    const { rows } = await this.#ctx.db().query<FindingRow>(
      `SELECT clinic_id, id, patient_id, kind, source_type, source_id, detected_at
       FROM ${this.#ctx.tables.quality_findings}
       WHERE clinic_id = $1 AND patient_id = $2
       ORDER BY detected_at, id`,
      [clinicId, patientId],
    );
    return rows.map((row) => ({
      id: row.id,
      clinicId: row.clinic_id as ClinicId,
      patientId: row.patient_id as PatientId,
      kind: row.kind,
      source: { resourceType: row.source_type, id: row.source_id },
      detectedAt: row.detected_at,
    }));
  }
}
