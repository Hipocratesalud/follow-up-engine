import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  RuleDecisionResponse,
  RuleDraftRequest,
  RuleDraftResponse,
  RulesPageView,
} from './rules-contract.ts';
import { useApi } from './queries.ts';

export const rulesQueryKeys = { page: ['lab-rules'] as const };

/** The lab clinic's own rules. */
export function useLabRules(): UseQueryResult<RulesPageView> {
  const api = useApi();
  return useQuery({ queryKey: rulesQueryKeys.page, queryFn: () => api.getLabRules() });
}

function useInvalidateRules(): () => Promise<void> {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: rulesQueryKeys.page });
}

export function useDraftLabRule(): UseMutationResult<RuleDraftResponse, Error, RuleDraftRequest> {
  const api = useApi();
  const invalidate = useInvalidateRules();
  return useMutation({
    mutationFn: (body: RuleDraftRequest) => api.draftLabRule(body),
    onSuccess: invalidate,
  });
}

export interface RuleDecision {
  readonly ruleId: string;
  readonly decision: 'enable' | 'discard';
}

export function useDecideLabRule(): UseMutationResult<RuleDecisionResponse, Error, RuleDecision> {
  const api = useApi();
  const invalidate = useInvalidateRules();
  return useMutation({
    mutationFn: (input: RuleDecision) => api.decideLabRule(input.ruleId, input.decision),
    onSuccess: invalidate,
  });
}

export function useAddLabRuleSamples(): UseMutationResult<{ added: number }, Error, void> {
  const api = useApi();
  const invalidate = useInvalidateRules();
  return useMutation({ mutationFn: () => api.addLabRuleSamples(), onSuccess: invalidate });
}
