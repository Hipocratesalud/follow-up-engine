import { createHash, randomBytes } from 'node:crypto';
import { DEFAULT_SCHEMA, type Queryable } from '@follow-up-engine/adapter-postgres';
import type { ClinicId } from '@follow-up-engine/core';

/**
 * What an API key may do. A clinic has as many keys as it needs, each with
 * the least scopes for its job:
 *
 * - `fhir:write`: the host integration: everything under `/fhir` (ingest,
 *   read Tasks, Conditions, DetectedIssues) and `/jobs`.
 * - `inbox:read`: read the inbox JSON API (`GET /api/inbox/*`).
 * - `inbox:act`: act from the inbox (`POST /api/inbox/*`: case actions,
 *   feedback, condition review).
 * - `demo`: the demo controls (`POST /api/demo/*`): moving the shared fake
 *   clock affects every clinic of the process, so only the demo operator's
 *   keys get it.
 */
export const API_KEY_SCOPES = ['fhir:write', 'inbox:read', 'inbox:act', 'demo'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** Scopes of a clinic's original key (`clinics.api_key_hash`): the host integration. */
export const INTEGRATION_SCOPES: readonly ApiKeyScope[] = ['fhir:write', 'inbox:read', 'inbox:act'];
/** Scopes of a key for the inbox: never `fhir:write`. */
export const INBOX_SCOPES: readonly ApiKeyScope[] = ['inbox:read', 'inbox:act'];

export function isApiKeyScope(value: string): value is ApiKeyScope {
  return (API_KEY_SCOPES as readonly string[]).includes(value);
}

/** sha256 hex of an API key: the only form in which keys are stored or compared. */
export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

/** A new random API key (`fue_` + 256 bits, base64url). Shown once, stored only as a hash. */
export function generateApiKey(): string {
  return `fue_${randomBytes(32).toString('base64url')}`;
}

/** A scoped key of a clinic (never the key itself). */
export interface ApiKeyRecord {
  readonly clinicId: ClinicId;
  readonly label: string;
  readonly scopes: readonly ApiKeyScope[];
  readonly createdAt: Date;
}

/** Scoped API keys (`api_keys`), stored as sha256 hashes. */
export interface ApiKeyStore {
  /** Adds a key, or replaces the label and scopes of the same key. */
  issue(input: ApiKeyRecord & { readonly keyHash: string }): Promise<void>;
  /** The live (not revoked) key with this hash. */
  findByHash(keyHash: string): Promise<ApiKeyRecord | undefined>;
  /** Revokes every key of the clinic with this label; returns how many. */
  revoke(clinicId: ClinicId, label: string, at: Date): Promise<number>;
}

interface StoredKey extends ApiKeyRecord {
  readonly revokedAt?: Date;
}

/** {@link ApiKeyStore} for the memory runtime. */
export class MemoryApiKeyStore implements ApiKeyStore {
  readonly #keys = new Map<string, StoredKey>();

  issue(input: ApiKeyRecord & { readonly keyHash: string }): Promise<void> {
    const { keyHash, ...record } = input;
    this.#keys.set(keyHash.toLowerCase(), { ...record, scopes: [...record.scopes] });
    return Promise.resolve();
  }

  findByHash(keyHash: string): Promise<ApiKeyRecord | undefined> {
    const key = this.#keys.get(keyHash.toLowerCase());
    if (key === undefined || key.revokedAt !== undefined) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve({
      clinicId: key.clinicId,
      label: key.label,
      scopes: key.scopes,
      createdAt: key.createdAt,
    });
  }

  revoke(clinicId: ClinicId, label: string, at: Date): Promise<number> {
    let revoked = 0;
    for (const [hash, key] of this.#keys) {
      if (key.clinicId === clinicId && key.label === label && key.revokedAt === undefined) {
        this.#keys.set(hash, { ...key, revokedAt: at });
        revoked += 1;
      }
    }
    return Promise.resolve(revoked);
  }
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** {@link ApiKeyStore} over the `api_keys` table (migration 0004). */
export class PostgresApiKeyStore implements ApiKeyStore {
  readonly #db: () => Queryable;
  readonly #table: string;

  constructor(db: () => Queryable, schema: string = DEFAULT_SCHEMA) {
    if (!SCHEMA_NAME.test(schema)) {
      throw new Error(`Invalid schema name: ${schema}`);
    }
    this.#db = db;
    this.#table = `"${schema}".api_keys`;
  }

  async issue(input: ApiKeyRecord & { readonly keyHash: string }): Promise<void> {
    await this.#db().query(
      `INSERT INTO ${this.#table} (key_hash, clinic_id, label, scopes, created_at)
       VALUES ($1, $2, $3, $4::text[], $5)
       ON CONFLICT (key_hash) DO UPDATE SET
         label = EXCLUDED.label, scopes = EXCLUDED.scopes, revoked_at = NULL`,
      [input.keyHash.toLowerCase(), input.clinicId, input.label, input.scopes, input.createdAt],
    );
  }

  async findByHash(keyHash: string): Promise<ApiKeyRecord | undefined> {
    const { rows } = await this.#db().query<{
      clinic_id: string;
      label: string;
      scopes: string[];
      created_at: Date;
    }>(
      `SELECT clinic_id, label, scopes, created_at FROM ${this.#table}
       WHERE key_hash = $1 AND revoked_at IS NULL`,
      [keyHash.toLowerCase()],
    );
    const [row] = rows;
    return row === undefined
      ? undefined
      : {
          clinicId: row.clinic_id as ClinicId,
          label: row.label,
          scopes: row.scopes.filter(isApiKeyScope),
          createdAt: row.created_at,
        };
  }

  async revoke(clinicId: ClinicId, label: string, at: Date): Promise<number> {
    const { rowCount } = await this.#db().query(
      `UPDATE ${this.#table} SET revoked_at = $3
       WHERE clinic_id = $1 AND label = $2 AND revoked_at IS NULL`,
      [clinicId, label, at],
    );
    return rowCount ?? 0;
  }
}
