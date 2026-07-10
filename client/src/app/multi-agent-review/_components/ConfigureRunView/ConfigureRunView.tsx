/* ConfigureRunView — the Configure-run flow (AC-10/11/12): step 1 picks a
   repo + PR, step 2 picks agents (inert until a PR is chosen) with
   pre-run duration/cost estimates (AC-6-9), confirm starts a grouped
   multi-agent run and navigates to its results page. Mirrors the agent
   picker's estimate math independently of the cross-route
   `multi-agent-picker` component (accepted-duplication note — this flow
   owns its own repo/PR-first UX, the picker owns the existing PR-first
   surfaces). */
"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, Card, EmptyState, FormField, Icon, SectionLabel, SelectInput, Skeleton } from "@devdigest/ui";
import { AppShell } from "@/components/app-shell";
import { useActiveRepo } from "@/lib/repo-context";
import { useRepos, usePulls, useAgents } from "@/lib/hooks";
import { useAgentEstimates, useStartMultiAgentRun } from "@/lib/hooks/multi-agent-review";
import { formatCost } from "@/lib/format";
import { formatDurationMs } from "@/app/multi-agent-review/format";
import { combineEstimates } from "./helpers";
import { AgentRow } from "./AgentRow";

export function ConfigureRunView() {
  const t = useTranslations("multi-agent-review.configureRun");
  const router = useRouter();

  // ---- Step 1: repo + PR ----------------------------------------------------
  const { repoId: activeRepoId } = useActiveRepo();
  const { data: repos, isLoading: reposLoading } = useRepos();
  const [repoIdSel, setRepoIdSel] = React.useState<string>("");
  const repoId = repoIdSel || activeRepoId || repos?.[0]?.id || "";

  const { data: pulls, isLoading: pullsLoading } = usePulls(repoId || null);
  const validPulls = React.useMemo(
    () => (pulls ?? []).filter((p): p is typeof p & { id: string } => !!p.id),
    [pulls],
  );
  const [prIdSel, setPrIdSel] = React.useState<string>("");
  // Auto-invalidates the display once the repo changes (the previous
  // selection no longer appears in this repo's PR list) without an effect.
  const prId = validPulls.some((p) => p.id === prIdSel) ? prIdSel : "";

  // ---- Step 2: agents + estimates (inert until a PR is chosen, AC-11) ------
  const { data: agents } = useAgents();
  const enabledAgents = React.useMemo(() => (agents ?? []).filter((a) => a.enabled), [agents]);
  const [selectedAgentIds, setSelectedAgentIds] = React.useState<string[]>([]);

  const { data: estimates } = useAgentEstimates(prId || null);
  const estByAgent = React.useMemo(
    () => new Map((estimates ?? []).map((e) => [e.agent_id, e])),
    [estimates],
  );
  const combined = combineEstimates(selectedAgentIds, estimates ?? []);

  const start = useStartMultiAgentRun();

  const toggleAgent = (id: string) =>
    setSelectedAgentIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const selectAll = () => setSelectedAgentIds(enabledAgents.map((a) => a.id));
  const clearAll = () => setSelectedAgentIds([]);

  const onConfirm = () => {
    if (!prId || selectedAgentIds.length === 0) return;
    start.mutate(
      { prId, agentIds: selectedAgentIds },
      { onSuccess: (res) => router.push(`/multi-agent-review/${res.multi_agent_run_id}`) },
    );
  };

  const repoOptions = (repos ?? []).map((r) => ({ value: r.id, label: r.full_name }));
  const prOptions = [
    { value: "", label: t("prPlaceholder") },
    ...validPulls.map((p) => ({ value: p.id, label: `#${p.number} · ${p.title}` })),
  ];

  const crumb = [{ label: t("crumb") }];

  return (
    <AppShell crumb={crumb}>
      <div style={{ padding: "28px 32px 60px", maxWidth: 760, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, display: "flex", alignItems: "center", gap: 10 }}>
          <Icon.Users size={20} style={{ color: "var(--accent)" }} />
          {t("pageTitle")}
        </h1>

        <Card>
          <SectionLabel icon="GitPullRequest">{t("step1Title")}</SectionLabel>
          <FormField label={t("repoLabel")}>
            {reposLoading ? (
              <Skeleton height={38} />
            ) : (
              <SelectInput
                mono={false}
                value={repoId}
                onChange={(v) => {
                  setRepoIdSel(v);
                  setPrIdSel("");
                }}
                options={repoOptions}
              />
            )}
          </FormField>
          <FormField label={t("prLabel")}>
            {pullsLoading ? (
              <Skeleton height={38} />
            ) : validPulls.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{t("noPulls")}</div>
            ) : (
              <SelectInput mono={false} value={prId} onChange={setPrIdSel} options={prOptions} />
            )}
          </FormField>
        </Card>

        <Card>
          <SectionLabel icon="Cpu">{t("step2Title")}</SectionLabel>
          {!prId ? (
            <EmptyState icon="GitPullRequest" title={t("step2Prompt")} />
          ) : enabledAgents.length === 0 ? (
            <EmptyState
              icon="Cpu"
              title={t("noEnabledAgentsTitle")}
              body={t("noEnabledAgentsBody")}
              cta={t("noEnabledAgentsCta")}
              onCta={() => router.push("/agents")}
            />
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                <Button kind="ghost" size="sm" onClick={selectAll}>
                  {t("selectAll")}
                </Button>
                <Button kind="ghost" size="sm" onClick={clearAll}>
                  {t("clearSelection")}
                </Button>
                <span style={{ marginLeft: "auto", fontSize: 12.5, color: "var(--text-muted)" }}>
                  {t("selectedCount", { count: selectedAgentIds.length })}
                </span>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {enabledAgents.map((a) => (
                  <AgentRow
                    key={a.id}
                    agent={a}
                    estimate={estByAgent.get(a.id)}
                    checked={selectedAgentIds.includes(a.id)}
                    onToggle={() => toggleAgent(a.id)}
                  />
                ))}
              </div>

              {selectedAgentIds.length > 0 && (
                <div className="tnum" style={{ marginTop: 14, fontSize: 13, color: "var(--text-secondary)" }}>
                  {t(combined.missing ? "combinedEstimateIncomplete" : "combinedEstimate", {
                    duration: formatDurationMs(combined.maxDurationMs),
                    cost: formatCost(combined.sumCostUsd),
                  })}
                </div>
              )}

              <div style={{ marginTop: 18 }}>
                <Button
                  kind="primary"
                  icon="Sparkles"
                  loading={start.isPending}
                  disabled={selectedAgentIds.length === 0 || start.isPending}
                  onClick={onConfirm}
                >
                  {start.isPending ? t("starting") : t("confirm")}
                </Button>
              </div>
            </>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
