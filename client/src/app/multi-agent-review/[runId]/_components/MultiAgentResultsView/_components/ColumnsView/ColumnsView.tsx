/* ColumnsView — the default results view (AC-15): one column per
   AgentColumn — live status (AC-16), failure isolation with a reason
   (AC-17), compact finding rows (AC-18), score via the shared CircularScore
   (AC-19), and a "View trace" link (AC-34). */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { CircularScore, Icon, MonoLink, SEV, type IconName } from "@devdigest/ui";
import type { AgentColumn } from "@devdigest/shared";
import { formatCost } from "@/lib/format";
import { formatDurationMs, formatTokenCount } from "@/app/multi-agent-review/format";
import { personaStyle } from "@/app/multi-agent-review/persona";

const STATUS_ICON: Record<AgentColumn["status"], IconName> = {
  running: "RefreshCw",
  done: "CheckCircle",
  failed: "XCircle",
};
const STATUS_COLOR: Record<AgentColumn["status"], string> = {
  running: "var(--accent)",
  done: "var(--ok)",
  failed: "var(--crit)",
};

export function ColumnsView({
  columns,
  onOpenTrace,
}: {
  columns: AgentColumn[];
  onOpenTrace: (runId: string) => void;
}) {
  const t = useTranslations("multi-agent-review.results");

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${Math.max(columns.length, 1)}, minmax(240px, 1fr))`,
        gap: 14,
        overflowX: "auto",
      }}
    >
      {columns.map((col) => {
        const StatusIcon = Icon[STATUS_ICON[col.status]];
        const persona = personaStyle(col.agent_name);
        const PersonaIcon = Icon[persona.icon];
        return (
          <div
            key={col.run_id}
            data-testid={`column-${col.run_id}`}
            style={{
              border: "1px solid var(--border)",
              borderTop: `3px solid ${persona.color}`,
              borderRadius: 10,
              background: "var(--bg-elevated)",
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
              minWidth: 240,
            }}
          >
            <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10, flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    flexShrink: 0,
                    background: persona.bg,
                    display: "grid",
                    placeItems: "center",
                  }}
                >
                  <PersonaIcon size={16} style={{ color: persona.color }} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: 13.5,
                      overflowWrap: "break-word",
                    }}
                  >
                    {col.agent_name}
                  </div>
                  <div className="tnum" style={{ display: "flex", gap: 6, fontSize: 11.5, color: "var(--text-muted)" }}>
                    <span>{formatDurationMs(col.duration_ms)}</span>
                    <span>·</span>
                    <span>{formatCost(col.cost_usd)}</span>
                  </div>
                </div>
                {col.score != null && <CircularScore score={col.score} size={34} stroke={3} />}
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <StatusIcon
                  size={13}
                  style={{
                    color: STATUS_COLOR[col.status],
                    ...(col.status === "running" ? { animation: "ddspin 1s linear infinite" } : {}),
                  }}
                />
                <span style={{ fontSize: 12.5, color: STATUS_COLOR[col.status], fontWeight: 600 }}>
                  {t(col.status === "running" ? "statusRunning" : col.status === "done" ? "statusDone" : "statusFailed")}
                </span>
              </div>

              {/* AC-33: per-agent token usage, always visible next to
                 cost/duration — "unknown" (never 0) when a count is null. */}
              <div className="tnum" style={{ display: "flex", gap: 14, fontSize: 11.5, color: "var(--text-muted)" }}>
                <span>
                  {t("tokensIn")}: {col.tokens_in == null ? t("tokensUnknown") : formatTokenCount(col.tokens_in)}
                </span>
                <span>
                  {t("tokensOut")}: {col.tokens_out == null ? t("tokensUnknown") : formatTokenCount(col.tokens_out)}
                </span>
              </div>

              {col.status === "failed" ? (
                // AC-17: the failure reason — `error` (agent_runs.error) is the
                // dedicated failure-reason carrier; one agent failing must never
                // block or hide the others' columns, which is why this branch
                // renders in-place, not as a takeover.
                <div
                  role="alert"
                  style={{
                    fontSize: 12.5,
                    color: "var(--crit)",
                    background: "var(--crit-bg)",
                    borderRadius: 6,
                    padding: "6px 8px",
                  }}
                >
                  {col.error ?? t("runFailed")}
                </div>
              ) : col.findings.length === 0 ? (
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("noFindingsYet")}</span>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {col.findings.map((f) => {
                    const sev = SEV[f.severity];
                    const SevIcon = Icon[sev.icon];
                    return (
                      <div
                        key={f.id}
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: 8,
                          fontSize: 12.5,
                          background: "var(--bg-surface)",
                          borderLeft: `3px solid ${sev.c}`,
                          borderRadius: 6,
                          padding: "8px 10px",
                        }}
                      >
                        <SevIcon size={13} style={{ color: sev.c, marginTop: 1, flexShrink: 0 }} />
                        <div style={{ minWidth: 0 }}>
                          <div
                            style={{
                              fontWeight: 500,
                              color: "var(--text-primary)",
                              overflowWrap: "break-word",
                            }}
                          >
                            {f.title}
                          </div>
                          <span className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>
                            {f.file}:{f.start_line}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                borderTop: "1px solid var(--border)",
                padding: "10px 14px",
              }}
            >
              <MonoLink onClick={() => onOpenTrace(col.run_id)}>{t("viewTrace")}</MonoLink>
              {col.status !== "failed" && (
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  {t("findingsCount", { count: col.findings.length })}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
