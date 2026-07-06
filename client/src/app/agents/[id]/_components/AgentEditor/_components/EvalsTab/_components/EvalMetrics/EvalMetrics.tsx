"use client";

/* EvalMetrics — top-of-tab KPI infographic: recall/precision/citation-accuracy
   (latest full batch value + delta vs the previous full batch) plus a
   traces-passed tally for the latest batch. The "View full dashboard" link is
   intentionally inert for now (placed, not wired). */

import React from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@devdigest/ui";
import type { EvalKpiDeltaResponse } from "@devdigest/shared";
import { pct } from "../../helpers";
import { deltaColor } from "../../helpers";
import { s } from "../../styles";

interface EvalMetricsProps {
  recall: number | null;
  precision: number | null;
  citation: number | null;
  /** Deltas vs the previous full batch (0..1), or null when no baseline yet. */
  delta: EvalKpiDeltaResponse | undefined;
  tracesPassed: number | null;
  tracesTotal: number | null;
}

export function EvalMetrics({ recall, precision, citation, delta, tracesPassed, tracesTotal }: EvalMetricsProps) {
  const t = useTranslations("agents");

  const cards = [
    { key: "recall", label: t("evals.metrics.recall"), value: pct(recall), color: "var(--accent)", delta: delta?.recall ?? null },
    { key: "precision", label: t("evals.metrics.precision"), value: pct(precision), color: "var(--ok)", delta: delta?.precision ?? null },
    { key: "citation", label: t("evals.metrics.citationAccuracy"), value: pct(citation), color: "var(--warn)", delta: delta?.citation_accuracy ?? null },
  ];

  return (
    <div>
      <div style={s.metricsHeader}>
        <span style={s.metricsTitle}>
          <Icon.FlaskConical size={13} />
          {t("evals.metrics.title")}
        </span>
        {/* Placed but inert for now — full dashboard is a follow-up. */}
        <span style={s.dashboardLinkDisabled} aria-disabled="true" title={t("evals.metrics.dashboardSoon")}>
          {t("evals.metrics.viewDashboard")} →
        </span>
      </div>
      <div style={s.metricsGrid}>
        {cards.map((c) => (
          <div key={c.key} style={s.metricCard}>
            <div style={s.metricLabel}>{c.label}</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span style={{ ...s.metricValue, color: c.color }}>{c.value}</span>
              {c.delta != null && c.delta !== 0 && (
                <span style={{ fontSize: 11, fontWeight: 600, color: deltaColor(c.delta), display: "inline-flex", alignItems: "center", gap: 2 }}>
                  {c.delta > 0 ? "▲" : "▼"} {Math.abs(Math.round(c.delta * 100))}
                  {t("evals.metrics.pt")}
                </span>
              )}
            </div>
          </div>
        ))}
        <div style={s.metricCard}>
          <div style={s.metricLabel}>{t("evals.metrics.tracesPassed")}</div>
          <span style={{ ...s.metricValue, color: "var(--text-secondary)" }}>
            {tracesTotal != null ? `${tracesPassed}/${tracesTotal}` : "—"}
          </span>
        </div>
      </div>
    </div>
  );
}
