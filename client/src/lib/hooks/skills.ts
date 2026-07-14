/* hooks/skills.ts — React Query hooks for the Skills Lab (A1). */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { Skill, SkillType, SkillSource, SkillVersion, SkillStats, ImportPreview, EvalCase, AgentSkillLink } from "@devdigest/shared";

// ---- Skills CRUD -----------------------------------------------------------

export function useSkills() {
  return useQuery({
    queryKey: ["skills"],
    queryFn: ({ signal }) => api.get<Skill[]>("/skills", { signal }),
  });
}

export function useSkill(id: string | null | undefined) {
  return useQuery({
    queryKey: ["skill", id],
    queryFn: ({ signal }) => api.get<Skill>(`/skills/${id}`, { signal }),
    enabled: !!id,
  });
}

export interface CreateSkillInput {
  name: string;
  description?: string;
  type: SkillType;
  source?: SkillSource;
  body: string;
  enabled?: boolean;
}

export function useCreateSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSkillInput) => api.post<Skill>("/skills", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["skills"] }),
  });
}

export interface UpdateSkillInput {
  id: string;
  patch: {
    name?: string;
    description?: string;
    type?: SkillType;
    body?: string;
    enabled?: boolean;
  };
}

export function useUpdateSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: UpdateSkillInput) => api.patch<Skill>(`/skills/${id}`, patch),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["skills"] });
      qc.setQueryData(["skill", data.id], data);
    },
  });
}

export function useDeleteSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ ok: boolean }>(`/skills/${id}`),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ["skills"] });
      qc.removeQueries({ queryKey: ["skill", id] });
    },
  });
}

// ---- Versions --------------------------------------------------------------

export function useSkillVersions(skillId: string | null | undefined) {
  return useQuery({
    queryKey: ["skill-versions", skillId],
    queryFn: ({ signal }) => api.get<SkillVersion[]>(`/skills/${skillId}/versions`, { signal }),
    enabled: !!skillId,
  });
}

export function useRestoreSkillVersion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ skillId, version }: { skillId: string; version: number }) =>
      api.post<Skill>(`/skills/${skillId}/versions/${version}/restore`),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["skills"] });
      qc.setQueryData(["skill", data.id], data);
      qc.invalidateQueries({ queryKey: ["skill-versions", data.id] });
    },
  });
}

// ---- Stats -----------------------------------------------------------------

export function useSkillStats(skillId: string | null | undefined) {
  return useQuery({
    queryKey: ["skill-stats", skillId],
    queryFn: ({ signal }) => api.get<SkillStats>(`/skills/${skillId}/stats`, { signal }),
    enabled: !!skillId,
    staleTime: 60_000,
  });
}

// ---- Import ----------------------------------------------------------------

export function useImportPreview() {
  return useMutation({
    mutationFn: (input: { name: string; filename: string; content_base64: string }) =>
      api.post<ImportPreview>("/skills/import", input),
  });
}

export function useConfirmImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      name: string;
      description: string;
      type: SkillType;
      body: string;
      source: SkillSource;
      enabled?: boolean;
    }) => api.post<Skill>("/skills/import/confirm", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["skills"] }),
  });
}

// ---- Eval cases (existing eval_cases table, owner_kind='skill') ------------

export type SkillEvalCase = EvalCase & {
  last_run?: { pass: boolean | null; ran_at: string } | null;
};

export function useSkillEvals(skillId: string | null | undefined) {
  return useQuery({
    queryKey: ["skill-evals", skillId],
    queryFn: ({ signal }) => api.get<SkillEvalCase[]>(`/skills/${skillId}/evals`, { signal }),
    enabled: !!skillId,
  });
}

export function useCreateSkillEval(skillId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; input_diff: string; expected_output: unknown; notes?: string }) =>
      api.post<SkillEvalCase>(`/skills/${skillId}/evals`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["skill-evals", skillId] }),
  });
}

export function useDeleteSkillEval(skillId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (caseId: string) => api.del<{ ok: boolean }>(`/skills/${skillId}/evals/${caseId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["skill-evals", skillId] }),
  });
}

// ---- Agent ↔ Skills linking (used by Agent Editor SkillsTab) --------------

export function useAgentSkills(agentId: string | null | undefined) {
  return useQuery({
    queryKey: ["agent-skills", agentId],
    queryFn: ({ signal }) => api.get<AgentSkillLink[]>(`/agents/${agentId}/skills`, { signal }),
    enabled: !!agentId,
  });
}

export function useSetAgentSkills(agentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (skillIds: string[]) =>
      api.post<AgentSkillLink[]>(`/agents/${agentId}/skills`, { skill_ids: skillIds }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agent-skills", agentId] }),
  });
}

export function useLinkAgentSkill(agentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ skillId, order }: { skillId: string; order: number }) =>
      api.post<AgentSkillLink[]>(`/agents/${agentId}/skills`, { skill_id: skillId, order }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["agent-skills", agentId] }),
  });
}
