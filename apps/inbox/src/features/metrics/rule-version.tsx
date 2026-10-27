import type { ReactNode } from 'react';
import { metricsCopy, type MetricsLocale } from './copy.ts';

/**
 * Which versioned rule (and protocol) produced a case reason (HIP-141), so
 * the team and an auditor can tell a reason of `protocol_diabetes_hba1c`
 * 1.2.0 from one raised by 1.3.0.
 */
export function ReasonRuleVersion({
  ruleId,
  ruleVersion,
  protocol,
  locale,
}: {
  readonly ruleId: string;
  readonly ruleVersion: string | undefined;
  readonly protocol?: { readonly id: string; readonly version: string } | undefined;
  readonly locale?: MetricsLocale;
}): ReactNode {
  if (ruleVersion === undefined) return null;
  const copy = metricsCopy(locale).ruleVersion;
  return (
    <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
      <span>
        {copy.rule} <code className="font-mono text-[11px] text-fg">{ruleId}</code> ·{' '}
        {copy.version(ruleVersion)}
      </span>
      {protocol === undefined ? null : (
        <span>
          {copy.protocol} <code className="font-mono text-[11px] text-fg">{protocol.id}</code> ·{' '}
          {copy.version(protocol.version)}
        </span>
      )}
    </p>
  );
}
