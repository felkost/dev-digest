/* hooks/agent-performance.ts — Agent Performance page (fleet), L08 Spec B Step 7. */
"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { AgentPerf } from "@devdigest/shared";

/**
 * Fetch the workspace-wide Agent Performance summary (KPI row, cost-by-agent /
 * cost-by-model breakdowns, and the per-agent table rows). No filters — the
 * table's sort control reorders the already-fetched `agents` array
 * client-side (AC-4), it never re-queries this hook.
 */
export function useAgentPerformance() {
  return useQuery({
    queryKey: ["agent-performance"],
    queryFn: ({ signal }) => api.get<AgentPerf>("/agents/performance", { signal }),
  });
}
