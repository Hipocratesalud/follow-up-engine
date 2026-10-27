/**
 * `@follow-up-engine/core`: pure domain and ports. No I/O, no vendor SDKs,
 * no other workspace packages (enforced by `pnpm boundaries`).
 */
export * from './domain/ids.ts';
export type * from './domain/resource.ts';
export type * from './ports/index.ts';
export type * from './shared/brand.ts';
export type * from './shared/json.ts';
export * from './shared/duration.ts';
export { SystemClock } from './clock/system-clock.ts';
export { FakeClock, InvalidInstantError } from './clock/fake-clock.ts';
