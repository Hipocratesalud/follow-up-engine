import { parseArgs } from 'node:util';
import { clinicId as toClinicId, type ReconciliationRun } from '@follow-up-engine/core';
import type { EngineRuntime } from '@follow-up-engine/runtime';

export const CLINIC_RECONCILE_CLI_USAGE = `Usage: pnpm --filter @follow-up-engine/api clinic:reconcile --clinic <id> [action]

The nightly reconciliation, by hand: replays the stored record of the clinic's
patients through the annotator, repairs what lost or out-of-order events left
inconsistent (audited as system / reconciliation) and changes nothing on a
clean clinic. An unfinished run is resumed where it stopped.

  --clinic <id>        The clinic (required)
  --all                Every patient (default: those with events since the last run)
  --runs               The latest runs instead of running one
  --repairs <runId>    The repairs a run made instead of running one
  --help               This help

Needs DATABASE_URL (the same database the API and the worker use).`;

export interface ClinicReconcileCliResult {
  readonly code: number;
  readonly output: string;
}

function fail(message: string): ClinicReconcileCliResult {
  return { code: 1, output: `${message}\n\n${CLINIC_RECONCILE_CLI_USAGE}\n` };
}

function describeRun(run: ReconciliationRun): string {
  const kinds = Object.entries(run.repairsByKind)
    .map(([kind, count]) => `${kind}=${String(count)}`)
    .join(' ');
  return (
    `${run.runId} ${run.scope} ${run.status}: ${String(run.patientsScanned)} patients, ` +
    `${String(run.repairs)} repairs (${String(run.patientsRepaired)} patients` +
    `${run.patientsSkipped > 0 ? `, ${String(run.patientsSkipped)} skipped` : ''})` +
    (kinds === '' ? '' : ` ${kinds}`)
  );
}

/** `clinic:reconcile`: runs (or resumes) a reconciliation now, or lists runs and repairs. */
export async function runClinicReconcileCommand(
  runtime: EngineRuntime,
  argv: readonly string[],
): Promise<ClinicReconcileCliResult> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        clinic: { type: 'string' },
        all: { type: 'boolean' },
        runs: { type: 'boolean' },
        repairs: { type: 'string' },
        help: { type: 'boolean' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (values.help === true) {
    return { code: 0, output: `${CLINIC_RECONCILE_CLI_USAGE}\n` };
  }
  if (values.clinic === undefined) {
    return fail('Give --clinic.');
  }
  const clinic = await runtime.storage.clinics.get(toClinicId(values.clinic));
  if (clinic === undefined) {
    return fail(`Clinic ${values.clinic} does not exist.`);
  }
  const reconciliation = runtime.engine.reconciliation;
  if (values.runs === true) {
    const runs = await reconciliation.runs(clinic.id, 20);
    return {
      code: 0,
      output: `${runs.length === 0 ? '(no runs)' : runs.map(describeRun).join('\n')}\n`,
    };
  }
  if (values.repairs !== undefined) {
    const repairs = await reconciliation.repairs(clinic.id, { runId: values.repairs });
    const lines = repairs.map(
      (repair) =>
        `${repair.at.toISOString()}  ${repair.patientId}  ${repair.kind} ${repair.entityId}` +
        (repair.ruleId === undefined ? '' : ` ${repair.ruleId}`) +
        (repair.from === undefined && repair.to === undefined
          ? ''
          : ` ${repair.from ?? ''}->${repair.to ?? ''}`) +
        (repair.detail === undefined ? '' : ` (${repair.detail})`),
    );
    return { code: 0, output: `${lines.length === 0 ? '(no repairs)' : lines.join('\n')}\n` };
  }
  const report = await reconciliation.run(clinic.id, {
    scope: values.all === true ? 'all' : 'recent',
  });
  return {
    code: 0,
    output: `${report.resumed ? 'resumed ' : ''}${describeRun(report.run)}\n`,
  };
}
