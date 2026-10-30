import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useApi } from '../../api/queries.ts';
import { isRunning, type SimulationResponse } from './contract.ts';

export const valueSimulationQueryKey = ['value', 'simulation'] as const;

/** Poll interval while the API is still computing the simulation. */
const RUNNING_POLL_MS = 1500;

function pollWhileRunning(query: {
  readonly state: { readonly data: SimulationResponse | undefined };
}): number | false {
  const data = query.state.data;
  return data !== undefined && isRunning(data) ? RUNNING_POLL_MS : false;
}

/**
 * The simulation report. It never changes for a given config, so it is
 * kept for the session; while the API is still computing it the query
 * polls.
 */
export function useValueSimulation(): UseQueryResult<SimulationResponse> {
  const api = useApi();
  return useQuery({
    queryKey: valueSimulationQueryKey,
    queryFn: () => api.getValueSimulation(),
    staleTime: Infinity,
    refetchInterval: pollWhileRunning,
  });
}
