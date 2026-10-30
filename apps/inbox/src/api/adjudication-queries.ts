import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  AdjudicationList,
  AdjudicationListQuery,
  AdjudicationOverrideRequest,
  AdjudicationOverrideResponse,
} from './adjudication-contract.ts';
import { queryKeys, useApi } from './queries.ts';

/*
 * The adjudicator's decisions (PRD V2). Their keys live under `cases`, so a
 * case change (an action, the demo clock, a plan item review) refreshes
 * them too.
 */

export const adjudicationKeys = {
  list: (query: AdjudicationListQuery) => [...queryKeys.allCases, 'adjudications', query] as const,
};

/** The decisions on a case's reasons, or on a patient's items. */
export function useAdjudications(
  query: AdjudicationListQuery,
  enabled = true,
): UseQueryResult<AdjudicationList> {
  const api = useApi();
  return useQuery({
    queryKey: adjudicationKeys.list(query),
    queryFn: () => api.listAdjudications(query),
    enabled,
  });
}

/** A doctor's override of a decision: keep the item, or discard it. */
export function useAdjudicationOverride(
  id: string,
): UseMutationResult<AdjudicationOverrideResponse, Error, AdjudicationOverrideRequest> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: AdjudicationOverrideRequest) => api.overrideAdjudication(id, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.allCases });
      void queryClient.invalidateQueries({ queryKey: ['case'] });
      void queryClient.invalidateQueries({ queryKey: ['patient'] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.stats });
    },
  });
}
