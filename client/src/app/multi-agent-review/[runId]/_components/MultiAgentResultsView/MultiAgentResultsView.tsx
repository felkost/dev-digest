/* MultiAgentResultsView — the results page (AC-14: always this page for an
   existing run, regardless of entry point). Composes the authoritative
   polled state (useMultiAgentRun), a live SSE nudge so a run settling
   doesn't wait for the next poll tick, the Columns/Tabs toggle (AC-20, no
   re-fetch on switch — both views read the same already-fetched `data`),
   the disagreement section, and the single reused RunTraceDrawer (AC-34/35)
   opened from any column, tab, or finding on this page. */
"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, ErrorState, Icon, Skeleton } from "@devdigest/ui";
import { AppShell } from "@/components/app-shell";
import RunTraceDrawer from "@/components/RunTraceDrawer";
import type { FindingRecord } from "@devdigest/shared";
import { useMultiAgentRun } from "@/lib/hooks/multi-agent-review";
import { usePullDetail } from "@/lib/hooks/core";
import { useRunEvents } from "@/lib/hooks/reviews";
import { ApiError } from "@/lib/api";
import { formatCost } from "@/lib/format";
import { formatDurationMs, formatTokenCount } from "@/app/multi-agent-review/format";
import { ColumnsView } from "./_components/ColumnsView";
import { TabsView } from "./_components/TabsView";
import { FindingsSummary } from "./_components/FindingsSummary/FindingsSummary";
import { DisagreementSection } from "./_components/DisagreementSection";

export function MultiAgentResultsView({ runId }: { runId: string }) {
  const t = useTranslations("multi-agent-review.results");
  const router = useRouter();

  const { data, isLoading, isError, error, refetch } = useMultiAgentRun(runId);
  // PR title for the header: the frozen MultiAgentRun contract carries only
  // pr_number, so the title is joined client-side from this existing endpoint
  // (no server/contract change, no restart). Disabled until pr_id is known.
  const { data: pr } = usePullDetail(data?.pr_id ?? null);
  // Full per-run findings come straight from the composed run's own
  // `findings_by_run` map — the SINGLE finding-detail source for this page
  // (Tabs view + the reused RunTraceDrawer). Deliberately NOT sourced from
  // usePrReviews / GET /pulls/:id/reviews, which excludes multi-agent fan-out
  // runs and would leave the Tabs/drawer showing an empty findings list while
  // the columns show findings.
  const findingsByRun = React.useMemo(
    () => new Map<string, FindingRecord[]>(Object.entries(data?.findings_by_run ?? {})),
    [data],
  );

  // Live per-agent nudge (NFR): one independent SSE subscription per
  // participating run (useRunEvents already does exactly that, unmodified).
  // When every still-running run's stream settles, refetch the composed run
  // immediately instead of waiting for the next poll tick — it carries columns,
  // conflicts AND findings_by_run, so this one refetch refreshes everything.
  const runningRunIds = React.useMemo(
    () => (data?.columns ?? []).filter((c) => c.status === "running").map((c) => c.run_id),
    [data],
  );
  const { running: liveRunning } = useRunEvents(runningRunIds);
  const wasRunning = React.useRef(false);
  React.useEffect(() => {
    if (liveRunning) wasRunning.current = true;
    else if (wasRunning.current) {
      wasRunning.current = false;
      refetch();
    }
  }, [liveRunning, refetch]);

  const [view, setView] = React.useState<"columns" | "tabs">("columns");
  const [traceRunId, setTraceRunId] = React.useState<string | null>(null);

  const crumb = [
    { label: t("crumb"), href: "/multi-agent-review" },
    { label: data ? t("runTitle", { number: data.pr_number ?? "—" }) : "…" },
  ];

  if (isLoading) {
    return (
      <AppShell crumb={crumb}>
        <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 16 }}>
          <Skeleton height={28} width={320} />
          <Skeleton height={200} />
        </div>
      </AppShell>
    );
  }

  if (isError || !data) {
    return (
      <AppShell crumb={crumb}>
        <ErrorState
          fullScreen
          title={t("loadErrorTitle")}
          body={error instanceof ApiError ? error.message : undefined}
          onRetry={() => refetch()}
        />
      </AppShell>
    );
  }

  const doneCount = data.columns.filter((c) => c.status === "done").length;
  const traceColumn = data.columns.find((c) => c.run_id === traceRunId) ?? null;

  return (
    <AppShell crumb={crumb}>
      <div style={{ padding: "24px 32px 48px", display: "flex", flexDirection: "column", gap: 20 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {/* Row 1 — feature title + view toggle. Per the design reference the
             h1 is the feature name ("Multi-Agent Review"), not "PR #N"; the PR
             reference moves to the meta row below. */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <Button kind="secondary" size="sm" icon="Settings" onClick={() => router.push("/multi-agent-review")}>
              {t("back")}
            </Button>
            <h1 style={{ fontSize: 20, fontWeight: 700 }}>{t("resultsTitle")}</h1>
            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>{t("agentCount", { count: data.agent_count })}</span>
            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <Button kind={view === "columns" ? "primary" : "secondary"} size="sm" onClick={() => setView("columns")}>
                {t("viewColumns")}
              </Button>
              <Button kind={view === "tabs" ? "primary" : "secondary"} size="sm" onClick={() => setView("tabs")}>
                {t("viewTabs")}
              </Button>
            </div>
          </div>

          {/* Row 2 — PR reference + title (left) and the run-wide meta (right),
             mirroring the design reference. The bold PR title is joined from
             usePullDetail (existing endpoint); the leading meta segments match
             the reference, and the run-total tokens (muted) stay appended so
             AC-33/36 keep their always-visible run-wide totals — never coercing
             a null token/cost count to 0. */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
              {data.pr_number != null && (
                <span className="mono" style={{ fontSize: 12.5, color: "var(--text-muted)", flexShrink: 0 }}>
                  #{data.pr_number}
                </span>
              )}
              {pr?.title && (
                <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>{pr.title}</span>
              )}
            </div>
            <div
              className="tnum"
              style={{
                marginLeft: "auto",
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 13,
                color: "var(--text-secondary)",
                flexWrap: "wrap",
              }}
            >
              <Icon.Boxes size={14} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
              <span>{t("agentCountShort", { count: data.agent_count })}</span>
              <span style={{ color: "var(--text-muted)" }}>·</span>
              <span>{t("durationTotal", { duration: formatDurationMs(data.total_duration_ms) })}</span>
              <span style={{ color: "var(--text-muted)" }}>·</span>
              <span>{data.total_cost_usd == null ? t("costUnknown") : formatCost(data.total_cost_usd)}</span>
              <span style={{ color: "var(--text-muted)" }}>·</span>
              <span style={{ color: "var(--text-muted)" }}>
                {t("totalTokensIn")}: {data.total_tokens_in == null ? t("tokensUnknown") : formatTokenCount(data.total_tokens_in)}
              </span>
              <span style={{ color: "var(--text-muted)" }}>·</span>
              <span style={{ color: "var(--text-muted)" }}>
                {t("totalTokensOut")}: {data.total_tokens_out == null ? t("tokensUnknown") : formatTokenCount(data.total_tokens_out)}
              </span>
            </div>
          </div>
        </div>

        {view === "columns" ? (
          <ColumnsView columns={data.columns} onOpenTrace={setTraceRunId} />
        ) : (
          <TabsView columns={data.columns} findingsByRun={findingsByRun} prId={data.pr_id} onOpenTrace={setTraceRunId} />
        )}

        <FindingsSummary columns={data.columns} findingsByRun={findingsByRun} prId={data.pr_id} />

        <DisagreementSection conflicts={data.conflicts} doneCount={doneCount} />
      </div>

      {traceRunId && (
        <RunTraceDrawer
          runId={traceRunId}
          agentName={traceColumn?.agent_name ?? null}
          prNumber={data.pr_number ?? null}
          findings={findingsByRun.get(traceRunId) ?? []}
          running={traceColumn?.status === "running"}
          onClose={() => setTraceRunId(null)}
        />
      )}
    </AppShell>
  );
}
