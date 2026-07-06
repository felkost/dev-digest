"use client";

/* TrendChart — one point per full batch, chronological (calibration batches
   already excluded by the trend endpoint, AC-28). Tooltip shows
   agent-snapshot + cost (AC-29); degraded points are visually distinct via a
   separate marker row rendered on top of the line chart (AC-30).

   Reuses the existing `LineChart` (Recharts-backed) vendored UI primitive —
   no new charting dependency added. */

import React from "react";
import { useTranslations } from "next-intl";
import { LineChart, Icon } from "@devdigest/ui";
import type { EvalTrendPointV2 } from "@devdigest/shared";
import { formatCost } from "@/lib/format";
import { snapshotLabel } from "../../helpers";
import { s } from "../../styles";

export function TrendChart({ points }: { points: EvalTrendPointV2[] }) {
  const t = useTranslations("agents");
  const [hoverIdx, setHoverIdx] = React.useState<number | null>(null);

  if (points.length === 0) {
    return <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("evals.trend.empty")}</div>;
  }

  const series = [
    { name: t("evals.history.recall"), color: "var(--accent)", data: points.map((p) => p.recall) },
    { name: t("evals.history.precision"), color: "var(--ok)", data: points.map((p) => p.precision) },
    { name: t("evals.history.citationAccuracy"), color: "var(--warn)", data: points.map((p) => p.citation_accuracy) },
  ];

  const degradedPoints = points
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.is_degraded);

  return (
    <div>
      <LineChart series={series} yMin={0} yMax={1} />
      {degradedPoints.length > 0 && (
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6, fontSize: 11, color: "var(--crit)" }}>
          <Icon.AlertTriangle size={12} />
          {t("evals.trend.degradedLegend")}
        </div>
      )}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          marginTop: 10,
        }}
      >
        {points.map((p, i) => (
          <button
            key={p.batch_id}
            type="button"
            onMouseEnter={() => setHoverIdx(i)}
            onMouseLeave={() => setHoverIdx(null)}
            data-testid={`trend-point-${p.batch_id}`}
            data-degraded={p.is_degraded ? "true" : "false"}
            style={{
              width: 10,
              height: 10,
              borderRadius: p.is_degraded ? 2 : 99,
              background: p.is_degraded ? "var(--crit)" : "var(--accent)",
              border: "none",
              cursor: "pointer",
              padding: 0,
            }}
            aria-label={new Date(p.ran_at).toLocaleString()}
          />
        ))}
      </div>
      {hoverIdx != null && points[hoverIdx] && (
        <div style={{ ...s.note, marginTop: 8 }} role="tooltip">
          {/* #11 — snapshotLabel includes the fingerprint prefix (e.g.
              "gpt-4.1 @ 1a2b3c4d5e6f"), not just the model, so config changes
              between batches with the same model are visible in the tooltip. */}
          <div>{t("evals.trend.tooltipSnapshot")}: {snapshotLabel(points[hoverIdx].agent_snapshot)}</div>
          <div>{t("evals.trend.tooltipCost")}: {formatCost(points[hoverIdx].cost_usd)}</div>
        </div>
      )}
    </div>
  );
}
