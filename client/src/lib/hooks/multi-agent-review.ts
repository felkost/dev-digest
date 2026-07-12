/* hooks/multi-agent-review.ts — React Query hooks for the multi-agent review
   feature: start a grouped run, read its composed columns/conflicts, and
   read pre-run per-agent duration/cost estimates. Follows the exact
   conventions in reviews.ts (query key shape, poll-while-running pattern). */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { AgentEstimate, MultiAgentRun, MultiAgentRunStartResponse } from "@devdigest/shared";

/** Poll cadence while a multi-agent run has at least one still-running column. */
const MULTI_AGENT_RUN_POLL_INTERVAL_MS = 4000;

// ---- Pre-run per-agent duration/cost estimates (from run history) ----
export function useAgentEstimates(prId: string | null | undefined) {
  return useQuery({
    queryKey: ["agent-estimates", prId],
    queryFn: () => api.get<AgentEstimate[]>(`/pulls/${prId}/agent-estimates`),
    enabled: !!prId,
  });
}

// ---- Start a grouped multi-agent run ----
/** Fixed at the hook level (not per call site) so every caller gets the same
   cache invalidation as useRunReview, without each call site needing to
   remember to do it manually via its own onRunsStarted callback. */
export function useStartMultiAgentRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ prId, agentIds }: { prId: string; agentIds: string[] }) =>
      api.post<MultiAgentRunStartResponse>(`/pulls/${prId}/multi-agent-run`, { agentIds }),
    onSuccess: (_d, { prId }) => {
      qc.invalidateQueries({ queryKey: ["reviews", prId] });
      qc.invalidateQueries({ queryKey: ["pr-runs", prId] });
      qc.invalidateQueries({ queryKey: ["pr-active-runs", prId] });
    },
  });
}

// ---- Read a composed multi-agent run (columns + conflicts) ----
/** Polls while any column is still 'running'; stops once every column has
   settled ('done'/'failed'), same pattern as usePrRuns/usePrActiveRuns. */
export function useMultiAgentRun(groupId: string | null | undefined) {
  return useQuery({
    queryKey: ["multi-agent-run", groupId],
    queryFn: () => api.get<MultiAgentRun>(`/multi-agent-runs/${groupId}`),
    enabled: !!groupId,
    refetchInterval: (query) =>
      (query.state.data?.columns ?? []).some((c) => c.status === "running")
        ? MULTI_AGENT_RUN_POLL_INTERVAL_MS
        : false,
  });
}
