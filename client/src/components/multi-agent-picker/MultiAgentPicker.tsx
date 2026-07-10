/* MultiAgentPicker — replaces RunReviewDropdown. Lets the workspace member
   pick any subset of enabled agents (including exactly one) and starts a
   grouped multi-agent run, navigating to its results page on success
   (AC-1–5, AC-3). Shared between the PR list row (PRRow) and the PR detail
   header (PrDetailHeader).

   Hand-rolled portaled panel (not the flat-items `Dropdown` primitive — it
   cannot render checkboxes + a footer button). Reuses `Dropdown`'s
   `createPortal(..., document.body)` + `getBoundingClientRect()` positioning
   and viewport-edge flip technique verbatim (see `vendor/ui/kit/Dropdown.tsx`
   and `client/insights.md`'s 2026-06-29 entry) rather than re-deriving it.

   The combined-estimate math (MAX duration / SUM cost, AC-8/AC-9) is
   deliberately duplicated rather than shared with the parallel Step 8
   Configure-run flow (`app/multi-agent-review/_components/ConfigureRunView`)
   — see that file's own header comment for the accepted-duplication note. */
"use client";

import React from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, Checkbox, EmptyState, Icon } from "@devdigest/ui";
import type { Agent, AgentEstimate } from "@devdigest/shared";
import { useAgents } from "@/lib/hooks/agents";
import { useAgentEstimates, useStartMultiAgentRun } from "@/lib/hooks/multi-agent-review";

const PANEL_WIDTH = 320;

interface PanelPos {
  triggerTop: number;
  triggerBottom: number;
  left: number;
}

/** Compact duration display ("420ms", "8.2s", "1.4m") — mirrors the
   RunTraceDrawer / Configure-run flow convention (kept local per the
   accepted-duplication note above, not imported cross-route). */
function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${(seconds / 60).toFixed(1)}m`;
}

/** Returns "—" when cost is unknown — mirrors `@/lib/format`'s `formatCost`
   (kept local per the accepted-duplication note above). A known duration with
   an unknown cost (or vice versa) is NOT "no history"; each field renders its
   own unknown marker independently (see `estimateLabel`). */
function formatCostUsd(usd: number | null): string {
  if (usd == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(usd);
}

interface CombinedEstimate {
  /** MAX of the selected agents' known average durations (AC-8). Null when none is known. */
  maxDurationMs: number | null;
  /** SUM of the selected agents' known average costs (AC-8). Null when none is known. */
  sumCostUsd: number | null;
  /** True when at least one selected agent's duration or cost estimate is unavailable (AC-9). */
  missing: boolean;
}

/** Plain arithmetic over already-fetched data — computed inline during
   render (no useMemo, not an expensive computation). */
function combineEstimates(selectedIds: string[], estimates: AgentEstimate[]): CombinedEstimate {
  const byId = new Map(estimates.map((e) => [e.agent_id, e]));
  let maxDurationMs: number | null = null;
  let sumCostUsd = 0;
  let anyCostKnown = false;
  let missing = false;

  for (const id of selectedIds) {
    const est = byId.get(id);
    if (est?.avg_duration_ms != null) {
      maxDurationMs = maxDurationMs == null ? est.avg_duration_ms : Math.max(maxDurationMs, est.avg_duration_ms);
    } else {
      missing = true;
    }
    if (est?.avg_cost_usd != null) {
      sumCostUsd += est.avg_cost_usd;
      anyCostKnown = true;
    } else {
      missing = true;
    }
  }

  return { maxDurationMs, sumCostUsd: anyCostKnown ? sumCostUsd : null, missing };
}

/** One checkbox row: agent icon/name/description (AC-1) + its pre-run
   estimate or an explicit "no history" marker (AC-7). Small colocated
   presentational helper — pure props in, no data fetching. */
function AgentPickerRow({
  agent,
  checked,
  onToggle,
  estimateLabel,
}: {
  agent: Agent;
  checked: boolean;
  onToggle: () => void;
  estimateLabel: string;
}) {
  return (
    <Checkbox
      checked={checked}
      onChange={onToggle}
      label={
        <span style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
          <Icon.Cpu size={14} style={{ color: "var(--text-muted)", marginTop: 2, flexShrink: 0 }} />
          <span style={{ minWidth: 0 }}>
            <span style={{ display: "block", fontWeight: 600, fontSize: 13, color: "var(--text-primary)" }}>
              {agent.name}
            </span>
            <span style={{ display: "block", fontSize: 12, color: "var(--text-secondary)" }}>
              {agent.description}
            </span>
            <span className="tnum" style={{ display: "block", fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
              {estimateLabel}
            </span>
          </span>
        </span>
      }
    />
  );
}

export function MultiAgentPicker({
  prId,
  size = "sm",
  kind = "primary",
  warnMerged = false,
  onRunStart,
  onRunsStarted,
}: {
  prId: string;
  size?: "sm" | "md" | "lg";
  kind?: "primary" | "secondary";
  /** PR is already merged/closed — dim the trigger and warn, but still allow. */
  warnMerged?: boolean;
  /** Fired once the grouped run has actually started (after the POST
     succeeds) — same timing as `onRunsStarted`, kept as a separate callback
     for call sites that only need a lightweight "a run started" signal
     (e.g. switching tabs) without the run id list. */
  onRunStart?: () => void;
  /** Fired once the grouped run has actually started (after the POST succeeds). */
  onRunsStarted?: (runIds: string[]) => void;
}) {
  const t = useTranslations("prReview");
  const router = useRouter();
  const { data: agents } = useAgents();
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<PanelPos | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const triggerRef = React.useRef<HTMLDivElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  // Mount-guard: `handleConfirm` awaits a mutation and then calls
  // setState/router.push — if the component unmounted while the request was
  // in flight (e.g. the user navigated away), those calls must be skipped.
  const isMountedRef = React.useRef(true);
  React.useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  // Lazy: only fetch per-PR estimates while the panel is actually open —
  // mirrors the FindingsPopup lazy-fetch pattern (PRRow renders one picker
  // per row; fetching unconditionally would fire N parallel requests).
  const { data: estimates, isLoading: estimatesLoading } = useAgentEstimates(open ? prId : null);
  const start = useStartMultiAgentRun();

  const enabledAgents = (agents ?? []).filter((a) => a.enabled);
  const estimateByAgent = new Map((estimates ?? []).map((e) => [e.agent_id, e]));
  const selectedIds = Array.from(selected);
  const combined = combineEstimates(selectedIds, estimates ?? []);

  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      // Don't dismiss the panel while a run is being started — the member
      // would lose visibility into the in-flight request (and any error
      // that surfaces from it) by accidentally clicking outside.
      if (start.isPending) return;
      if (
        triggerRef.current && !triggerRef.current.contains(e.target as Node) &&
        panelRef.current && !panelRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [start.isPending]);

  const toggleOpen = () => {
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPos({ triggerTop: rect.top, triggerBottom: rect.bottom, left: rect.right - PANEL_WIDTH });
    }
    setOpen((o) => !o);
  };

  const toggleAgent = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(enabledAgents.map((a) => a.id)));
  const clearAll = () => setSelected(new Set());

  // "No history" (AC-7) means zero sample runs — matches AgentRow.tsx's rule
  // exactly (`!estimate || sample_size === 0 || avg_duration_ms == null`).
  // A known duration with an unknown cost is NOT "no history"; formatCostUsd
  // renders "—" for that field on its own instead of falling back to the
  // blanket message.
  const estimateLabel = (agentId: string): string => {
    if (estimatesLoading) return t("runReview.picker.loading");
    const est = estimateByAgent.get(agentId);
    const noHistory = !est || est.sample_size === 0 || est.avg_duration_ms == null;
    return noHistory
      ? t("runReview.picker.noHistory")
      : t("runReview.picker.estimateEach", {
          duration: formatDurationMs(est!.avg_duration_ms!),
          cost: formatCostUsd(est!.avg_cost_usd),
        });
  };

  const handleConfirm = async () => {
    if (selected.size === 0) return;
    try {
      const res = await start.mutateAsync({ prId, agentIds: selectedIds });
      // Guard every post-await side effect — the component may have
      // unmounted (e.g. the member navigated away) while the request was
      // still in flight.
      if (!isMountedRef.current) return;
      onRunStart?.();
      onRunsStarted?.(res.runs.map((r) => r.run_id));
      setOpen(false);
      router.push(`/multi-agent-review/${res.multi_agent_run_id}`);
    } catch {
      // `start.isError` renders an inline error row in the panel (see
      // PickerPanel) so the member sees the failure and can retry; the
      // panel stays open on failure.
    }
  };

  const panel = open && pos ? createPortal(
    <PickerPanel
      pos={pos}
      panelRef={panelRef}
      state={{
        enabledAgents,
        selected,
        combined,
        isStarting: start.isPending,
        isError: start.isError,
        warnMerged,
      }}
      estimateLabel={estimateLabel}
      actions={{
        onToggleAgent: toggleAgent,
        onSelectAll: selectAll,
        onClearAll: clearAll,
        onConfirm: handleConfirm,
        onGoToAgents: () => router.push("/agents"),
      }}
      t={t}
    />,
    document.body,
  ) : null;

  return (
    <div ref={triggerRef} style={{ position: "relative", display: "inline-block" }}>
      <div onClick={toggleOpen}>
        <span
          title={warnMerged ? t("runReview.mergedTooltip") : undefined}
          style={warnMerged ? { opacity: 0.6 } : undefined}
        >
          <Button
            kind={kind}
            size={size}
            iconRight="ChevronDown"
            icon="Sparkles"
            loading={start.isPending}
          >
            {start.isPending ? t("runReview.running") : t("runReview.runReview")}
          </Button>
        </span>
      </div>
      {panel}
    </div>
  );
}

interface PickerPanelState {
  enabledAgents: Agent[];
  selected: Set<string>;
  combined: CombinedEstimate;
  isStarting: boolean;
  /** True once `start.mutateAsync` has rejected — renders an inline retry
     hint near the confirm button. */
  isError: boolean;
  /** PR is already merged/closed — render a persistent in-panel warning row
     (mirrors the deleted RunReviewDropdown's dropdown-item warning). */
  warnMerged: boolean;
}

interface PickerPanelActions {
  onToggleAgent: (id: string) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
  onConfirm: () => void;
  onGoToAgents: () => void;
}

/** The portaled panel itself: viewport-edge flip positioning (reused from
   `Dropdown.tsx`) + the checkbox list / empty state / combined estimate /
   confirm footer. Split out purely to keep `MultiAgentPicker` under the
   ~200-line component guideline — still colocated in this file. `state`/
   `actions` are grouped (rather than ~10 flat props) to stay within the
   5-7-prop guideline. */
function PickerPanel({
  pos,
  panelRef,
  state,
  estimateLabel,
  actions,
  t,
}: {
  pos: PanelPos;
  panelRef: React.RefObject<HTMLDivElement | null>;
  state: PickerPanelState;
  estimateLabel: (agentId: string) => string;
  actions: PickerPanelActions;
  t: ReturnType<typeof useTranslations>;
}) {
  const { enabledAgents, selected, combined, isStarting, isError, warnMerged } = state;
  const { onToggleAgent, onSelectAll, onClearAll, onConfirm, onGoToAgents } = actions;
  const spaceBelow = window.innerHeight - pos.triggerBottom - 8;
  const spaceAbove = pos.triggerTop - 8;
  const openDown = spaceBelow >= spaceAbove || spaceBelow >= 160;
  const maxH = Math.max(160, openDown ? spaceBelow : spaceAbove);
  const placement = openDown ? { top: pos.triggerBottom + 6 } : { bottom: window.innerHeight - pos.triggerTop + 6 };

  return (
    <div
      ref={panelRef}
      data-testid="multi-agent-picker-panel"
      style={{
        position: "fixed",
        ...placement,
        left: pos.left,
        width: PANEL_WIDTH,
        maxHeight: maxH,
        overflowY: "auto",
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-strong)",
        borderRadius: 9,
        boxShadow: "var(--shadow-modal)",
        padding: 12,
        zIndex: 1100,
        animation: "ddpop .12s ease",
      }}
    >
      {warnMerged && (
        <div
          data-testid="multi-agent-picker-merged-warning"
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            marginBottom: 10,
            padding: "8px 10px",
            borderRadius: 6,
            background: "var(--warn-bg)",
            color: "var(--text-muted)",
            fontSize: 12,
          }}
        >
          <Icon.AlertTriangle size={13} style={{ color: "var(--warn)", flexShrink: 0, marginTop: 1 }} />
          <span>{t("runReview.mergedWarning")}</span>
        </div>
      )}
      {enabledAgents.length === 0 ? (
        <EmptyState
          icon="Cpu"
          title={t("runReview.picker.emptyTitle")}
          body={t("runReview.picker.emptyBody")}
          cta={t("runReview.picker.emptyCta")}
          onCta={onGoToAgents}
        />
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <span
              style={{
                fontSize: 12,
                fontWeight: 700,
                letterSpacing: "0.05em",
                color: "var(--text-muted)",
                textTransform: "uppercase",
                flex: 1,
              }}
            >
              {t("runReview.picker.title")}
            </span>
            <Button kind="ghost" size="sm" onClick={onSelectAll}>
              {t("runReview.picker.selectAll")}
            </Button>
            <Button kind="ghost" size="sm" onClick={onClearAll}>
              {t("runReview.picker.clear")}
            </Button>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {enabledAgents.map((a) => (
              <AgentPickerRow
                key={a.id}
                agent={a}
                checked={selected.has(a.id)}
                onToggle={() => onToggleAgent(a.id)}
                estimateLabel={estimateLabel(a.id)}
              />
            ))}
          </div>

          {selected.size > 0 && (
            <div className="tnum" style={{ marginTop: 12, fontSize: 12, color: "var(--text-secondary)" }}>
              {t(combined.missing ? "runReview.picker.combinedEstimateIncomplete" : "runReview.picker.combinedEstimate", {
                duration: combined.maxDurationMs != null ? formatDurationMs(combined.maxDurationMs) : "—",
                cost: combined.sumCostUsd != null ? formatCostUsd(combined.sumCostUsd) : "—",
              })}
            </div>
          )}

          {isError && (
            <div
              data-testid="multi-agent-picker-error"
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
                marginTop: 12,
                padding: "8px 10px",
                borderRadius: 6,
                background: "var(--crit-bg)",
                color: "var(--crit)",
                fontSize: 12,
              }}
            >
              <Icon.AlertOctagon size={13} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>{t("runReview.startFailed")}</span>
            </div>
          )}

          <div style={{ marginTop: 12 }}>
            <Button
              kind="primary"
              size="sm"
              full
              icon="Sparkles"
              loading={isStarting}
              disabled={selected.size === 0 || isStarting}
              onClick={onConfirm}
            >
              {isStarting ? t("runReview.running") : t("runReview.runReview")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
