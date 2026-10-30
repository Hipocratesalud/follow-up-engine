import { keepPreviousData, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useApi } from '../../api/queries.ts';
import type { ClinicMetricsView, MetricsQuery } from './contract.ts';

export const metricsQueryKey = (query: MetricsQuery) => ['metrics', query] as const;

/**
 * The clinic metrics of a period (HIP-141); the previous period stays on
 * screen while loading. `enabled: false` holds off the request: the caller
 * is not ready to ask yet (its period boundary is still provisional, before
 * the demo clock is known).
 */
export function useMetrics(
  query: MetricsQuery,
  options: { readonly enabled?: boolean } = {},
): UseQueryResult<ClinicMetricsView> {
  const api = useApi();
  return useQuery({
    queryKey: metricsQueryKey(query),
    queryFn: () => api.getMetrics(query),
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
  });
}
