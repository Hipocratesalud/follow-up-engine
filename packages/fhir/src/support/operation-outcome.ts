import type { OperationOutcome, OperationOutcomeIssue } from '../fhir-types.ts';

export type IssueSeverity = OperationOutcomeIssue['severity'];
export type IssueCode = OperationOutcomeIssue['code'];

/** One problem found while validating or mapping, before it becomes an `OperationOutcome.issue`. */
export interface MappingIssue {
  readonly severity: IssueSeverity;
  readonly code: IssueCode;
  readonly message: string;
  /** FHIRPath-like location, for example `Bundle.entry[2].resource.subject`. */
  readonly expression: string;
}

/** Appends a zod-style path (`['subject', 'reference']`, `['entry', 2]`) to a FHIRPath-like expression. */
export function appendPath(base: string, path: readonly PropertyKey[]): string {
  let expression = base;
  for (const segment of path) {
    expression += typeof segment === 'number' ? `[${String(segment)}]` : `.${String(segment)}`;
  }
  return expression;
}

/** Builds an `OperationOutcome` from issues; `undefined` when there are none. */
export function toOperationOutcome(issues: readonly MappingIssue[]): OperationOutcome | undefined {
  if (issues.length === 0) {
    return undefined;
  }
  return {
    resourceType: 'OperationOutcome',
    issue: issues.map((issue) => ({
      severity: issue.severity,
      code: issue.code,
      diagnostics: issue.message,
      expression: [issue.expression],
    })),
  };
}

/** Whether any issue blocks processing (`error` or `fatal`). */
export function hasErrors(issues: readonly MappingIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'error' || issue.severity === 'fatal');
}
