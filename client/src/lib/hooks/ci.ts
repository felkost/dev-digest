/* hooks/ci.ts — React Query hooks for Export-to-CI (Agent Editor CI tab +
   Export Wizard) and the CI Runs page. Query shape mirrors hooks/blast.ts;
   mutation + invalidation shape mirrors hooks/agents.ts. */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type {
  CiAgentSurface,
  CiExportPreviewInput,
  CiExportPreview,
  CiExportInput,
  CiExport,
  CiBulkUpdateResult,
  CiDisconnectResult,
  CiRunsResponse,
  CiCheckResult,
} from "@devdigest/shared";

/** GET /agents/:id/ci — installations + 7-day rollup for the Agent Editor CI tab. */
export function useCiSurface(agentId: string | null | undefined) {
  return useQuery({
    queryKey: ["ci-surface", agentId],
    queryFn: ({ signal }) => api.get<CiAgentSurface>(`/agents/${agentId}/ci`, { signal }),
    enabled: !!agentId,
  });
}

/**
 * POST /repos/:repoId/agents/:agentId/ci/preview — no-side-effect file preview
 * used by the Export Wizard's Preview/Configure steps. No DB write, no GitHub call.
 */
export function useExportCiPreview(repoId: string | null | undefined, agentId: string | null | undefined) {
  return useMutation({
    mutationFn: (input: CiExportPreviewInput) =>
      api.post<CiExportPreview>(`/repos/${repoId}/agents/${agentId}/ci/preview`, input),
  });
}

/**
 * POST /repos/:repoId/agents/:agentId/export-ci — persists the installation
 * (opens a PR or returns a downloadable file set, depending on `input.action`).
 * A 409 ("repo already installed to a different agent") surfaces through this
 * mutation's normal `error` (`ApiError`) — no special handling needed here,
 * the caller renders the server's message inline.
 *
 * The route's response extends the persisted `CiExport` contract with a
 * one-time `secret_value` (the generated OpenRouter secret) — `CiExport`
 * itself deliberately excludes it so the ingest/list paths that also reuse
 * that type never re-expose a secret. Typed here so callers get the field
 * from inference, not an unchecked cast at the call site.
 */
export function useExportCi(repoId: string | null | undefined, agentId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CiExportInput) =>
      api.post<CiExport & { secret_value: string }>(`/repos/${repoId}/agents/${agentId}/export-ci`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ci-surface", agentId] });
    },
  });
}

/** POST /agents/:id/ci/bulk-update — re-publish current agent config to every tracked installation. */
export function useBulkUpdateCi(agentId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<CiBulkUpdateResult>(`/agents/${agentId}/ci/bulk-update`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ci-surface", agentId] });
    },
  });
}

/** POST /ci/installations/:id/disconnect — stop tracking; no GitHub/file-system side effect. */
export function useDisconnectCi(agentId: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (installationId: string) =>
      api.post<CiDisconnectResult>(`/ci/installations/${installationId}/disconnect`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ci-surface", agentId] });
    },
  });
}

export interface CiRunsFilters {
  agentId?: string;
  repo?: string;
  status?: string;
  sinceDays?: number;
}

/**
 * GET /ci/runs?... — CI Runs page table + last-checked timestamp. Filters map
 * to the server's snake_case query params. `refetchInterval` is left to the
 * consuming page (CiRunsView passes it so polling is tied to that page's own
 * mount lifecycle — React Query's observer stops it automatically on unmount,
 * satisfying "no independent schedule" without a manual setInterval).
 */
export function useCiRuns(filters: CiRunsFilters = {}, options?: { refetchInterval?: number }) {
  return useQuery({
    queryKey: ["ci-runs", filters],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams();
      if (filters.agentId) params.set("agent_id", filters.agentId);
      if (filters.repo) params.set("repo", filters.repo);
      if (filters.status) params.set("status", filters.status);
      if (filters.sinceDays != null) params.set("since_days", String(filters.sinceDays));
      const qs = params.toString();
      return api.get<CiRunsResponse>(`/ci/runs${qs ? `?${qs}` : ""}`, { signal });
    },
    refetchInterval: options?.refetchInterval,
  });
}

/** POST /ci/check — on-demand refresh of CI run statuses (Refresh button). */
export function useCiCheck() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<CiCheckResult>("/ci/check"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ci-runs"] });
    },
  });
}
