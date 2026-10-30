import { mkdirSync, writeFileSync } from 'node:fs';
import { runOutcomeSimulation, SIMULATION_SNAPSHOT_URL } from '@follow-up-engine/runtime';

/**
 * `pnpm simulate [--patients N] [--seeds N]`: the 90-day outcome simulation
 * (docs/simulation.md) over the real engine. Writes
 * docs/evals/simulation/<date>.md and .json and, at the default size, the
 * snapshot the API serves (packages/runtime/assets/simulation/latest.json).
 * Deterministic: the same config and code give the same numbers.
 */
function flag(name: string): number | undefined {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value === undefined ? undefined : Number(value);
}

const patientsPerArm = flag('--patients');
const seeds = flag('--seeds');
const startedAt = Date.now();
const { report, markdown } = await runOutcomeSimulation({
  ...(patientsPerArm === undefined ? {} : { patientsPerArm }),
  ...(seeds === undefined ? {} : { seeds }),
  onSeed: (seed) => {
    process.stderr.write(`seed ${String(seed)} done (${String(Date.now() - startedAt)} ms)\n`);
  },
});
const date = new Date().toISOString().slice(0, 10);
const dir = new URL('../../../docs/evals/simulation/', import.meta.url);
mkdirSync(dir, { recursive: true });
const suffix =
  patientsPerArm === undefined && seeds === undefined
    ? ''
    : `-${String(report.cohort.patientsPerArm)}x${String(report.seeds.length)}`;
writeFileSync(new URL(`${date}${suffix}.md`, dir), markdown);
writeFileSync(new URL(`${date}${suffix}.json`, dir), `${JSON.stringify(report, null, 2)}\n`);
if (suffix === '') {
  mkdirSync(new URL('./', SIMULATION_SNAPSHOT_URL), { recursive: true });
  writeFileSync(SIMULATION_SNAPSHOT_URL, `${JSON.stringify(report, null, 2)}\n`);
}
process.stdout.write(`${markdown.split('\n').find((line) => line.startsWith('**')) ?? ''}\n`);
process.stdout.write(`Wrote docs/evals/simulation/${date}${suffix}.md and .json\n`);
