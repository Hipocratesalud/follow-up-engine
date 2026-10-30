import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { AgentMessageView, AgentPageView, AgentStoryRequest } from './agent-contract.ts';
import { useApi } from './queries.ts';

export const agentQueryKeys = {
  page: (patientId: string | undefined) => ['agent', patientId ?? 'latest'] as const,
  all: ['agent'] as const,
};

/** Poll faster while the agent works, so the console streams its steps. */
const BUSY_POLL_MS = 1_200;
const IDLE_POLL_MS = 5_000;

/** The agent page (the given or latest patient), polled: the console is live. */
export function useAgentPage(patientId: string | undefined): UseQueryResult<AgentPageView> {
  const api = useApi();
  return useQuery({
    queryKey: agentQueryKeys.page(patientId),
    queryFn: () => api.getAgent(patientId),
    refetchInterval: (query) =>
      query.state.data?.conversation?.busy === true ? BUSY_POLL_MS : IDLE_POLL_MS,
  });
}

function useInvalidateAgent(): () => Promise<void> {
  const queryClient = useQueryClient();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: agentQueryKeys.all });
    await queryClient.invalidateQueries({ queryKey: ['lab-clock'] });
  };
}

export function useStartAgentStory(): UseMutationResult<
  { patientId: string },
  Error,
  AgentStoryRequest
> {
  const api = useApi();
  const invalidate = useInvalidateAgent();
  return useMutation({
    mutationFn: (body: AgentStoryRequest) => api.startAgentStory(body),
    onSuccess: invalidate,
  });
}

export type PatientInput =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'file'; readonly file: File }
  | { readonly kind: 'sample'; readonly sample: 'lab_report' | 'voice_note' };

export function useSendPatientMessage(
  patientId: string,
): UseMutationResult<AgentMessageView, Error, PatientInput> {
  const api = useApi();
  const invalidate = useInvalidateAgent();
  return useMutation({
    mutationFn: (input: PatientInput) => {
      switch (input.kind) {
        case 'text':
          return api.sendAgentText(patientId, input.text);
        case 'file':
          return api.sendAgentFile(patientId, input.file);
        case 'sample':
          return api.sendAgentSample(patientId, input.sample);
      }
    },
    onSuccess: invalidate,
  });
}

export function useSetDelivery(): UseMutationResult<
  AgentMessageView,
  Error,
  { messageId: string; status: 'delivered' | 'read' | 'undelivered' }
> {
  const api = useApi();
  const invalidate = useInvalidateAgent();
  return useMutation({
    mutationFn: ({ messageId, status }) => api.setAgentDelivery(messageId, status),
    onSuccess: invalidate,
  });
}

export function useFixPhone(patientId: string): UseMutationResult<void, Error, void> {
  const api = useApi();
  const invalidate = useInvalidateAgent();
  return useMutation({ mutationFn: () => api.fixAgentPhone(patientId), onSuccess: invalidate });
}

export function useAdvanceAgentClock(): UseMutationResult<
  { from: string; to: string },
  Error,
  number
> {
  const api = useApi();
  const invalidate = useInvalidateAgent();
  return useMutation({
    mutationFn: (days: number) => api.advanceAgentClock(days),
    onSuccess: invalidate,
  });
}

/** An object URL for a stored voice note or photo (fetched with the API key), revoked on unmount. */
export function useAgentMediaUrl(mediaId: string | undefined): string | undefined {
  const api = useApi();
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (mediaId === undefined) return undefined;
    let active = true;
    let created: string | undefined;
    void api
      .getAgentMedia(mediaId)
      .then((blob) => {
        if (!active) return;
        created = URL.createObjectURL(blob);
        setUrl(created);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      if (created !== undefined) URL.revokeObjectURL(created);
    };
  }, [api, mediaId]);
  return url;
}
