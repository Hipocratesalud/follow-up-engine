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
  EngineTestRunResult,
  EngineTestVerdictRequest,
} from './engine-tests-contract.ts';

export const engineTestsQueryKeys = {
  catalog: ['engine-tests'] as const,
};

/** The engine tests catalog, with each test's review status and the overall progress. */
export function useEngineTests(): UseQueryResult<EngineTestCatalog | null> {
  const api = useApi();
  return useQuery({
    queryKey: engineTestsQueryKeys.catalog,
    queryFn: async () => (await api.getEngineTests()) ?? null,
  });
}

/** Runs one scenario against the real engine, in the evaluator's own lab clinic. */
export function useRunEngineTest(): UseMutationResult<EngineTestRunResult, Error, string> {
  const api = useApi();
  return useMutation({
    mutationFn: (id: string) => api.runEngineTest(id),
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
