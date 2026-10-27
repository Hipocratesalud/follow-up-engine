import { parseArgs } from 'node:util';
import { clinicId as toClinicId } from '@follow-up-engine/core';
import {
  API_KEY_SCOPES,
  type ApiKeyScope,
  type EngineRuntime,
  isApiKeyScope,
} from '@follow-up-engine/runtime';

export const CLINIC_CLI_USAGE = `Usage: pnpm --filter @follow-up-engine/api clinic:create [options]

Registers a clinic (or updates one) and issues a scoped API key, printed once.

  --name <name>              Clinic name (required for a new clinic)
  --id <id>                  Clinic id (default: a slug of --name)
  --scopes <a,b>             ${API_KEY_SCOPES.join(', ')} (default: fhir:write)
  --label <label>            Name of the key (default: integration)
  --revoke <label>           Revoke the clinic's keys with this label instead of issuing one
  --allow-patient-contact    Enable patient contact requests for a new clinic (default: off)
  --timezone <iana>          Clinic time zone for a new clinic (default: UTC)
  --help                     This help

Needs DATABASE_URL (the same database the API uses).`;

export interface ClinicCliResult {
  /** Process exit code. */
  readonly code: number;
  readonly output: string;
}

/** Lowercase ASCII slug of a clinic name: "Clínica Ejemplo" → "clinica-ejemplo". */
export function clinicSlug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

const CLINIC_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function fail(message: string): ClinicCliResult {
  return { code: 1, output: `${message}\n\n${CLINIC_CLI_USAGE}\n` };
}

/**
 * `clinic:create`: registers a clinic or updates its name, then issues (or
 * revokes) one of its scoped API keys. The key is in the output once; only
 * its sha256 is stored.
 */
export async function runClinicCommand(
  runtime: EngineRuntime,
  argv: readonly string[],
): Promise<ClinicCliResult> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        name: { type: 'string' },
        id: { type: 'string' },
        scopes: { type: 'string' },
        label: { type: 'string' },
        revoke: { type: 'string' },
        'allow-patient-contact': { type: 'boolean' },
        timezone: { type: 'string' },
        help: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (values.help === true) {
    return { code: 0, output: `${CLINIC_CLI_USAGE}\n` };
  }
  const id = values.id ?? (values.name === undefined ? undefined : clinicSlug(values.name));
  if (id === undefined || !CLINIC_ID.test(id)) {
    return fail('Give --name (or --id: lowercase letters, digits and dashes).');
  }
  const existing = await runtime.storage.clinics.get(toClinicId(id));

  if (values.revoke !== undefined) {
    if (existing === undefined) {
      return fail(`Clinic ${id} does not exist.`);
    }
    const revoked = await runtime.storage.apiKeys.revoke(
      existing.id,
      values.revoke,
      runtime.clock.now(),
    );
    return {
      code: 0,
      output: `clinic ${id}: revoked ${String(revoked)} key(s) labelled "${values.revoke}"\n`,
    };
  }

  const scopes = (values.scopes ?? 'fhir:write')
    .split(',')
    .map((scope) => scope.trim())
    .filter((scope) => scope !== '');
  const unknown = scopes.filter((scope) => !isApiKeyScope(scope));
  if (scopes.length === 0 || unknown.length > 0) {
    return fail(`Unknown scope(s): ${unknown.join(', ') || '(none given)'}.`);
  }
  if (existing === undefined && values.name === undefined) {
    return fail(`Clinic ${id} does not exist: give --name to create it.`);
  }
  let action = 'unchanged';
  if (existing === undefined || (values.name !== undefined && values.name !== existing.name)) {
    await runtime.storage.registerClinic({
      id: toClinicId(id),
      name: values.name ?? existing?.name ?? id,
      ...(existing === undefined
        ? {
            settings: {
              allowPatientContact: values['allow-patient-contact'] === true,
              ...(values.timezone === undefined ? {} : { timezone: values.timezone }),
            },
          }
        : { settings: existing.settings, active: existing.active }),
    });
    action = existing === undefined ? 'created' : 'renamed';
  }
  const label = values.label ?? 'integration';
  const issued = await runtime.issueApiKey({
    clinicId: id,
    label,
    scopes: scopes as ApiKeyScope[],
  });
  return {
    code: 0,
    output:
      `clinic ${id} (${action}); key "${label}" [${issued.scopes.join(', ')}]:\n\n` +
      `  ${issued.apiKey}\n\n` +
      'Store it now: it is shown only once (the engine keeps its sha256).\n',
  };
}
