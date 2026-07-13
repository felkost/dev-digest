/* FindingsSummary — a consolidated, INTERACTIVE "Findings" section at the
   bottom of the results page, shown for ANY number of agents (1, 2, 3, …).
   It groups every completed agent's findings under a small agent header and
   renders each as the same full, expandable FindingCard used by the Tabs view
   (click to expand rationale/suggestion; Accept / Dismiss wired to the same
   finding-action mutation). Always rendered (like DisagreementSection), with an
   explicit empty state when no agent produced a finding. Full FindingRecord
   detail comes from `findingsByRun` (the composed run's own findings_by_run) —
   the compact AgentColumn.findings lacks rationale/suggestion. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Icon, SectionLabel } from "@devdigest/ui";
import type { AgentColumn, FindingRecord } from "@devdigest/shared";
import { FindingCard } from "@/app/repos/[repoId]/pulls/[number]/_components/FindingCard";
import { useFindingAction } from "@/lib/hooks/reviews";
import { personaStyle } from "@/app/multi-agent-review/persona";

export function FindingsSummary({
  columns,
  findingsByRun,
  prId,
}: {
  columns: AgentColumn[];
  findingsByRun: Map<string, FindingRecord[]>;
  prId: string;
}) {
  const t = useTranslations("multi-agent-review.results");
  const action = useFindingAction();

  // One group per completed agent that actually flagged something, in column
  // order. Full findings come from findingsByRun (keyed by run_id).
  const groups = columns
    .filter((c) => c.status === "done")
    .map((c) => ({ col: c, findings: findingsByRun.get(c.run_id) ?? [] }))
    .filter((g) => g.findings.length > 0);

  const totalFindings = groups.reduce((n, g) => n + g.findings.length, 0);

  return (
    <div>
      <SectionLabel
        icon="AlertOctagon"
        right={
          totalFindings > 0 ? (
            <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
              {t("findingsSummaryCount", { count: totalFindings, agents: groups.length })}
            </span>
          ) : undefined
        }
      >
        {t("findingsSummaryTitle")}
      </SectionLabel>

      {totalFindings === 0 ? (
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{t("findingsSummaryEmpty")}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {groups.map(({ col, findings }) => {
            const persona = personaStyle(col.agent_name);
            const PersonaIcon = Icon[persona.icon];
            return (
              <div key={col.run_id}>
                {/* Agent attribution header — which reviewer these findings are from. */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <PersonaIcon size={14} style={{ color: persona.color, flexShrink: 0 }} />
                  <span style={{ fontWeight: 600, fontSize: 13, color: persona.color }}>{col.agent_name}</span>
                  <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    {t("findingsCount", { count: findings.length })}
                  </span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {findings.map((f) => (
                    <FindingCard
                      key={f.id}
                      f={f}
                      // Collapsed by default — the consolidated list can be long;
                      // click a card to expand its rationale/suggestion.
                      defaultExpanded={false}
                      pending={action.isPending}
                      agentId={col.agent_id}
                      onAction={(act) => action.mutate({ findingId: f.id, action: act, prId })}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
