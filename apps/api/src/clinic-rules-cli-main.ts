import { userInfo } from 'node:os';
import { createRuntime, loadRuntimeConfig } from '@follow-up-engine/runtime';
import { CLINIC_RULES_CLI_USAGE, runClinicRulesCommand } from './clinic-rules-cli.ts';

/**
 * `pnpm --filter @follow-up-engine/api clinic:rules --clinic <id> ...`:
 * per-clinic rule overrides against `DATABASE_URL` (migrating it first,
 * like the API).
 */
const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  process.stdout.write(`${CLINIC_RULES_CLI_USAGE}\n`);
  process.exit(0);
}
const config = loadRuntimeConfig({ LOG_LEVEL: 'error', ...process.env });
if (config.databaseUrl === undefined) {
  process.stderr.write(
    'Set DATABASE_URL: an override kept in memory would vanish with this process.\n',
  );
  process.exit(1);
}
const runtime = await createRuntime(config, { service: 'clinic-rules-cli', poolSize: 2 });
try {
  const result = await runClinicRulesCommand(runtime, argv, {
    actor: `cli:${userInfo().username}`,
  });
  (result.code === 0 ? process.stdout : process.stderr).write(result.output);
  process.exitCode = result.code;
} finally {
  await runtime.close();
}
