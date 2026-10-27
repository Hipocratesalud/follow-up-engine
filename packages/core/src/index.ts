/**
 * `@follow-up-engine/core`: pure domain model and ports. No I/O, no vendor
 * SDKs, no other workspace packages (enforced by `pnpm boundaries`).
 */

// Domain
export * from './domain/ids.ts';
export * from './domain/resource.ts';
export * from './domain/clinical-event.ts';
export * from './domain/attribution.ts';
export type * from './domain/common.ts';
export * from './domain/expectation.ts';
export * from './domain/case.ts';
export * from './domain/plan-item-review.ts';
export * from './domain/contact.ts';
export * from './domain/backfill.ts';
export * from './domain/condition.ts';
export type * from './domain/quality-finding.ts';
export * from './domain/clinical-finding.ts';
export * from './domain/domain-event.ts';
export * from './domain/errors.ts';

// Versioned configuration (rules, protocols)
export * from './config/common.ts';
export * from './config/rule.ts';
export * from './config/protocol.ts';
export * from './config/loader.ts';

// Ports
export * from './ports/index.ts';

// Engine (application services over the domain)
export * from './engine/index.ts';

// Shared primitives and pure adapters
export type * from './shared/brand.ts';
export type * from './shared/json.ts';
export * from './shared/duration.ts';
export * from './shared/language.ts';
export { SystemClock } from './clock/system-clock.ts';
export { FakeClock, InvalidInstantError } from './clock/fake-clock.ts';
