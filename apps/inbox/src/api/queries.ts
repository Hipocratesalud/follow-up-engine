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
import type { PatientDocumentView } from './why-contract.ts';
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
  EvaluatorEventView,
  EvaluatorIdentity,
  EvaluatorsView,
  FeedbackRequest,
  InboxStats,
  LabDateImpact,
  LabDocumentResponse,
  LabDocumentUploadRequest,
  LabExpectationView,
  LabPatient,
  LabPatientCreateRequest,
  LabRecordAddRequest,
  LabRecordResponse,
  OwnerView,
  Page,
  PatientDetail,
  PatientSummary,
  RecoveryPage,
  SuppressionView,
  WebhookDelivery,
} from './contract.ts';
import type {
  BeforeVisitView,
  FindingDetail,
  FindingFlagUpdate,
  FindingFlagView,
  FindingListQuery,
  FindingPage,
  FindingReviewRequest,
  FindingView,
  InboxFindingList,
  ReviewerScope,
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
  beforeVisit: (patientId: string) => ['before-visit', patientId] as const,
  allBeforeVisit: ['before-visit'] as const,
  recovery: ['recovery'] as const,
  stats: ['stats'] as const,
  clock: ['clock'] as const,
  webhooks: ['webhooks'] as const,
  findings: (query: FindingListQuery) => ['findings', query] as const,
  allFindings: ['findings'] as const,
  finding: (id: string) => ['finding', id] as const,
  reviewMetrics: ['review-metrics'] as const,
  findingFlags: ['finding-flags'] as const,
  scopedFindingFlags: (scope: ReviewerScope) => ['finding-flags', scope] as const,
  inboxFindings: (scope: ReviewerScope) => ['inbox-findings', scope] as const,
  allInboxFindings: ['inbox-findings'] as const,
  evaluator: ['evaluator'] as const,
  labPatients: ['lab-patients'] as const,
  labPatientExpectations: (patientId: string) => ['lab-patient-expectations', patientId] as const,
  labCases: ['lab-cases'] as const,
  evaluators: ['evaluators'] as const,
  evaluatorEvents: (evaluatorEmail: string | undefined) =>
    ['evaluator-events', evaluatorEmail] as const,
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

/** The patient's documents for the "View documents" drawer, loaded when it opens (HIP-142). */
export function usePatientDocuments(
  id: string,
  enabled: boolean,
): UseQueryResult<{ items: PatientDocumentView[] }> {
  const api = useApi();
  return useQuery({
    queryKey: [...queryKeys.patient(id), 'documents'],
    queryFn: () => api.getPatientDocuments(id),
    enabled,
  });
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

/** "Before the visit": the patient's next appointment and what to raise then. */
export function useBeforeVisit(patientId: string): UseQueryResult<BeforeVisitView> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.beforeVisit(patientId),
    queryFn: () => api.getBeforeVisit(patientId),
  });
}

export function useFinding(id: string): UseQueryResult<FindingDetail> {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.finding(id), queryFn: () => api.getFinding(id) });
}

export function useReviewMetrics(): UseQueryResult<ReviewMetrics> {
  const api = useApi();
  return useQuery({ queryKey: queryKeys.reviewMetrics, queryFn: () => api.getReviewMetrics() });
}

export function useFindingFlags(
  scope: ReviewerScope = 'clinic',
): UseQueryResult<{ items: FindingFlagView[] }> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.scopedFindingFlags(scope),
    queryFn: () => api.listFindingFlags(scope),
  });
}

/**
 * The doctor's inbox cards (PRD V3): open findings of live, signed-off
 * categories. The API never returns a shadow category.
 */
export function useInboxFindings(
  scope: ReviewerScope = 'clinic',
): UseQueryResult<InboxFindingList> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.inboxFindings(scope),
    queryFn: () => api.listInboxFindings(scope),
  });
}

/** "Review this patient now" in the evaluator's lab: new findings show up as cards when live. */
export function useLabPatientReview(): UseMutationResult<
  { findings: FindingView[] },
  Error,
  string
> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patientId: string) => api.reviewLabPatient(patientId),
    onSuccess: () => {
      invalidateAfterFindingChange(queryClient);
    },
  });
}

function invalidateAfterFindingChange(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.allFindings });
  void queryClient.invalidateQueries({ queryKey: queryKeys.reviewMetrics });
  void queryClient.invalidateQueries({ queryKey: queryKeys.findingFlags });
  // A rated finding leaves the inbox; a category switched live or back to shadow
  // brings its cards in or takes them out, and the patient cards' badges follow.
  void queryClient.invalidateQueries({ queryKey: queryKeys.allInboxFindings });
  void queryClient.invalidateQueries({ queryKey: queryKeys.allCases });
  // "Asked" / "Not relevant" on the before-visit panel resolves a finding
  // the same way the batch review does: it drops off the patient's panel.
  void queryClient.invalidateQueries({ queryKey: queryKeys.allBeforeVisit });
}

export function useFindingReview(
  findingId: string,
  scope: ReviewerScope = 'clinic',
): UseMutationResult<FindingView, Error, FindingReviewRequest> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: FindingReviewRequest) => api.reviewFinding(findingId, request, scope),
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

export function useFindingFlagUpdate(
  scope: ReviewerScope = 'clinic',
): UseMutationResult<FindingFlagView, Error, FindingFlagUpdate> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: FindingFlagUpdate) => api.updateFindingFlag(request, scope),
    onSuccess: () => {
      invalidateAfterFindingChange(queryClient);
    },
  });
}

// The evaluator lab (docs/deploy.md#hosted-demo) --------------------------

/** Empty (`data?.email === undefined`) outside the hosted demo. */
export function useEvaluator(): UseQueryResult<EvaluatorIdentity> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.evaluator,
    queryFn: () => api.getEvaluator(),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useLogoutEvaluator(): UseMutationResult<void, Error, void> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.logoutEvaluator(),
    onSuccess: () => {
      // The next page load goes back to the code page; nothing left to keep.
      queryClient.clear();
    },
  });
}

/** The lab clinic's own "today": the records form's date pickers default here, never the shared clock's. */
export function useLabClock(
  options: { readonly enabled?: boolean } = {},
): UseQueryResult<DemoClock> {
  const api = useApi();
  return useQuery({
    queryKey: ['lab-clock'],
    queryFn: () => api.getLabClock(),
    enabled: options.enabled ?? true,
  });
}

export function useLabPatients(): UseQueryResult<{ items: LabPatient[] }> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.labPatients,
    queryFn: () => api.listLabPatients(),
  });
}

export function useCreateLabPatient(): UseMutationResult<
  LabPatient,
  Error,
  LabPatientCreateRequest
> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: LabPatientCreateRequest) => api.createLabPatient(request),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.labPatients });
    },
  });
}

export const LAB_DOCUMENT_MUTATION_KEY = ['lab-document'] as const;

/** "Add to the record" → Document: uploads it and shows what the AI (or the simulated reader) read. */
export function useUploadLabDocument(): UseMutationResult<
  LabDocumentResponse,
  Error,
  LabDocumentUploadRequest
> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: LAB_DOCUMENT_MUTATION_KEY,
    mutationFn: (request: LabDocumentUploadRequest) => api.uploadLabDocument(request),
    onSuccess: (response) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.labPatients });
      queryClient.setQueryData(queryKeys.labPatientExpectations(response.patientId), undefined);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.labPatientExpectations(response.patientId),
      });
    },
  });
}

export const LAB_RECORD_MUTATION_KEY = ['lab-record'] as const;

/** "Add to the record" → a structured entry (order, result, prescription, visit, diagnosis, appointment). */
export function useAddLabRecord(): UseMutationResult<
  LabRecordResponse,
  Error,
  LabRecordAddRequest
> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: LAB_RECORD_MUTATION_KEY,
    mutationFn: (request: LabRecordAddRequest) => api.addLabRecord(request),
    onSuccess: (response) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.labPatients });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.labPatientExpectations(response.patientId),
      });
    },
  });
}

export function useLabPatientExpectations(
  patientId: string | undefined,
): UseQueryResult<{ items: LabExpectationView[] }> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.labPatientExpectations(patientId ?? ''),
    queryFn: () => api.getLabPatientExpectations(patientId ?? ''),
    enabled: patientId !== undefined,
  });
}

export function useLabCases(): UseQueryResult<{ items: CaseView[] }> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.labCases,
    queryFn: () => api.getLabCases(),
  });
}

/** "See the impact on a date": moves the lab clinic's own clock forward. */
export function useAdvanceLabDate(): UseMutationResult<LabDateImpact, Error, string> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (date: string) => api.advanceLabDate(date),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['lab-clock'] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.labCases });
      // Every patient's expectations may have changed; refetch whichever is open.
      void queryClient.invalidateQueries({ queryKey: ['lab-patient-expectations'] });
    },
  });
}

export function useEvaluators(): UseQueryResult<EvaluatorsView> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.evaluators,
    queryFn: () => api.listEvaluators(),
    refetchInterval: 15_000,
  });
}

export function useEvaluatorEvents(
  evaluatorEmail: string | undefined,
): UseQueryResult<Page<EvaluatorEventView>> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.evaluatorEvents(evaluatorEmail),
    queryFn: () =>
      api.listEvaluatorEvents({ limit: 100, ...(evaluatorEmail ? { evaluatorEmail } : {}) }),
  });
}
