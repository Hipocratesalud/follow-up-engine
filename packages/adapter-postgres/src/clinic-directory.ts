import { createHash } from 'node:crypto';
import {
  DEFAULT_CLINIC_LOCALE,
  type Clinic,
  type ClinicDirectory,
  type ClinicId,
  type ClinicSettings,
} from '@follow-up-engine/core';
import { jsonParam, type RepositoryContext } from './sql.ts';

/** Settings a clinic gets for every key it does not override. */
export const DEFAULT_CLINIC_SETTINGS: ClinicSettings = {
  // Nothing reaches patients until the clinic opts in.
  allowPatientContact: false,
  dailyCaseCapPerOwner: 20,
  backfillNotifyMaxAgeDays: 730,
  llmMonthlyBudgetUsd: 50,
  timezone: 'UTC',
  locale: DEFAULT_CLINIC_LOCALE,
};

interface ClinicRow {
  readonly id: string;
  readonly name: string;
  readonly active: boolean;
  readonly settings: Partial<ClinicSettings>;
}

function toClinic(row: ClinicRow): Clinic {
  return {
    id: row.id as ClinicId,
    name: row.name,
    active: row.active,
    settings: { ...DEFAULT_CLINIC_SETTINGS, ...row.settings },
  };
}

/** sha256 hex of an API key, the only form in which keys are stored. */
export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

export interface ClinicRegistration {
  readonly id: ClinicId;
  readonly name: string;
  readonly active?: boolean;
  /** Stored as given; missing keys resolve to {@link DEFAULT_CLINIC_SETTINGS} on read. */
  readonly settings?: Partial<ClinicSettings>;
  /** sha256 hex ({@link hashApiKey}). Leave out to keep the current key. */
  readonly apiKeyHash?: string;
}

/**
 * The tenant registry (`clinics`). Implements the read-only `ClinicDirectory`
 * port, plus `register` for provisioning (CLI, seeds, admin API).
 */
export class PostgresClinicDirectory implements ClinicDirectory {
  readonly #ctx: RepositoryContext;

  constructor(ctx: RepositoryContext) {
    this.#ctx = ctx;
  }

  async listActive(): Promise<readonly Clinic[]> {
    const { rows } = await this.#ctx
      .db()
      .query<ClinicRow>(
        `SELECT id, name, active, settings FROM ${this.#ctx.tables.clinics} WHERE active ORDER BY id`,
      );
    return rows.map(toClinic);
  }

  async get(clinicId: ClinicId): Promise<Clinic | undefined> {
    const { rows } = await this.#ctx
      .db()
      .query<ClinicRow>(
        `SELECT id, name, active, settings FROM ${this.#ctx.tables.clinics} WHERE id = $1`,
        [clinicId],
      );
    const [row] = rows;
    return row === undefined ? undefined : toClinic(row);
  }

  /** Inactive clinics are returned too: the caller decides how to reject them. */
  async findByApiKeyHash(apiKeyHash: string): Promise<Clinic | undefined> {
    const { rows } = await this.#ctx
      .db()
      .query<ClinicRow>(
        `SELECT id, name, active, settings FROM ${this.#ctx.tables.clinics} WHERE api_key_hash = $1`,
        [apiKeyHash.toLowerCase()],
      );
    const [row] = rows;
    return row === undefined ? undefined : toClinic(row);
  }

  /** Creates or updates a clinic. Settings are replaced, not merged. */
  async register(clinic: ClinicRegistration): Promise<Clinic> {
    const now = this.#ctx.clock.now();
    const { rows } = await this.#ctx.db().query<ClinicRow>(
      `INSERT INTO ${this.#ctx.tables.clinics} AS c (id, name, active, settings, api_key_hash, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $6)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         active = EXCLUDED.active,
         settings = EXCLUDED.settings,
         api_key_hash = COALESCE(EXCLUDED.api_key_hash, c.api_key_hash),
         updated_at = EXCLUDED.updated_at
       RETURNING id, name, active, settings`,
      [
        clinic.id,
        clinic.name,
        clinic.active ?? true,
        jsonParam(clinic.settings ?? {}),
        clinic.apiKeyHash?.toLowerCase() ?? null,
        now,
      ],
    );
    const [row] = rows;
    if (row === undefined) {
      throw new Error(`Clinic ${clinic.id} was not stored`);
    }
    return toClinic(row);
  }
}
