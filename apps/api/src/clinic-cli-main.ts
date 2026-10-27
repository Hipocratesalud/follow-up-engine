import { createRuntime, loadRuntimeConfig } from '@follow-up-engine/runtime';
import { CLINIC_CLI_USAGE, runClinicCommand } from './clinic-cli.ts';

/**
 * `pnpm --filter @follow-up-engine/api clinic:create --name ... --scopes ...`:
 * registers a clinic and prints its new API key once. Runs against
 * `DATABASE_URL` (migrating it first, like the API).
 */
const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  process.stdout.write(`${CLINIC_CLI_USAGE}\n`);
  process.exit(0);
}
const config = loadRuntimeConfig({ LOG_LEVEL: 'error', ...process.env });
if (config.databaseUrl === undefined) {
  process.stderr.write(
    'Set DATABASE_URL: a clinic registered in memory would vanish with this process.\n',
  );
  process.exit(1);
}
const runtime = await createRuntime(config, { service: 'clinic-cli', poolSize: 2 });
try {
  const result = await runClinicCommand(runtime, argv);
  (result.code === 0 ? process.stdout : process.stderr).write(result.output);
  process.exitCode = result.code;
} finally {
  await runtime.close();
}
