import { createRuntime, loadRuntimeConfig } from '@follow-up-engine/runtime';
import { CLINIC_RECONCILE_CLI_USAGE, runClinicReconcileCommand } from './clinic-reconcile-cli.ts';

/**
 * `pnpm --filter @follow-up-engine/api clinic:reconcile --clinic <id> [--all]`:
 * the nightly reconciliation by hand, against `DATABASE_URL`.
 */
const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  process.stdout.write(`${CLINIC_RECONCILE_CLI_USAGE}\n`);
  process.exit(0);
}
const config = loadRuntimeConfig({ LOG_LEVEL: 'error', ...process.env });
if (config.databaseUrl === undefined) {
  process.stderr.write('Set DATABASE_URL: the clinic to reconcile lives in the database.\n');
  process.exit(1);
}
const runtime = await createRuntime(config, { service: 'clinic-reconcile-cli', poolSize: 2 });
try {
  const result = await runClinicReconcileCommand(runtime, argv);
  (result.code === 0 ? process.stdout : process.stderr).write(result.output);
  process.exitCode = result.code;
} finally {
  await runtime.close();
}
