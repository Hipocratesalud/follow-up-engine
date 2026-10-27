import type { z } from 'zod';
import { appendPath, type IssueCode, type MappingIssue } from '../support/operation-outcome.ts';

function issueCode(issue: z.core.$ZodIssue): IssueCode {
  switch (issue.code) {
    case 'invalid_type':
      return issue.message.includes('received undefined') ? 'required' : 'structure';
    case 'invalid_value':
    case 'invalid_format':
    case 'too_small':
    case 'too_big':
      return 'value';
    case 'custom':
      return 'invariant';
    case 'invalid_union':
    case 'invalid_key':
    case 'invalid_element':
    case 'unrecognized_keys':
    case 'not_multiple_of':
      return 'invalid';
  }
}

/** Turns zod issues into FHIR-style issues located with FHIRPath-like expressions. */
export function zodIssuesToMappingIssues(
  issues: readonly z.core.$ZodIssue[],
  base: string,
): MappingIssue[] {
  return issues.map((issue) => ({
    severity: 'error',
    code: issueCode(issue),
    message: issue.message,
    expression: appendPath(base, issue.path),
  }));
}
