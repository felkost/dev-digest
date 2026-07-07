"use client";

/* SkillEvalBatchHistory — batch runs (timestamp, host agent, model, the three
   skill-eval metrics, cost, status pill). Copies the agent-eval
   BatchHistoryTable's table layout; Batch Compare / trend chart are explicit
   Out-of-Scope items for the skill-eval pipeline (spec Non-goals), so this
   component has no drill-down/compare affordances. */

import React from "react";
import { useTranslations } from "next-intl";
import { Badge } from "@devdigest/ui";
import type { SkillEvalBatch, Agent } from "@devdigest/shared";
import { formatCost } from "@/lib/format";
import { s } from "../../styles";

interface SkillEvalBatchHistoryProps {
  batches: SkillEvalBatch[];
  agents: Agent[];
}

function pct(v: number | null): string {
  return v == null ? "—" : `${Math.round(v * 100)}%`;
}

export function SkillEvalBatchHistory({ batches, agents }: SkillEvalBatchHistoryProps) {
  const t = useTranslations("skills");
  const agentNameById = new Map(agents.map((a) => [a.id, a.name]));

  if (batches.length === 0) {
    return <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("evals.history.empty")}</div>;
  }

  return (
    <table style={s.table}>
      <thead>
        <tr>
          <th style={s.th}>{t("evals.history.timestamp")}</th>
          <th style={s.th}>{t("evals.history.hostAgent")}</th>
          <th style={s.th}>{t("evals.history.model")}</th>
          <th style={s.th}>{t("evals.history.judgeScore")}</th>
          <th style={s.th}>{t("evals.history.groundingPassRate")}</th>
          <th style={s.th}>{t("evals.history.casesPassing")}</th>
          <th style={s.th}>{t("evals.history.cost")}</th>
          <th style={s.th}>{t("evals.history.status")}</th>
        </tr>
      </thead>
      <tbody>
        {batches.map((batch) => {
          const isCalibration = batch.kind === "calibration";
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
          const casesPassing =
            batch.cases_passing != null ? `${batch.cases_passing}/${batch.cases_total}` : "—";

          return (
            <tr key={batch.id}>
              <td style={s.td}>{new Date(batch.ran_at).toLocaleString()}</td>
              <td style={s.td}>{agentNameById.get(batch.host_agent_id) ?? batch.host_agent_id}</td>
              <td style={s.td}>{batch.model}</td>
              <td style={s.td}>{pct(batch.judge_score)}</td>
              <td style={s.td}>{pct(batch.grounding_pass_rate)}</td>
              <td style={s.td}>{casesPassing}</td>
              <td style={s.td}>{formatCost(batch.cost_usd)}</td>
              <td style={s.td}>
                <Badge color={statusColor}>{statusLabel}</Badge>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
