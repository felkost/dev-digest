/* TabsView — one tab per participating agent (AC-20-22). Tab body: summary,
   verdict-adjacent stats, trace link, then that agent's findings as full
   expandable FindingCards — sourced from the already-fetched usePrReviews
   cache mapped run_id -> ReviewRecord (zero new server code, AC-23-25) —
   plus "Learn"/"Reply to author" as visibly disabled stubs (AC-26).
   FindingCard itself is reused verbatim, unmodified. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Button, CircularScore, EmptyState, MonoLink, Tabs } from "@devdigest/ui";
import type { AgentColumn, ReviewRecord } from "@devdigest/shared";
import { FindingCard } from "@/app/repos/[repoId]/pulls/[number]/_components/FindingCard";
import { useFindingAction } from "@/lib/hooks/reviews";
import { formatCost } from "@/lib/format";
import { formatDurationMs, formatTokenCount } from "@/app/multi-agent-review/format";
import { personaStyle } from "@/app/multi-agent-review/persona";

export function TabsView({
  columns,
  reviewsByRunId,
  prId,
  onOpenTrace,
}: {
  columns: AgentColumn[];
  reviewsByRunId: Map<string, ReviewRecord>;
  prId: string;
  onOpenTrace: (runId: string) => void;
}) {
  const t = useTranslations("multi-agent-review.results");
  const action = useFindingAction();
  const [activeSel, setActiveSel] = React.useState<string>(columns[0]?.run_id ?? "");
  const active = columns.some((c) => c.run_id === activeSel) ? activeSel : (columns[0]?.run_id ?? "");
  const activeCol = columns.find((c) => c.run_id === active) ?? null;

  if (!activeCol) return null;

  const findings = reviewsByRunId.get(active)?.findings ?? [];
  const activePersona = personaStyle(activeCol.agent_name);
  const tabs = columns.map((c) => {
    const p = personaStyle(c.agent_name);
    return {
      key: c.run_id,
      label: c.score != null ? `${c.agent_name} · ${c.score}` : c.agent_name,
      icon: p.icon,
      color: p.color,
    };
  });

  return (
    <div>
      <Tabs tabs={tabs} value={active} onChange={setActiveSel} pad="0" />
      <div style={{ padding: "16px 0" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            marginBottom: 12,
            flexWrap: "wrap",
            border: "1px solid var(--border)",
            borderLeft: `3px solid ${activePersona.color}`,
            borderRadius: 10,
            background: "var(--bg-elevated)",
            padding: 14,
          }}
        >
          {activeCol.score != null && <CircularScore score={activeCol.score} size={40} />}
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: activePersona.color, marginBottom: 2 }}>
              {activeCol.agent_name}
            </div>
            <div style={{ fontSize: 13.5, color: "var(--text-secondary)" }}>{activeCol.summary ?? "—"}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <MonoLink onClick={() => onOpenTrace(activeCol.run_id)}>{t("viewTrace")}</MonoLink>
            <div className="tnum" style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
              {formatDurationMs(activeCol.duration_ms)} · {formatCost(activeCol.cost_usd)}
            </div>
          </div>
        </div>

        {/* AC-33: per-agent token usage — "unknown" (never 0) when a count
           is null. Kept close to the header card, out of its bordered box
           so the card stays a compact score+summary+trace unit. */}
        <div className="tnum" style={{ display: "flex", gap: 14, fontSize: 12, color: "var(--text-muted)", marginBottom: 16 }}>
          <span>
            {t("tokensIn")}: {activeCol.tokens_in == null ? t("tokensUnknown") : formatTokenCount(activeCol.tokens_in)}
          </span>
          <span>
            {t("tokensOut")}: {activeCol.tokens_out == null ? t("tokensUnknown") : formatTokenCount(activeCol.tokens_out)}
          </span>
        </div>

        {activeCol.status === "failed" && (
          <div role="alert" style={{ fontSize: 13, color: "var(--crit)", marginBottom: 12 }}>
            {/* AC-17: `error` (agent_runs.error) is the dedicated
               failure-reason carrier — `summary` stays null for failed runs. */}
            {activeCol.error ?? t("runFailed")}
          </div>
        )}

        {findings.length === 0 ? (
          <EmptyState icon="Sparkles" title={t("noFindingsYet")} />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {findings.map((f, i) => (
              <FindingCard
                key={f.id}
                f={f}
                defaultExpanded={i === 0}
                pending={action.isPending}
                agentId={activeCol.agent_id}
                onAction={(act) => action.mutate({ findingId: f.id, action: act, prId })}
                // AC-26: Learn / Reply to author — visibly disabled stubs,
                // rendered in FindingCard's own action row (alongside
                // Accept/Dismiss) via its footerExtra slot.
                footerExtra={
                  <>
                    <Button kind="ghost" size="sm" icon="Brain" disabled title={t("comingSoon")}>
                      {t("learn")}
                    </Button>
                    <Button kind="ghost" size="sm" icon="MessageSquare" disabled title={t("comingSoon")}>
                      {t("replyToAuthor")}
                    </Button>
                  </>
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
