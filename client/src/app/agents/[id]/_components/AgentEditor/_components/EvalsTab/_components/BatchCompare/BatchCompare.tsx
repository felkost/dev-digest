"use client";

/* BatchCompare — side-by-side metric comparison for two selected batches
   (AC-32), rendered inline under BatchHistoryTable. */

import React from "react";
import { useTranslations } from "next-intl";
import type { EvalBatchCompareResult } from "@devdigest/shared";
import { pct, fmtDelta, deltaColor } from "../../helpers";
import { s } from "../../styles";

export function BatchCompare({ result }: { result: EvalBatchCompareResult }) {
  const t = useTranslations("agents");

  const rows: { label: string; a: number | null; b: number | null; delta: number }[] = [
    { label: t("evals.history.recall"), a: result.a.recall, b: result.b.recall, delta: result.deltas.recall },
    { label: t("evals.history.precision"), a: result.a.precision, b: result.b.precision, delta: result.deltas.precision },
    {
      label: t("evals.history.citationAccuracy"),
      a: result.a.citation_accuracy,
      b: result.b.citation_accuracy,
      delta: result.deltas.citation_accuracy,
    },
  ];

  return (
    <div style={{ marginTop: 14 }}>
      <div style={s.sectionLabel}>{t("evals.compare.title")}</div>
      <table style={s.table} data-testid="batch-compare-panel">
        <thead>
          <tr>
            <th style={s.th}>{t("evals.compare.metric")}</th>
            <th style={s.th}>{t("evals.compare.batchA")}</th>
            <th style={s.th}>{t("evals.compare.batchB")}</th>
            <th style={s.th}>{t("evals.compare.delta")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <td style={s.td}>{row.label}</td>
              <td style={s.td}>{pct(row.a)}</td>
              <td style={s.td}>{pct(row.b)}</td>
              <td style={{ ...s.td, color: deltaColor(row.delta), fontWeight: 600 }}>{fmtDelta(row.delta)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
