"use client";

/* StatsTab — Agent Editor "Stats" tab (per-agent drill-down, L08 Spec B).
   Base KPIs (runs/findings/accept-dismiss/pending/rates/cost/latency) +
   30d cost delta + all-time severity totals + weekly severity trend +
   ranked (approximate) skill/memory usage + studio run history, with a
   click-through into the shared RunTraceDrawer. */

import React from "react";
import { useTranslations } from "next-intl";
import {
  Badge,
  BarRow,
  CircularScore,
  EmptyState,
  ErrorState,
  MetricCard,
  Skeleton,
  SeverityBadge,
  WeeklyStackedBar,
} from "@devdigest/ui";
import type { Agent, AgentRankedUsageRow } from "@devdigest/shared";
import RunTraceDrawer from "@/components/RunTraceDrawer";
import { formatCost } from "@/lib/format";
import { useAgentStatsDetail } from "@/lib/hooks/agents";
import { formatLatency, isKnownRunStatus, runStatusMeta, weekLabel } from "./helpers";
import { s } from "./styles";

interface StatsTabProps {
  agent: Agent;
}

function KpiTile({ label, value, unit }: { label: string; value: React.ReactNode; unit?: string }) {
  return (
    <div style={s.tile}>
      <div style={s.tileLabel}>{label}</div>
      <div style={s.tileValue}>
        {value}
        {unit && <span style={s.tileUnit}>{unit}</span>}
      </div>
    </div>
  );
}

/** Ranked horizontal-bar list shared by "most-used skills" and "most-pulled
 *  memory" — both are `AgentRankedUsageRow[]`, an approximation per the
 *  shared contract's own doc comment (never a measured usage count). */
function RankedList({
  rows,
  emptyLabel,
  color,
}: {
  rows: AgentRankedUsageRow[];
  emptyLabel: string;
  color: string;
}) {
  if (rows.length === 0) {
    return <div style={s.rankedEmpty}>{emptyLabel}</div>;
  }
  const max = Math.max(...rows.map((r) => r.usage_estimate), 1);
  return (
    <div style={s.rankedList}>
      {rows.map((r) => (
        <BarRow key={r.id} label={r.name} value={r.usage_estimate} max={max} color={color} suffix={r.usage_estimate.toFixed(1)} />
      ))}
    </div>
  );
}

export function StatsTab({ agent }: StatsTabProps) {
  const t = useTranslations("agents");
  const { data: stats, isLoading, isError } = useAgentStatsDetail(agent.id);
  const [openRunId, setOpenRunId] = React.useState<string | null>(null);

  if (isLoading) {
    return (
      <div style={s.wrap} data-testid="stats-loading">
        <div style={s.loadingWrap}>
          <div style={s.tileGrid}>
            {Array.from({ length: 10 }).map((_, i) => (
              <Skeleton key={i} height={72} />
            ))}
          </div>
          <Skeleton height={160} />
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div style={s.wrap}>
        <ErrorState title={t("stats.error.title")} body={t("stats.error.body")} />
      </div>
    );
  }

  if (!stats || stats.runs === 0) {
    return (
      <div style={s.wrap}>
        <EmptyState icon="BarChart" title={t("stats.empty.title")} body={t("stats.empty.body")} />
      </div>
    );
  }

  const openRun = stats.run_history.find((r) => r.run_id === openRunId) ?? null;

  return (
    <div style={s.wrap}>
      {/* Base KPIs */}
      <div style={s.tileGrid}>
        <KpiTile label={t("stats.kpi.runs")} value={stats.runs} />
        <KpiTile label={t("stats.kpi.findingsTotal")} value={stats.findings_total} />
        <KpiTile label={t("stats.kpi.accepted")} value={stats.accepted} />
        <KpiTile label={t("stats.kpi.dismissed")} value={stats.dismissed} />
        <KpiTile label={t("stats.kpi.pending")} value={stats.pending} />
        <div style={s.tile}>
          <div style={s.tileLabel}>{t("stats.kpi.acceptRate")}</div>
          <div style={s.circularWrap}>
            {stats.accept_rate == null ? (
              <span style={s.mutedDash}>—</span>
            ) : (
              <CircularScore score={Math.round(stats.accept_rate * 100)} size={46} stroke={4} />
            )}
          </div>
        </div>
        <KpiTile
          label={t("stats.kpi.dismissRate")}
          value={stats.dismiss_rate == null ? "—" : `${Math.round(stats.dismiss_rate * 100)}%`}
        />
        <KpiTile
          label={t("stats.kpi.avgFindingsPerRun")}
          value={stats.avg_findings_per_run == null ? "—" : stats.avg_findings_per_run.toFixed(1)}
        />
        <KpiTile label={t("stats.kpi.avgCost")} value={formatCost(stats.avg_cost_usd)} />
        <KpiTile label={t("stats.kpi.avgLatency")} value={formatLatency(stats.avg_latency_ms)} />
      </div>

      {/* Total cost + 30d delta */}
      <div style={s.costCard}>
        <MetricCard
          label={t("stats.costDelta.label")}
          value={formatCost(stats.total_cost_usd)}
          delta={stats.cost_delta_usd_30d ?? undefined}
          invertColor
        />
      </div>

      {/* All-time findings by severity */}
      <div style={s.sectionLabel}>{t("stats.findingsBySeverity.title")}</div>
      <div style={s.severityRow}>
        <SeverityBadge severity="CRITICAL" count={stats.findings_by_severity.CRITICAL} />
        <SeverityBadge severity="WARNING" count={stats.findings_by_severity.WARNING} />
        <SeverityBadge severity="SUGGESTION" count={stats.findings_by_severity.SUGGESTION} />
      </div>

      {/* Weekly findings by severity */}
      <div style={s.sectionLabel}>{t("stats.weeklySeverity.title")}</div>
      <WeeklyStackedBar
        data={stats.weekly_findings_by_severity.map((w) => ({
          label: weekLabel(w.week_start),
          CRITICAL: w.CRITICAL,
          WARNING: w.WARNING,
          SUGGESTION: w.SUGGESTION,
        }))}
      />

      {/* Most-used skills (approximate) */}
      <div style={s.sectionLabel}>
        {t("stats.mostUsedSkills.title")}
        <span style={s.approxBadge}>{t("stats.approximate")}</span>
      </div>
      <RankedList rows={stats.most_used_skills} emptyLabel={t("stats.mostUsedSkills.empty")} color="var(--accent)" />

      {/* Most-pulled memory (approximate) — always [] today; dedicated empty state, never an empty chart shape */}
      <div style={s.sectionLabel}>
        {t("stats.memoryPulled.title")}
        <span style={s.approxBadge}>{t("stats.approximate")}</span>
      </div>
      <RankedList rows={stats.memory_pulled_summary} emptyLabel={t("stats.memoryPulled.empty")} color="var(--warn)" />

      {/* Run history — click a row to open the shared RunTraceDrawer */}
      <div style={s.sectionLabel}>{t("stats.runHistory.title")}</div>
      {stats.run_history.length === 0 ? (
        <div style={s.rankedEmpty}>{t("stats.runHistory.empty")}</div>
      ) : (
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th}>{t("stats.runHistory.columns.ranAt")}</th>
              <th style={s.th}>{t("stats.runHistory.columns.status")}</th>
              <th style={s.th}>{t("stats.runHistory.columns.pr")}</th>
              <th style={s.th}>{t("stats.runHistory.columns.findings")}</th>
              <th style={s.th}>{t("stats.runHistory.columns.cost")}</th>
            </tr>
          </thead>
          <tbody>
            {stats.run_history.map((row) => {
              const meta = runStatusMeta(row.status);
              const label = row.status && isKnownRunStatus(row.status) ? t(`stats.runHistory.status.${row.status}`) : (row.status ?? "—");
              return (
                <tr
                  key={row.run_id}
                  style={s.row}
                  onClick={() => setOpenRunId(row.run_id)}
                  data-testid={`stats-run-row-${row.run_id}`}
                >
                  <td style={s.td}>{new Date(row.ran_at).toLocaleString()}</td>
                  <td style={s.td}>
                    <Badge color={meta.color} bg={meta.bg}>
                      {label}
                    </Badge>
                  </td>
                  <td style={s.td}>{row.pr_number != null ? `#${row.pr_number}` : "—"}</td>
                  <td style={s.td}>{row.findings_count ?? "—"}</td>
                  <td style={s.td}>{formatCost(row.cost_usd)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {openRun && (
        <RunTraceDrawer
          runId={openRun.run_id}
          agentName={agent.name}
          prNumber={openRun.pr_number}
          running={openRun.status === "running"}
          onClose={() => setOpenRunId(null)}
        />
      )}
    </div>
  );
}
