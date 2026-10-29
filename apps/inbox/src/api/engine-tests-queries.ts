import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useApi } from './queries.ts';
import type {
  EngineTestCatalog,
  EngineTestFreeformRequest,
  EngineTestStartResponse,
  EngineTestStepOutcome,
  EngineTestStepValue,
  EngineTestVerdictRequest,
} from './engine-tests-contract.ts';

export const engineTestsQueryKeys = {
  catalog: ['engine-tests'] as const,
};

/** The engine tests catalog, with each test's review status, step count and the overall progress. */
export function useEngineTests(): UseQueryResult<EngineTestCatalog | null> {
  const api = useApi();
  return useQuery({
    queryKey: engineTestsQueryKeys.catalog,
    queryFn: async () => (await api.getEngineTests()) ?? null,
  });
}

/** Starts (or restarts) a scenario: a fresh fictitious patient and every step's pre-filled suggestion. */
export function useStartEngineTest(): UseMutationResult<EngineTestStartResponse, Error, string> {
  const api = useApi();
  return useMutation({
    mutationFn: (id: string) => api.startEngineTest(id),
  });
}

export interface SubmitStepInput {
  readonly id: string;
  readonly step: number;
  readonly day0: string;
  readonly patientId: string;
  readonly value: EngineTestStepValue;
}

/** Applies one step's (possibly edited) input through the real engine. */
export function useSubmitEngineTestStep(): UseMutationResult<
  EngineTestStepOutcome,
  Error,
  SubmitStepInput
> {
  const api = useApi();
  return useMutation({
    mutationFn: ({ id, step, day0, patientId, value }) =>
      api.submitEngineTestStep(id, step, { day0, patientId, value }),
  });
}

export interface SubmitFreeformInput {
  readonly id: string;
  readonly body: EngineTestFreeformRequest;
}

/** "Try anything else": a free-form record or document action, outside any numbered step. */
export function useSubmitEngineTestFreeform(): UseMutationResult<
  EngineTestStepOutcome,
  Error,
  SubmitFreeformInput
> {
  const api = useApi();
  return useMutation({
    mutationFn: ({ id, body }) => api.submitEngineTestFreeform(id, body),
  });
}

export interface SubmitVerdictInput {
  readonly id: string;
  readonly body: EngineTestVerdictRequest;
}

/** The physician's verdict on one test, which moves the progress bar. */
export function useSubmitEngineTestVerdict(): UseMutationResult<
  unknown,
  Error,
  SubmitVerdictInput
> {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: SubmitVerdictInput) => api.submitEngineTestVerdict(id, body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: engineTestsQueryKeys.catalog });
    },
  });
}
