import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import type { ApiClient } from './client.ts';
import type {
  CaseActionRequest,
  CaseDetail,
  CaseListQuery,
  CaseView,
  ConditionView,
  DemoClock,
  DemoConsultationRequest,
  DemoConsultationResponse,
  FeedbackRequest,
  InboxStats,
  Page,
  PatientDetail,
  RecoveryPage,
  WebhookDelivery,
} from './contract.ts';

export const ApiContext = createContext<ApiClient | null>(null);

export function useApi(): ApiClient {
  const api = useContext(ApiContext);
  if (!api) throw new Error('useApi must be used inside <ApiContext.Provider>');
  return api;
}

export const queryKeys = {
  cases: (query: CaseListQuery) => ['cases', query] as const,
  allCases: ['cases'] as const,
  case: (id: string) => ['case', id] as const,
  patient: (id: string) => ['patient', id] as const,
  recovery: ['recovery'] as const,
  stats: ['stats'] as const,
  clock: ['clock'] as const,
  webhooks: ['webhooks'] as const,
};

export function useCases(query: CaseListQuery): UseQueryResult<Page<CaseView>> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.cases(query),
    queryFn: () => api.listCases(query),
    placeholderData: keepPreviousData,
  });
}

export function useCase(id: string): UseQueryResult<CaseDetail> {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.case(id), queryFn: () => api.getCase(id) });
}

export function usePatient(id: string): UseQueryResult<PatientDetail> {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.patient(id), queryFn: () => api.getPatient(id) });
}

export function useRecovery(): UseQueryResult<RecoveryPage> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.recovery,
    queryFn: () => api.listRecovery({ limit: 100 }),
  });
}

export function useStats(): UseQueryResult<InboxStats> {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.stats, queryFn: () => api.getStats() });
}

/** The API's clock. `data` is `undefined` when the clock is real (no demo endpoints). */
export function useDemoClock(): UseQueryResult<DemoClock | null> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.clock,
    queryFn: async () => (await api.getDemoClock()) ?? null,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

/** "Now" as the API sees it: the simulated date in demo mode, the real one otherwise. */
export function useNow(): Date {
  const clock = useDemoClock();
  return clock.data ? new Date(clock.data.now) : new Date();
}

export function useWebhooks(enabled: boolean): UseQueryResult<{ items: WebhookDelivery[] }> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.webhooks,
    queryFn: () => api.listWebhooks(30),
    enabled,
    refetchInterval: 5000,
  });
}

/** Everything a case change can affect, except the case itself (set directly from the response). */
function invalidateAfterCaseChange(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.allCases });
  void queryClient.invalidateQueries({ queryKey: queryKeys.stats });
  void queryClient.invalidateQueries({ queryKey: queryKeys.recovery });
  void queryClient.invalidateQueries({ queryKey: ['patient'] });
  void queryClient.invalidateQueries({ queryKey: queryKeys.webhooks });
}

export function useCaseAction(
  caseId: string,
): UseMutationResult<CaseDetail, Error, CaseActionRequest> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: CaseActionRequest) => api.actOnCase(caseId, request),
    onSuccess: (detail: CaseDetail) => {
      queryClient.setQueryData(queryKeys.case(caseId), detail);
      invalidateAfterCaseChange(queryClient);
    },
  });
}

export function useCaseFeedback(
  caseId: string,
): UseMutationResult<unknown, Error, FeedbackRequest> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: FeedbackRequest) => api.sendFeedback(caseId, request),
    onSuccess: (_response, request) => {
      // Show the verdict right away; the refetch below brings the timeline entry.
      queryClient.setQueryData<CaseDetail>(queryKeys.case(caseId), (previous) =>
        previous ? { ...previous, feedback: { ...request } } : previous,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.case(caseId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.stats });
    },
  });
}

export function useConditionReview(
  patientId: string,
): UseMutationResult<ConditionView, Error, { id: string; decision: 'confirm' | 'reject' }> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'confirm' | 'reject' }) =>
      decision === 'confirm' ? api.confirmCondition(id) : api.rejectCondition(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.patient(patientId) });
    },
  });
}

export function useAdvanceClock(): UseMutationResult<{ now: string }, Error, number> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (days: number) => api.advanceClock(days),
    onSuccess: async ({ now }) => {
      queryClient.setQueryData(queryKeys.clock, { now, fake: true });
      // Advancing the clock can change every view: refetch all of them.
      await queryClient.invalidateQueries({
        predicate: (query) => query.queryKey[0] !== queryKeys.clock[0],
      });
    },
  });
}

export const DEMO_CONSULTATION_MUTATION_KEY = ['demo-consultation'] as const;

export function useDemoConsultation(): UseMutationResult<
  DemoConsultationResponse,
  Error,
  DemoConsultationRequest
> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: DEMO_CONSULTATION_MUTATION_KEY,
    mutationFn: (request: DemoConsultationRequest) => api.createDemoConsultation(request),
    onSuccess: () => {
      invalidateAfterCaseChange(queryClient);
    },
  });
}
