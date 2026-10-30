import { writeSignoffPages } from './protocol-signoff/generate.ts';

/**
 * `pnpm protocols:signoff`: writes docs/protocols/signoff/<id>.md and
 * <id>.es.md for every protocol in `SIGNOFF_PROTOCOL_IDS`
 * (apps/api/src/protocol-signoff/generate.ts), read from config/protocols
 * and the engine's reason-and-action catalog. Run it after changing either,
 * or after renaming a test `tests.ts` cites; `pnpm test` fails
 * (generate.test.ts) if a committed page no longer matches a fresh run.
 */
try {
  const written = writeSignoffPages();
  for (const path of written) {
    process.stdout.write(`wrote ${path}\n`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
