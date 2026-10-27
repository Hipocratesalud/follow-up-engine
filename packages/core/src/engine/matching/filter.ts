import type { EventFilter, FilterCondition } from '../../config/common.ts';

type Literal = string | number | boolean;

/** Reads a dot path (`code.code`) from a plain object. */
export function readPath(subject: unknown, path: string): unknown {
  let current: unknown = subject;
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = (current as Readonly<Record<string, unknown>>)[segment];
  }
  return current;
}

function isCondition(expected: unknown): expected is FilterCondition {
  return typeof expected === 'object' && expected !== null && !Array.isArray(expected);
}

function satisfiesCondition(actual: unknown, condition: FilterCondition): boolean {
  if (condition.exists !== undefined && (actual !== undefined) !== condition.exists) {
    return false;
  }
  const bounds = [condition.lt, condition.lte, condition.gt, condition.gte];
  if (bounds.every((bound) => bound === undefined)) {
    return true;
  }
  if (typeof actual !== 'number') {
    return false;
  }
  return (
    (condition.lt === undefined || actual < condition.lt) &&
    (condition.lte === undefined || actual <= condition.lte) &&
    (condition.gt === undefined || actual > condition.gt) &&
    (condition.gte === undefined || actual >= condition.gte)
  );
}

function equalsLiteral(actual: unknown, expected: Literal): boolean {
  if (typeof actual === 'string' && typeof expected === 'string') {
    return actual.toLowerCase() === expected.toLowerCase();
  }
  return actual === expected;
}

/**
 * Whether `subject` passes a declarative {@link EventFilter}. String
 * comparisons ignore case. An absent filter matches everything.
 */
export function matchesFilter(filter: EventFilter | undefined, subject: unknown): boolean {
  if (filter === undefined) {
    return true;
  }
  return Object.entries(filter).every(([path, expected]) => {
    const actual = readPath(subject, path);
    if (Array.isArray(expected)) {
      return expected.some((literal) => equalsLiteral(actual, literal));
    }
    if (isCondition(expected)) {
      return satisfiesCondition(actual, expected);
    }
    return equalsLiteral(actual, expected);
  });
}
