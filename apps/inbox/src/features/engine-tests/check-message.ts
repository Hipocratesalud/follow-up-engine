import type { CheckMessage, CheckParam } from '../../api/engine-tests-contract.ts';
import type { Messages } from '../../i18n/index.ts';
import { formatDateTime } from '../../lib/format.ts';

/**
 * Resolves one {@link CheckParam} into locale-correct display text: a
 * status label, a date formatted for the active locale, a pluralized
 * count, ... `text` is the one kind already resolved by the API (rule,
 * test and diagnosis names), shown verbatim.
 */
function paramText(t: Messages, param: CheckParam): string {
  switch (param.kind) {
    case 'status':
      return param.value === 'missing'
        ? t.engineTests.autoCheck.missing
        : t.labels.expectationStatuses[param.value];
    case 'eventType':
      return t.engineTests.eventTypes[param.value] ?? t.engineTests.autoCheck.none;
    case 'source':
      return t.engineTests.autoCheck.source[param.value];
    case 'date':
      return formatDateTime(param.value);
    case 'days':
      return t.time.days(param.value);
    case 'plural':
      return t.engineTests.autoCheck[param.unit](param.value);
    case 'bool':
      return param.value ? t.common.yes : t.common.no;
    case 'category':
      return t.lab.orderCategories[param.value];
    case 'interpretation':
      return t.lab.interpretations[param.value];
    case 'verification':
      return t.engineTests.verification[param.value];
    case 'text':
      return param.value;
  }
}

/**
 * A `CheckMessage` (the automatic check's own `expected`/`observed`, or a
 * timeline entry's `detail`) written out in the active UI locale: the
 * code looks up the sentence in `engineTests.checks`, each param resolves
 * to locale-correct text first, then interpolates. Never literal text
 * from the API (docs/deploy.md#engine-tests).
 */
export function renderCheckMessage(t: Messages, message: CheckMessage): string {
  const entry = t.engineTests.checks[message.code];
  if (entry === undefined) return message.code;
  if (typeof entry === 'string') return entry;
  const resolved: Record<string, string> = {};
  for (const [key, param] of Object.entries(message.params ?? {})) {
    resolved[key] = paramText(t, param);
  }
  return entry(resolved);
}
