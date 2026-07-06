"use client";

/* BatchHistoryTable — batch runs (timestamp, agent-snapshot identity, model,
   the three metrics, cost, status pill). Clicking a row expands an inline
   per-case drill-down (AC-33, via useEvalBatchDetail). Selecting exactly two
   rows renders BatchCompare inline underneath (AC-32). */

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, Checkbox } from "@devdigest/ui";
import type { EvalBatch } from "@devdigest/shared";
import { formatCost } from "@/lib/format";
import { useEvalBatchDetail, useEvalCompare } from "@/lib/hooks/eval";
import { BatchCompare } from "../BatchCompare/BatchCompare";
import { modelLabelFrom, snapshotLabel, pct } from "../../helpers";
import { s } from "../../styles";

interface BatchHistoryTableProps {
  agentId: string;
  batches: EvalBatch[];
}

export function BatchHistoryTable({ agentId, batches }: BatchHistoryTableProps) {
  const t = useTranslations("agents");
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<string[]>([]);

  const detail = useEvalBatchDetail(agentId, expandedId);

  // S2 — compare is only meaningful between two "full" batches (same case
  // set, run to completion); a calibration batch's subset of cases and a
  // full batch's complete set are disjoint, so a signed delta between them
  // is not comparable. Restrict selection to full-kind batches only.
  const toggleSelected = (id: string) => {
    const batch = batches.find((b) => b.id === id);
    if (!batch || batch.kind !== "full") return;
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 2) return [prev[1]!, id];
      return [...prev, id];
    });
  };

  const [batchIdA, batchIdB] = selected;
  const compare = useEvalCompare(agentId, batchIdA, batchIdB);

  if (batches.length === 0) {
    return <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("evals.history.empty")}</div>;
  }

  return (
    <div>
      <table style={s.table}>
        <thead>
          <tr>
            <th style={s.th}></th>
            <th style={s.th}>{t("evals.history.timestamp")}</th>
            <th style={s.th}>{t("evals.history.agentSnapshot")}</th>
            <th style={s.th}>{t("evals.history.model")}</th>
            <th style={s.th}>{t("evals.history.recall")}</th>
            <th style={s.th}>{t("evals.history.precision")}</th>
            <th style={s.th}>{t("evals.history.citationAccuracy")}</th>
            <th style={s.th}>{t("evals.history.cost")}</th>
            <th style={s.th}>{t("evals.history.status")}</th>
          </tr>
        </thead>
        <tbody>
          {batches.map((batch) => {
            const isCalibration = batch.kind === "calibration";
            // #6 — a full-kind batch with `status === null` is in-flight or
            // crash-orphaned, NOT genuinely clean; it must render as a
            // distinct neutral "Running/Incomplete" state instead of falling
            // through to the green Clean pill.
            const isUnsealed = !isCalibration && batch.status == null;
            const statusLabel = isCalibration
              ? t("evals.history.statusCalibration")
              : isUnsealed
                ? t("evals.history.statusRunning")
                : batch.status === "degraded"
                  ? t("evals.history.statusDegraded")
                  : t("evals.history.statusClean");
            const statusColor = isCalibration
              ? "var(--info)"
              : isUnsealed
                ? "var(--text-muted)"
                : batch.status === "degraded"
                  ? "var(--crit)"
                  : "var(--ok)";
            const isExpanded = expandedId === batch.id;
            // S2 — only full-kind batches are selectable for compare.
            const selectable = batch.kind === "full";
            return (
              <React.Fragment key={batch.id}>
                <tr style={s.batchRow} onClick={() => setExpandedId(isExpanded ? null : batch.id)}>
                  <td style={s.td} onClick={(e) => e.stopPropagation()}>
                    {selectable ? (
                      <Checkbox checked={selected.includes(batch.id)} onChange={() => toggleSelected(batch.id)} />
                    ) : (
                      <span title={t("evals.history.compareFullOnly")} style={{ display: "inline-block", width: 16 }} />
                    )}
                  </td>
                  <td style={s.td}>{new Date(batch.ran_at).toLocaleString()}</td>
                  <td style={s.td} title={snapshotLabel(batch.agent_snapshot)}>
                    {snapshotLabel(batch.agent_snapshot)}
                  </td>
                  <td style={s.td}>{modelLabelFrom(batch.agent_snapshot)}</td>
                  <td style={s.td}>{pct(batch.recall)}</td>
                  <td style={s.td}>{pct(batch.precision)}</td>
                  <td style={s.td}>{pct(batch.citation_accuracy)}</td>
                  <td style={s.td}>{formatCost(batch.cost_usd)}</td>
                  <td style={s.td}>
                    <Badge color={statusColor}>{statusLabel}</Badge>
                  </td>
                </tr>
                {isExpanded && (
                  <tr>
                    <td style={s.td} colSpan={9}>
                      <div style={s.drilldownWrap}>
                        {detail.isLoading && <span style={{ fontSize: 12 }}>…</span>}
                        {detail.data && (
                          <table style={s.table}>
                            <thead>
                              <tr>
                                <th style={s.th}>{t("evals.history.drilldown.case")}</th>
                                <th style={s.th}>{t("evals.history.drilldown.outcome")}</th>
                                <th style={s.th}>{t("evals.history.drilldown.expected")}</th>
                                <th style={s.th}>{t("evals.history.drilldown.matched")}</th>
                                <th style={s.th}>{t("evals.history.drilldown.findings")}</th>
                                <th style={s.th}>{t("evals.history.drilldown.cost")}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {detail.data.cases.map((c) => (
                                <tr key={c.case_id}>
                                  <td style={s.td}>{c.case_name}</td>
                                  <td style={s.td}>{t(`evals.status.${c.status}`)}</td>
                                  <td style={s.td}>{c.expected_count}</td>
                                  <td style={s.td}>{c.matched_count}</td>
                                  <td style={s.td}>{c.findings_count}</td>
                                  <td style={s.td}>{formatCost(c.cost_usd)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>

      {selected.length === 1 && <div style={{ ...s.note, marginTop: 10 }}>{t("evals.history.selectTwoHint")}</div>}
      {selected.length === 2 && compare.data && <BatchCompare result={compare.data} />}
    </div>
  );
}
