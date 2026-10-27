/**
 * `@follow-up-engine/testkit`: shared contract tests that every adapter of a
 * port must pass, plus synthetic fixtures. Test-only: production code must
 * never import it (enforced by `pnpm boundaries`).
 */
export { describeClockContract } from './clock-contract.ts';
