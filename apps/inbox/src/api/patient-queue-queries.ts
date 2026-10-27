import {
  type InfiniteData,
  keepPreviousData,
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  PatientQueueItem,
  PatientQueuePage,
  PatientQueueQuery,
  PlanItemReviewResponse,
} from './patient-queue-contract.ts';
import type { PlanItemCommand, PlanItemCorrectionRequest } from './plan-item-contract.ts';
import { queryKeys, useApi } from './queries.ts';

/*
 * Queries and commands of the patient queue and the plan item review
 * (HIP-141). Their keys live under `cases`, so every case change (an action,
 * a call, the demo clock) refreshes the cards too.
 */

export const patientQueueKeys = {
  pages: (query: Omit<PatientQueueQuery, 'cursor'>) =>
    [...queryKeys.allCases, 'patients-queue', query] as const,
  card: (patientId: string) => [...queryKeys.allCases, 'patient-card', patientId] as const,
};

/** Every page of the patient queue, loaded one after the other (the inbox's infinite scroll). */
export function usePatientQueuePages(
  query: Omit<PatientQueueQuery, 'cursor'>,
): UseInfiniteQueryResult<InfiniteData<PatientQueuePage, string | undefined>> {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: patientQueueKeys.pages(query),
    queryFn: ({ pageParam }) =>
      api.listPatientQueue({ ...query, ...(pageParam === undefined ? {} : { cursor: pageParam }) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
  });
}

/** One patient's card: active cases, then the latest closed ones. */
export function usePatientCard(patientId: string | undefined): UseQueryResult<PatientQueueItem> {
  const api = useApi();
  return useQuery({
    queryKey: patientQueueKeys.card(patientId ?? ''),
    queryFn: () => api.getPatientCard(patientId ?? ''),
    enabled: patientId !== undefined,
  });
}

/** What a change to a patient's cases can affect. */
function invalidateAfterPatientChange(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.allCases });
  void queryClient.invalidateQueries({ queryKey: ['case'] });
  void queryClient.invalidateQueries({ queryKey: ['patient'] });
  void queryClient.invalidateQueries({ queryKey: queryKeys.owners });
  void queryClient.invalidateQueries({ queryKey: queryKeys.stats });
  void queryClient.invalidateQueries({ queryKey: queryKeys.recovery });
  void queryClient.invalidateQueries({ queryKey: queryKeys.webhooks });
}

/** "Request contact" for the patient: one request whatever the number of their cases. */
export function useRequestPatientContact(
  patientId: string,
): UseMutationResult<PatientQueueItem, Error, { note?: string }> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { note?: string }) => api.requestPatientContact(patientId, body),
    onSuccess: (card: PatientQueueItem) => {
      queryClient.setQueryData(patientQueueKeys.card(patientId), card);
      invalidateAfterPatientChange(queryClient);
    },
  });
}

export interface PlanItemReviewInput {
  readonly command: PlanItemCommand;
  readonly correction?: PlanItemCorrectionRequest;
}

/** Confirm, correct or reject a plan item the AI read. */
export function usePlanItemReview(
  expectationId: string,
): UseMutationResult<PlanItemReviewResponse, Error, PlanItemReviewInput> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ command, correction }: PlanItemReviewInput) =>
      api.reviewPlanItem(expectationId, command, correction),
    onSuccess: () => {
      invalidateAfterPatientChange(queryClient);
    },
  });
}
