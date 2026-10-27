/**
 * Builds docs/evals/comparison.md from every eval JSON summary in a folder.
 *
 *   pnpm --filter @follow-up-engine/llm eval:compare [--dir docs/evals]
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { renderComparison, type ReportSidecar } from './report.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

async function main(argv: readonly string[]): Promise<void> {
  const { values } = parseArgs({ args: [...argv], options: { dir: { type: 'string' } } });
  const dir = values.dir ? resolve(values.dir) : join(REPO_ROOT, 'docs/evals');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  const runs: ReportSidecar[] = [];
  for (const file of files) {
    runs.push(JSON.parse(await readFile(join(dir, file), 'utf8')) as ReportSidecar);
  }
  const out = join(dir, 'comparison.md');
  await writeFile(out, renderComparison(runs), 'utf8');
  process.stdout.write(`Compared ${String(runs.length)} runs: ${out}\n`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
