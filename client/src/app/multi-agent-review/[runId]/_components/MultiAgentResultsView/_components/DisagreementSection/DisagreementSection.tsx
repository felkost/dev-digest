/* DisagreementSection — "Where agents disagree" (AC-27-32). Omitted entirely
   below the 2-done threshold (AC-32). "Show only conflicts" (default on,
   AC-31) is a pure client-side filter over the already-fetched `conflicts`
   array — no re-fetch on toggle. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Icon, SectionLabel, SEV, Toggle } from "@devdigest/ui";
import type { Conflict } from "@devdigest/shared";
import { isDisagreement } from "./helpers";

export function DisagreementSection({ conflicts, doneCount }: { conflicts: Conflict[]; doneCount: number }) {
  const t = useTranslations("multi-agent-review.results");
  const [onlyConflicts, setOnlyConflicts] = React.useState(true);

  // The section header is ALWAYS rendered so the "Where agents disagree" area
  // is a stable part of the results interface. With fewer than two completed
  // agents there is nothing to compare, so we show an explanatory message
  // instead of the (meaningless) conflicts grid + filter toggle.
  const belowThreshold = doneCount < 2;
  const shown = onlyConflicts ? conflicts.filter(isDisagreement) : conflicts;

  return (
    <div>
      <SectionLabel
        icon="Activity"
        right={
          belowThreshold ? undefined : (
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--text-secondary)" }}>
              {t("showOnlyConflicts")}
              <Toggle on={onlyConflicts} onChange={setOnlyConflicts} size={14} />
            </label>
          )
        }
      >
        {t("disagreementTitle")}
      </SectionLabel>

      {belowThreshold ? (
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{t("needsTwoAgents")}</div>
      ) : shown.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{t("noConflictsFiltered")}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {shown.map((c) => (
            <div
              key={`${c.file}:${c.line}`}
              style={{
                border: "1px solid var(--border)",
                borderRadius: 8,
                overflow: "hidden",
                background: "var(--bg-elevated)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 8,
                  padding: "10px 14px",
                  borderBottom: "1px solid var(--border)",
                  flexWrap: "wrap",
                }}
              >
                <Icon.Code size={12} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
                <span className="mono" style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  {c.file}:{c.line}
                </span>
                <span style={{ fontWeight: 600, fontSize: 13.5 }}>{c.title}</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: `repeat(${c.takes.length}, 1fr)` }}>
                {c.takes.map((take, i) => (
                  <div
                    key={take.agent_id}
                    style={{
                      minWidth: 0,
                      padding: 14,
                      borderLeft: i > 0 ? "1px solid var(--border)" : "none",
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                    }}
                  >
                    <span style={{ fontWeight: 600, fontSize: 13 }}>{take.persona}</span>
                    {take.verdict === "ignored" ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ width: 6, height: 6, borderRadius: 99, background: "var(--text-muted)", flexShrink: 0 }} />
                        <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>{t("didNotFlag")}</span>
                      </div>
                    ) : (
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ width: 6, height: 6, borderRadius: 99, background: SEV[take.verdict].c, flexShrink: 0 }} />
                        <span
                          style={{
                            fontSize: 12,
                            fontWeight: 700,
                            color: SEV[take.verdict].c,
                            textTransform: "uppercase",
                            letterSpacing: "0.04em",
                          }}
                        >
                          {SEV[take.verdict].label}
                        </span>
                      </div>
                    )}
                    {take.note && (
                      <span
                        title={take.note}
                        style={{
                          fontSize: 12.5,
                          color: "var(--text-secondary)",
                          display: "-webkit-box",
                          WebkitLineClamp: 1,
                          WebkitBoxOrient: "vertical",
                          overflow: "hidden",
                        }}
                      >
                        {take.note}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
