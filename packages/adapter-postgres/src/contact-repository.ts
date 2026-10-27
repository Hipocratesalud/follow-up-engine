import {
  compareCommunicationVersions,
  ConflictError,
  TenantMismatchError,
  type CaseId,
  type ClinicId,
  type CommunicationStatus,
  type ContactChannel,
  type ContactCommunication,
  type ContactDataIssue,
  type ContactOutcome,
  type ContactRepository,
  type ContactRequest,
  type ContactRequestId,
  type ContactRequestReadOptions,
  type ContactRequestTrigger,
  type DismissReason,
  type PatientContactFlag,
  type PatientContactPurpose,
  type PatientId,
  type Reason,
  type RuleSuppression,
  type SaveCommunicationResult,
  type SuppressionId,
  type SuppressionRepository,
} from '@follow-up-engine/core';
import { isUniqueViolation, jsonParam, optional, type RepositoryContext } from './sql.ts';

interface RequestRow {
  readonly clinic_id: string;
  readonly id: string;
  readonly patient_id: string;
  readonly case_id: string;
  readonly channel: ContactChannel | null;
  readonly purpose: PatientContactPurpose;
  readonly trigger: ContactRequestTrigger;
  readonly attempt: number;
  readonly policy_step: number | null;
  readonly requested_by: string | null;
  readonly requested_at: Date;
  readonly due_by: Date;
}

const REQUEST_COLUMNS = `clinic_id, id, patient_id, case_id, channel, purpose, trigger, attempt,
  policy_step, requested_by, requested_at, due_by`;

function toRequest(row: RequestRow): ContactRequest {
  return {
    id: row.id as ContactRequestId,
    clinicId: row.clinic_id as ClinicId,
    patientId: row.patient_id as PatientId,
    caseId: row.case_id as CaseId,
    ...optional('channel', row.channel),
    purpose: row.purpose,
    trigger: row.trigger,
    attempt: row.attempt,
    ...optional('policyStep', row.policy_step),
    ...optional('requestedBy', row.requested_by),
    requestedAt: row.requested_at,
    dueBy: row.due_by,
  };
}

interface CommunicationRow {
  readonly clinic_id: string;
  readonly id: string;
  readonly patient_id: string;
  readonly case_id: string;
  readonly request_id: string;
  readonly channel: ContactChannel | null;
  readonly status: CommunicationStatus;
  readonly outcome: ContactOutcome | null;
  readonly sent_at: Date | null;
  readonly received_at: Date | null;
  readonly sender_type: 'host' | 'user';
  readonly sender_id: string | null;
  readonly version_id: string | null;
  readonly last_updated: Date | null;
  readonly recorded_at: Date;
}

const COMMUNICATION_COLUMNS = `clinic_id, id, patient_id, case_id, request_id, channel, status,
  outcome, sent_at, received_at, sender_type, sender_id, version_id, last_updated, recorded_at`;
const COMMUNICATION_PLACEHOLDERS = Array.from(
  { length: 15 },
  (_, index) => `$${String(index + 1)}`,
).join(', ');

function toCommunication(row: CommunicationRow): ContactCommunication {
  return {
    id: row.id,
    clinicId: row.clinic_id as ClinicId,
    patientId: row.patient_id as PatientId,
    caseId: row.case_id as CaseId,
    requestId: row.request_id as ContactRequestId,
    ...optional('channel', row.channel),
    status: row.status,
    ...optional('outcome', row.outcome),
    ...optional('sentAt', row.sent_at),
    ...optional('receivedAt', row.received_at),
    sender: { type: row.sender_type, ...optional('id', row.sender_id) },
    ...optional('versionId', row.version_id),
    ...optional('lastUpdated', row.last_updated),
    recordedAt: row.recorded_at,
  };
}

function communicationParams(value: ContactCommunication): unknown[] {
  return [
    value.clinicId,
    value.id,
    value.patientId,
    value.caseId,
    value.requestId,
    value.channel ?? null,
    value.status,
    value.outcome ?? null,
    value.sentAt ?? null,
    value.receivedAt ?? null,
    value.sender.type,
    value.sender.id ?? null,
    value.versionId ?? null,
    value.lastUpdated ?? null,
    value.recordedAt,
  ];
}

interface FlagRow {
  readonly clinic_id: string;
  readonly patient_id: string;
  readonly issue: ContactDataIssue;
  readonly raised_at: Date;
  readonly communication_id: string;
  readonly channel: ContactChannel | null;
  readonly cleared_at: Date | null;
}

function toFlag(row: FlagRow): PatientContactFlag {
  return {
    clinicId: row.clinic_id as ClinicId,
    patientId: row.patient_id as PatientId,
    issue: row.issue,
    raisedAt: row.raised_at,
    communicationId: row.communication_id,
    ...optional('channel', row.channel),
    ...optional('clearedAt', row.cleared_at),
  };
}

/**
 * Contact attempts (`contact_requests`), what came of them
 * (`contact_communications`, latest version per id) and contact data flags
 * (`patient_contact_flags`).
 */
export class PostgresContactRepository implements ContactRepository {
  readonly #ctx: RepositoryContext;

  constructor(ctx: RepositoryContext) {
    this.#ctx = ctx;
  }

  async createRequest(clinicId: ClinicId, request: ContactRequest): Promise<void> {
    if (request.clinicId !== clinicId) {
      throw new TenantMismatchError();
    }
    await this.#ctx
      .db()
      .query(
        `INSERT INTO ${this.#ctx.tables.contact_requests} (${REQUEST_COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          clinicId,
          request.id,
          request.patientId,
          request.caseId,
          request.channel ?? null,
          request.purpose,
          request.trigger,
          request.attempt,
          request.policyStep ?? null,
          request.requestedBy ?? null,
          request.requestedAt,
          request.dueBy,
        ],
      )
      .catch((error: unknown) => {
        throw isUniqueViolation(error) ? new ConflictError('ContactRequest', request.id) : error;
      });
  }

  async getRequest(
    clinicId: ClinicId,
    id: ContactRequestId,
    options: ContactRequestReadOptions = {},
  ): Promise<ContactRequest | undefined> {
    const { rows } = await this.#ctx.db().query<RequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM ${this.#ctx.tables.contact_requests}
       WHERE clinic_id = $1 AND id = $2 ${options.forUpdate === true ? 'FOR UPDATE' : ''}`,
      [clinicId, id],
    );
    const [row] = rows;
    return row === undefined ? undefined : toRequest(row);
  }

  async listRequestsForPatient(
    clinicId: ClinicId,
    patientId: PatientId,
  ): Promise<readonly ContactRequest[]> {
    const { rows } = await this.#ctx.db().query<RequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM ${this.#ctx.tables.contact_requests}
       WHERE clinic_id = $1 AND patient_id = $2 ORDER BY requested_at, id`,
      [clinicId, patientId],
    );
    return rows.map(toRequest);
  }

  async listRequestsForCase(
    clinicId: ClinicId,
    caseId: CaseId,
  ): Promise<readonly ContactRequest[]> {
    const { rows } = await this.#ctx.db().query<RequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM ${this.#ctx.tables.contact_requests}
       WHERE clinic_id = $1 AND case_id = $2 ORDER BY requested_at, id`,
      [clinicId, caseId],
    );
    return rows.map(toRequest);
  }

  async saveCommunication(
    clinicId: ClinicId,
    communication: ContactCommunication,
  ): Promise<SaveCommunicationResult> {
    if (communication.clinicId !== clinicId) {
      throw new TenantMismatchError();
    }
    const table = this.#ctx.tables.contact_communications;
    // A first version: inserted unless a concurrent writer got there first,
    // in which case its row is locked and compared like any stored version.
    const inserted = await this.#ctx.db().query(
      `INSERT INTO ${table} (${COMMUNICATION_COLUMNS}) VALUES (${COMMUNICATION_PLACEHOLDERS})
       ON CONFLICT (clinic_id, id) DO NOTHING`,
      communicationParams(communication),
    );
    if (inserted.rowCount === 1) {
      return { communication, changed: true, stale: false };
    }
    const { rows } = await this.#ctx
      .db()
      .query<CommunicationRow>(
        `SELECT ${COMMUNICATION_COLUMNS} FROM ${table} WHERE clinic_id = $1 AND id = $2 FOR UPDATE`,
        [clinicId, communication.id],
      );
    const [row] = rows;
    if (row === undefined) {
      // Deleted in between (never by the engine): store this version.
      return this.saveCommunication(clinicId, communication);
    }
    const stored = toCommunication(row);
    const order = compareCommunicationVersions(communication, stored);
    if (order <= 0) {
      return { communication: stored, changed: false, stale: order < 0, previous: stored };
    }
    await this.#ctx.db().query(
      `UPDATE ${table} SET (${COMMUNICATION_COLUMNS}) = ROW(${COMMUNICATION_PLACEHOLDERS})
       WHERE clinic_id = $1 AND id = $2`,
      communicationParams(communication),
    );
    return { communication, changed: true, stale: false, previous: stored };
  }

  async getCommunication(
    clinicId: ClinicId,
    id: string,
  ): Promise<ContactCommunication | undefined> {
    const { rows } = await this.#ctx.db().query<CommunicationRow>(
      `SELECT ${COMMUNICATION_COLUMNS} FROM ${this.#ctx.tables.contact_communications}
       WHERE clinic_id = $1 AND id = $2`,
      [clinicId, id],
    );
    const [row] = rows;
    return row === undefined ? undefined : toCommunication(row);
  }

  async listCommunicationsForPatient(
    clinicId: ClinicId,
    patientId: PatientId,
  ): Promise<readonly ContactCommunication[]> {
    const { rows } = await this.#ctx.db().query<CommunicationRow>(
      `SELECT ${COMMUNICATION_COLUMNS} FROM ${this.#ctx.tables.contact_communications}
       WHERE clinic_id = $1 AND patient_id = $2 ORDER BY recorded_at, id`,
      [clinicId, patientId],
    );
    return rows.map(toCommunication);
  }

  async listCommunicationsForCase(
    clinicId: ClinicId,
    caseId: CaseId,
  ): Promise<readonly ContactCommunication[]> {
    const { rows } = await this.#ctx.db().query<CommunicationRow>(
      `SELECT ${COMMUNICATION_COLUMNS} FROM ${this.#ctx.tables.contact_communications}
       WHERE clinic_id = $1 AND case_id = $2 ORDER BY recorded_at, id`,
      [clinicId, caseId],
    );
    return rows.map(toCommunication);
  }

  async saveFlag(clinicId: ClinicId, flag: PatientContactFlag): Promise<void> {
    if (flag.clinicId !== clinicId) {
      throw new TenantMismatchError();
    }
    await this.#ctx.db().query(
      `INSERT INTO ${this.#ctx.tables.patient_contact_flags}
         (clinic_id, patient_id, issue, raised_at, communication_id, channel, cleared_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (clinic_id, patient_id, issue) DO UPDATE SET
         raised_at = EXCLUDED.raised_at,
         communication_id = EXCLUDED.communication_id,
         channel = EXCLUDED.channel,
         cleared_at = EXCLUDED.cleared_at`,
      [
        clinicId,
        flag.patientId,
        flag.issue,
        flag.raisedAt,
        flag.communicationId,
        flag.channel ?? null,
        flag.clearedAt ?? null,
      ],
    );
  }

  async listFlags(
    clinicId: ClinicId,
    patientId: PatientId,
  ): Promise<readonly PatientContactFlag[]> {
    const { rows } = await this.#ctx.db().query<FlagRow>(
      `SELECT clinic_id, patient_id, issue, raised_at, communication_id, channel, cleared_at
       FROM ${this.#ctx.tables.patient_contact_flags}
       WHERE clinic_id = $1 AND patient_id = $2 ORDER BY raised_at DESC, issue`,
      [clinicId, patientId],
    );
    return rows.map(toFlag);
  }
}

interface SuppressionRow {
  readonly clinic_id: string;
  readonly id: string;
  readonly patient_id: string;
  readonly rule_id: string;
  readonly reason: Reason;
  readonly dismiss_reason: DismissReason;
  readonly note: string | null;
  readonly case_id: string | null;
  readonly created_by: string | null;
  readonly created_at: Date;
  readonly revoked_by: string | null;
  readonly revoked_at: Date | null;
}

const SUPPRESSION_COLUMNS = `clinic_id, id, patient_id, rule_id, reason, dismiss_reason, note,
  case_id, created_by, created_at, revoked_by, revoked_at`;

function toSuppression(row: SuppressionRow): RuleSuppression {
  return {
    id: row.id as SuppressionId,
    clinicId: row.clinic_id as ClinicId,
    patientId: row.patient_id as PatientId,
    ruleId: row.rule_id,
    reason: { code: row.reason.code, label: row.reason.label },
    dismissReason: row.dismiss_reason,
    ...optional('note', row.note),
    ...optional('caseId', row.case_id as CaseId | null),
    ...optional('createdBy', row.created_by),
    createdAt: row.created_at,
    ...optional('revokedBy', row.revoked_by),
    ...optional('revokedAt', row.revoked_at),
  };
}

/** Per-patient rule suppressions (`patient_rule_suppressions`); revoked rows stay as history. */
export class PostgresSuppressionRepository implements SuppressionRepository {
  readonly #ctx: RepositoryContext;

  constructor(ctx: RepositoryContext) {
    this.#ctx = ctx;
  }

  async create(clinicId: ClinicId, suppression: RuleSuppression): Promise<void> {
    if (suppression.clinicId !== clinicId) {
      throw new TenantMismatchError();
    }
    await this.#ctx
      .db()
      .query(
        `INSERT INTO ${this.#ctx.tables.patient_rule_suppressions} (${SUPPRESSION_COLUMNS})
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12)`,
        [
          clinicId,
          suppression.id,
          suppression.patientId,
          suppression.ruleId,
          jsonParam({ code: suppression.reason.code, label: suppression.reason.label }),
          suppression.dismissReason,
          suppression.note ?? null,
          suppression.caseId ?? null,
          suppression.createdBy ?? null,
          suppression.createdAt,
          suppression.revokedBy ?? null,
          suppression.revokedAt ?? null,
        ],
      )
      .catch((error: unknown) => {
        throw isUniqueViolation(error)
          ? new ConflictError('RuleSuppression', `${suppression.patientId}:${suppression.ruleId}`)
          : error;
      });
  }

  async get(clinicId: ClinicId, id: SuppressionId): Promise<RuleSuppression | undefined> {
    const { rows } = await this.#ctx.db().query<SuppressionRow>(
      `SELECT ${SUPPRESSION_COLUMNS} FROM ${this.#ctx.tables.patient_rule_suppressions}
       WHERE clinic_id = $1 AND id = $2`,
      [clinicId, id],
    );
    const [row] = rows;
    return row === undefined ? undefined : toSuppression(row);
  }

  async listForPatient(
    clinicId: ClinicId,
    patientId: PatientId,
    options: { readonly activeOnly?: boolean } = {},
  ): Promise<readonly RuleSuppression[]> {
    const { rows } = await this.#ctx.db().query<SuppressionRow>(
      `SELECT ${SUPPRESSION_COLUMNS} FROM ${this.#ctx.tables.patient_rule_suppressions}
       WHERE clinic_id = $1 AND patient_id = $2 AND (NOT $3::boolean OR revoked_at IS NULL)
       ORDER BY created_at DESC, id DESC`,
      [clinicId, patientId, options.activeOnly === true],
    );
    return rows.map(toSuppression);
  }

  async revoke(
    clinicId: ClinicId,
    id: SuppressionId,
    input: { readonly revokedAt: Date; readonly revokedBy?: string },
  ): Promise<RuleSuppression | undefined> {
    const { rows } = await this.#ctx.db().query<SuppressionRow>(
      `UPDATE ${this.#ctx.tables.patient_rule_suppressions}
       SET revoked_at = $3, revoked_by = $4
       WHERE clinic_id = $1 AND id = $2 AND revoked_at IS NULL
       RETURNING ${SUPPRESSION_COLUMNS}`,
      [clinicId, id, input.revokedAt, input.revokedBy ?? null],
    );
    const [row] = rows;
    return row === undefined ? undefined : toSuppression(row);
  }
}
