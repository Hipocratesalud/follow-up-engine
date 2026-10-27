import {
  type InfiniteData,
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import { useT } from '../i18n/index.ts';
import { noteReader, type NoteReader } from '../lib/labels.ts';
import { type ApiClient, isApiError } from './client.ts';
import type {
  CallOutcomeRequest,
  CaseActionRequest,
  CaseDetail,
  CaseListQuery,
  CaseView,
  ClinicInfo,
  ConditionView,
  DemoClock,
  DemoConsultationRequest,
  DemoConsultationResponse,
  FeedbackRequest,
  InboxStats,
  OwnerView,
  Page,
  PatientDetail,
  PatientSummary,
  RecoveryPage,
  SuppressionView,
  WebhookDelivery,
} from './contract.ts';
import type {
  FindingDetail,
  FindingFlagUpdate,
  FindingFlagView,
  FindingListQuery,
  FindingPage,
  FindingReviewRequest,
  FindingView,
  ReviewMetrics,
} from './reviewer-contract.ts';

export const ApiContext = createContext<ApiClient | null>(null);

export function useApi(): ApiClient {
  const api = useContext(ApiContext);
  if (!api) throw new Error('useApi must be used inside <ApiContext.Provider>');
  return api;
}

export const queryKeys = {
  clinic: ['clinic'] as const,
  cases: (query: CaseListQuery) => ['cases', query] as const,
  casePages: (query: Omit<CaseListQuery, 'cursor'>) => ['cases', 'pages', query] as const,
  allCases: ['cases'] as const,
  owners: ['owners'] as const,
  patients: ['patients'] as const,
  case: (id: string) => ['case', id] as const,
  patient: (id: string) => ['patient', id] as const,
  recovery: ['recovery'] as const,
  stats: ['stats'] as const,
  clock: ['clock'] as const,
  webhooks: ['webhooks'] as const,
  findings: (query: FindingListQuery) => ['findings', query] as const,
  allFindings: ['findings'] as const,
  finding: (id: string) => ['finding', id] as const,
  reviewMetrics: ['review-metrics'] as const,
  findingFlags: ['finding-flags'] as const,
};

/** The clinic the API key belongs to (its name titles the inbox). */
export function useClinic(): UseQueryResult<ClinicInfo> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.clinic,
    queryFn: () => api.getClinic(),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useCases(query: CaseListQuery): UseQueryResult<Page<CaseView>> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.cases(query),
    queryFn: () => api.listCases(query),
    placeholderData: keepPreviousData,
  });
}

/** Every page of a case list, loaded one after the other (the inbox's infinite scroll). */
export function useCasePages(
  query: Omit<CaseListQuery, 'cursor'>,
): UseInfiniteQueryResult<InfiniteData<Page<CaseView>, string | undefined>> {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: queryKeys.casePages(query),
    queryFn: ({ pageParam }) =>
      api.listCases({ ...query, ...(pageParam === undefined ? {} : { cursor: pageParam }) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
  });
}

/** Owners of the inbox's cases (id and display name), for the "Responsable" filter. */
export function useOwners(): UseQueryResult<{ items: OwnerView[] }> {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.owners, queryFn: () => api.listOwners() });
}

/** Every patient of the clinic (the demo's patient selector). */
export function usePatientList(): UseQueryResult<{ items: PatientSummary[] }> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.patients,
    queryFn: () => api.listPatients({ limit: 500 }),
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

/** Who reads the notes (provider and model the API runs), from the stats. */
export function useNoteReader(): NoteReader {
  const t = useT();
  return noteReader(t, useStats().data?.llm);
}

/** The API's clock. `data` is `undefined` when the clock is real (no demo endpoints). */
export function useDemoClock(): UseQueryResult<DemoClock | null> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.clock,
    queryFn: async () => (await api.getDemoClock()) ?? null,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** "Now" as the API sees it: the simulated date in demo mode, the real one otherwise. */
export function useNow(): Date {
  const clock = useDemoClock();
  return clock.data ? new Date(clock.data.now) : new Date();
}

/** The last webhooks the host received; only one event type when `type` is set. */
export function useWebhooks(
  enabled: boolean,
  type?: string,
): UseQueryResult<{ items: WebhookDelivery[] }> {
  const api = useApi();
  return useQuery({
    queryKey: [...queryKeys.webhooks, type ?? 'all'],
    queryFn: () => api.listWebhooks(30, type),
    enabled,
    refetchInterval: 5000,
  });
}

/** Everything a case change can affect, except the case itself (set directly from the response). */
function invalidateAfterCaseChange(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.allCases });
  void queryClient.invalidateQueries({ queryKey: queryKeys.owners });
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

/**
 * Reloads a case and every list it appears in, after a 409 (someone else
 * changed it: another tab, the engine) so the view shows its current state.
 */
export function useRefreshAfterConflict(caseId: string): (error: unknown) => void {
  const queryClient = useQueryClient();
  return (error) => {
    if (isApiError(error) && error.status === 409) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.case(caseId) });
      invalidateAfterCaseChange(queryClient);
    }
  };
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
      void queryClient.invalidateQueries({ queryKey: queryKeys.patients });
    },
  });
}

/** "Llamar al paciente": records what came of the call; the case comes back updated. */
export function useCallOutcome(
  caseId: string,
): UseMutationResult<CaseDetail, Error, CallOutcomeRequest> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: CallOutcomeRequest) => api.recordCallOutcome(caseId, request),
    onSuccess: (detail: CaseDetail) => {
      queryClient.setQueryData(queryKeys.case(caseId), detail);
      invalidateAfterCaseChange(queryClient);
    },
  });
}

// ------------------------------------------------------------ clinical reviewer

export function useFindings(query: FindingListQuery): UseQueryResult<FindingPage> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.findings(query),
    queryFn: () => api.listFindings(query),
    placeholderData: keepPreviousData,
  });
}

/** Every page of a finding list, loaded one after the other. */
export function useFindingPages(
  query: Omit<FindingListQuery, 'cursor'>,
): UseInfiniteQueryResult<InfiniteData<FindingPage, string | undefined>> {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: [...queryKeys.allFindings, 'pages', query],
    queryFn: ({ pageParam }) =>
      api.listFindings({ ...query, ...(pageParam === undefined ? {} : { cursor: pageParam }) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
  });
}

/** Open shadow findings: the count next to "Revisión clínica" in the nav. */
export function useOpenShadowFindings(): UseQueryResult<FindingPage> {
  return useFindings({ mode: 'shadow', status: 'open', limit: 1 });
}

export function useFinding(id: string): UseQueryResult<FindingDetail> {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.finding(id), queryFn: () => api.getFinding(id) });
}

export function useReviewMetrics(): UseQueryResult<ReviewMetrics> {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.reviewMetrics, queryFn: () => api.getReviewMetrics() });
}

export function useFindingFlags(): UseQueryResult<{ items: FindingFlagView[] }> {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.findingFlags, queryFn: () => api.listFindingFlags() });
}

function invalidateAfterFindingChange(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.allFindings });
  void queryClient.invalidateQueries({ queryKey: queryKeys.reviewMetrics });
  void queryClient.invalidateQueries({ queryKey: queryKeys.findingFlags });
}

export function useFindingReview(
  findingId: string,
): UseMutationResult<FindingView, Error, FindingReviewRequest> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: FindingReviewRequest) => api.reviewFinding(findingId, request),
    onSuccess: (view: FindingView) => {
      queryClient.setQueryData<FindingDetail>(queryKeys.finding(findingId), (previous) =>
        previous ? { ...previous, ...view } : previous,
      );
      invalidateAfterFindingChange(queryClient);
    },
  });
}

/** "Volver a activar" a reminder stopped for one patient. */
export function useReactivateSuppression(
  patientId: string,
): UseMutationResult<SuppressionView, Error, string> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (suppressionId: string) => api.reactivateSuppression(suppressionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.patient(patientId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.allCases });
      void queryClient.invalidateQueries({ queryKey: ['case'] });
    },
  });
}

export function useFindingFlagUpdate(): UseMutationResult<
  FindingFlagView,
  Error,
  FindingFlagUpdate
> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: FindingFlagUpdate) => api.updateFindingFlag(request),
    onSuccess: () => {
      invalidateAfterFindingChange(queryClient);
    },
  });
}
