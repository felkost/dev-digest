/* RecentRuns — the workspace's recent multi-agent groups (newest first), so
   a results page is still reachable after the post-start one-time redirect
   is gone (tab closed / navigated away during a long fan-out — there was
   previously no way back short of the run's raw URL). Split out of
   ConfigureRunView to keep that container under the component-size
   guideline, same rationale as AgentRow. */
"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Card, EmptyState, Icon, SectionLabel, Skeleton, type IconName } from "@devdigest/ui";
import type { MultiAgentRunSummary } from "@devdigest/shared";
import { formatCost } from "@/lib/format";
import { formatDurationMs } from "@/app/multi-agent-review/format";
import { useMultiAgentRunHistory } from "@/lib/hooks/multi-agent-review";

// Mirrors ColumnsView's own STATUS_ICON/STATUS_COLOR maps (accepted
// duplication — see MultiAgentPicker.tsx's header comment on this pattern):
// a group's aggregate status uses the exact same 3-state vocabulary.
const STATUS_ICON: Record<MultiAgentRunSummary["status"], IconName> = {
  running: "RefreshCw",
  done: "CheckCircle",
  failed: "XCircle",
};
const STATUS_COLOR: Record<MultiAgentRunSummary["status"], string> = {
  running: "var(--accent)",
  done: "var(--ok)",
  failed: "var(--crit)",
};

export function RecentRuns() {
  const t = useTranslations("multi-agent-review.configureRun.recentRuns");
  const router = useRouter();
  const { data: runs, isLoading } = useMultiAgentRunHistory();

  return (
    <Card>
      <SectionLabel icon="History">{t("title")}</SectionLabel>
      {isLoading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Skeleton height={52} />
          <Skeleton height={52} />
        </div>
      ) : !runs || runs.length === 0 ? (
        <EmptyState icon="History" title={t("empty")} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {runs.map((run) => {
            const StatusIcon = Icon[STATUS_ICON[run.status]];
            return (
              <div
                key={run.id}
                onClick={() => router.push(`/multi-agent-review/${run.id}`)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "10px 12px",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  cursor: "pointer",
                }}
              >
                <StatusIcon
                  size={14}
                  style={{
                    color: STATUS_COLOR[run.status],
                    flexShrink: 0,
                    ...(run.status === "running" ? { animation: "ddspin 1s linear infinite" } : {}),
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {run.pr_number != null ? `#${run.pr_number}` : "—"}
                    {run.pr_title ? ` · ${run.pr_title}` : ""}
                  </div>
                  <div className="tnum" style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                    {new Date(run.ran_at).toLocaleString()} · {t("agentsCount", { count: run.agent_count })} ·{" "}
                    {t("findingsCount", { count: run.findings_total })}
                  </div>
                </div>
                <div className="tnum" style={{ fontSize: 12, color: "var(--text-secondary)", flexShrink: 0, textAlign: "right" }}>
                  <div>{formatDurationMs(run.total_duration_ms)}</div>
                  <div>{formatCost(run.total_cost_usd)}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
