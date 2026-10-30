import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Test and QA accounts of the hosted demo (docs/deploy.md#hosted-demo):
 * evaluator emails that are not physicians. Their actions stay in the
 * evaluator log and its CSV (flagged `is_test_evaluator`), and nothing of
 * theirs is deleted, but every reported number leaves them out: the
 * clinic metrics (usefulness, plan-item reviews, resolved and dismissed
 * cases, time to first action), the inbox's usefulness tile, the rule
 * calibration, the reviewer's precision and the Evaluators summary.
 */
export interface TestEvaluatorPolicy {
  /** Every address at one of these domains (`example.com` and its kin, RFC 2606). */
  readonly domains: readonly string[];
  /** And these addresses, whatever their domain. */
  readonly emails: readonly string[];
}

const PolicySchema = z.object({
  description: z.string().optional(),
  domains: z.array(z.string().trim().toLowerCase().min(1)),
  emails: z.array(z.string().trim().toLowerCase().min(3)),
});

/** The versioned list at the repository root. */
export const DEFAULT_TEST_EVALUATORS_URL = new URL(
  '../../../config/demo/test-evaluators.json',
  import.meta.url,
);

export function loadTestEvaluatorPolicy(
  url: URL = DEFAULT_TEST_EVALUATORS_URL,
): TestEvaluatorPolicy {
  return PolicySchema.parse(JSON.parse(readFileSync(url, 'utf8')) as unknown);
}

/** Whether an actor id (an evaluator email, or a host user id) is a test or QA account. */
export function isTestEvaluator(actorId: string | undefined, policy: TestEvaluatorPolicy): boolean {
  if (actorId === undefined) return false;
  const email = actorId.trim().toLowerCase();
  if (policy.emails.includes(email)) return true;
  const at = email.lastIndexOf('@');
  return at > 0 && policy.domains.includes(email.slice(at + 1));
}
