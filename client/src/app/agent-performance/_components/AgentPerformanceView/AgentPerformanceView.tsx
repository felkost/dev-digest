"use client";

/* AgentPerformanceView — workspace-wide Agent Performance page (`/agent-performance`,
   L08 Spec B Step 7). Composes:
     - a 4-card KPI summary (total runs, trailing-30d cost + delta, blended
       accept-rate, most-active agent)                                  (AC-1)
     - two cost-breakdown donuts (by agent, by model), trailing 30d      (AC-2)
     - a per-agent table (including zero-run agents) with a client-side
       sort control (accept-rate / runs / cost) and row-click navigation
       to that agent's Stats tab                                (AC-3, AC-4, AC-5)

   Reachable from the sidebar nav (AC-6). Loading/empty/error states mirror
   the Skills Lab StatsTab skeleton pattern and the CI Runs page's
   load-error-with-no-retry convention (AC-7, AC-8, AC-9). */

import React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Donut,
  EmptyState,
  ErrorState,
  Icon,
  MetricCard,
  Skeleton,
  SelectInput,
  Sparkline,
  type DonutSegment,
  type IconName,
} from "@devdigest/ui";
import { AppShell } from "@/components/app-shell";
import { useAgentPerformance } from "@/lib/hooks/agent-performance";
import { formatCost } from "@/lib/format";
import type { AgentPerfRow, PerfCostSegment } from "@devdigest/shared";
import { s } from "./styles";

const DONUT_COLORS = ["#ef4444", "#f59e0b", "#3b82f6", "#8b5cf6", "#10b981", "#6366f1"];

type SortKey = "acceptRate" | "runs" | "cost";
const SORT_KEYS: SortKey[] = ["acceptRate", "runs", "cost"];

function sortRows(rows: AgentPerfRow[], key: SortKey): AgentPerfRow[] {
  const copy = [...rows];
  if (key === "runs") copy.sort((a, b) => b.runs - a.runs);
  else if (key === "cost") copy.sort((a, b) => (b.total_cost_usd ?? -1) - (a.total_cost_usd ?? -1));
  else copy.sort((a, b) => (b.accept_rate ?? -1) - (a.accept_rate ?? -1));
  return copy;
}

/** Segments with `value: null` (AC-28) render as a muted "—" legend row,
 *  never passed to the pie as 0. */
function CostDonutCard({
  titleIcon,
  title,
  segments,
  noCostLabel,
}: {
  titleIcon: IconName;
  title: string;
  segments: PerfCostSegment[];
  noCostLabel: string;
}) {
  const TitleIcon = Icon[titleIcon];
  const known = segments.filter((seg): seg is PerfCostSegment & { value: number } => seg.value != null);
  const unknown = segments.filter((seg) => seg.value == null);
  const donutSegments: DonutSegment[] = known.map((seg, i) => ({
    label: seg.label,
    value: seg.value,
    color: DONUT_COLORS[i % DONUT_COLORS.length]!,
  }));

  return (
    <div style={s.donutCard}>
      <div style={s.donutHeader}>
        <TitleIcon size={13} />
        {title}
      </div>
      {known.length === 0 ? (
        <div style={s.noCost}>{noCostLabel}</div>
      ) : (
        <>
          <Donut segments={donutSegments} />
          {unknown.length > 0 && (
            <div style={s.unknownList}>
              {unknown.map((seg) => (
                <div key={seg.label} style={s.unknownRow}>
                  <span style={s.unknownDot} />
                  <span style={s.unknownLabel}>{seg.label}</span>
                  <span style={s.unknownValue}>—</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function AgentRow({ row, onOpen }: { row: AgentPerfRow; onOpen: (agentId: string) => void }) {
  const accept = row.accept_rate != null ? `${Math.round(row.accept_rate * 100)}%` : "—";
  return (
    <div
      style={s.row}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(row.agent_id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(row.agent_id);
        }
      }}
      data-testid={`agent-perf-row-${row.agent_id}`}
    >
      <div style={s.agentCell}>
        <div style={s.agentIconBox}>
          <Icon.Cpu size={14} />
        </div>
        <div style={s.agentText}>
          <span style={s.cellPrimary}>{row.agent_name}</span>
          {row.model && <div style={s.cellSecondary}>{row.model}</div>}
        </div>
      </div>
      <div>
        <span style={s.cellPrimary}>{accept}</span>
      </div>
      <div>
        <span style={s.cellPrimary}>{row.runs}</span>
      </div>
      <div>
        <span style={s.cellPrimary}>{row.findings_total}</span>
      </div>
      <div>
        <span style={s.cellPrimary}>{formatCost(row.total_cost_usd)}</span>
      </div>
      <div>
        {row.cost_trend.length > 0 ? (
          <Sparkline data={row.cost_trend} w={72} h={22} />
        ) : (
          <span style={s.muted}>—</span>
        )}
      </div>
    </div>
  );
}

export function AgentPerformanceView() {
  const t = useTranslations("agentPerformance");
  const router = useRouter();
  const { data, isLoading, isError } = useAgentPerformance();
  const [sortKey, setSortKey] = React.useState<SortKey>("acceptRate");

  const crumb = [{ label: t("title") }];

  const openAgentStats = (agentId: string) => router.push(`/agents/${agentId}?tab=stats`);

  if (isLoading) {
    return (
      <AppShell crumb={crumb}>
        <div style={s.page}>
          <div style={s.kpiRow}>
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} height={92} style={{ flex: 1, minWidth: 200 }} />
            ))}
          </div>
          <div style={s.loadingStack}>
            <Skeleton height={180} />
            <Skeleton height={28} />
            <Skeleton height={28} />
            <Skeleton height={28} />
          </div>
        </div>
      </AppShell>
    );
  }

  if (isError || !data) {
    return (
      <AppShell crumb={crumb}>
        <div style={s.page}>
          <ErrorState body={t("loadError")} />
        </div>
      </AppShell>
    );
  }

  const { summary, agents, cost_by_agent, cost_by_model } = data;

  if (summary.total_runs_all_time === 0) {
    return (
      <AppShell crumb={crumb}>
        <div style={s.page}>
          <EmptyState icon="Cpu" title={t("empty.title")} body={t("empty.body")} />
        </div>
      </AppShell>
    );
  }

  const sortedAgents = sortRows(agents, sortKey);

  const sortOptions = SORT_KEYS.map((key) => ({ value: key, label: t(`sort.${key}`) }));

  return (
    <AppShell crumb={crumb}>
      <div style={s.page}>
        <div style={s.header}>
          <h1 style={s.h1}>{t("title")}</h1>
          <p style={s.subtitle}>{t("subtitle")}</p>
        </div>

        <div style={s.kpiRow}>
          <div style={s.kpiCardWrap}>
            <MetricCard label={t("summary.totalRuns")} value={summary.total_runs_all_time} />
          </div>
          <div style={s.kpiCardWrap} title={t("summary.costDelta")}>
            <MetricCard
              label={t("summary.totalCost")}
              value={formatCost(summary.total_cost_usd_30d)}
              delta={summary.cost_delta_usd_30d ?? undefined}
              invertColor
            />
          </div>
          <div style={s.kpiCardWrap}>
            <MetricCard
              label={t("summary.avgAcceptRate")}
              value={summary.avg_accept_rate_pct_30d != null ? Math.round(summary.avg_accept_rate_pct_30d) : "—"}
              suffix={summary.avg_accept_rate_pct_30d != null ? "%" : undefined}
            />
          </div>
          <div style={s.kpiCardWrap}>
            <MetricCard
              label={t("summary.mostActive")}
              value={
                summary.most_active_agent ? (
                  <span style={s.mostActiveValue}>
                    <span style={s.mostActiveName}>{summary.most_active_agent.agent_name}</span>
                    <span style={s.mostActiveSub}>
                      {t("summary.mostActiveRuns", { count: summary.most_active_agent.runs_30d })}
                    </span>
                  </span>
                ) : (
                  "—"
                )
              }
            />
          </div>
        </div>

        <div style={s.donutsRow}>
          <CostDonutCard titleIcon="Cpu" title={t("costByAgent")} segments={cost_by_agent} noCostLabel={t("noCost")} />
          <CostDonutCard titleIcon="Layers" title={t("costByModel")} segments={cost_by_model} noCostLabel={t("noCost")} />
        </div>

        <div style={s.sectionLabel}>
          <Icon.ListChecks size={13} />
          {t("perAgent")}
        </div>

        <div style={s.tableCard}>
          <div style={s.filterBar}>
            <div style={s.filterItem}>
              <SelectInput value={sortKey} onChange={(v) => setSortKey(v as SortKey)} options={sortOptions} mono={false} />
            </div>
          </div>

          <div style={s.headRow}>
            <div>{t("table.agent")}</div>
            <div>{t("table.accept")}</div>
            <div>{t("table.runs")}</div>
            <div>{t("table.findings")}</div>
            <div>{t("table.cost")}</div>
            <div>{t("table.trend")}</div>
          </div>

          {sortedAgents.map((row) => (
            <AgentRow key={row.agent_id} row={row} onOpen={openAgentStats} />
          ))}
        </div>
      </div>
    </AppShell>
  );
}
