/* ReviewAllButton — the repo-wide "Review all" action, reworked from a plain
   button (which fired immediately) into an agent picker that mirrors the
   per-PR MultiAgentPicker UX. Opens a portaled panel of enabled agents;
   confirming fans the CHOSEN agents out over every open PR via
   POST /repos/:id/review-all (which now honors an `agent_ids` body).

   Deliberately does NOT show per-PR duration/cost estimates: "review all" is
   repo-wide, so there is no single PR to estimate against. Reuses Dropdown's
   portal + viewport-edge-flip positioning technique verbatim (see
   MultiAgentPicker and vendor/ui/kit/Dropdown.tsx). */
"use client";

import React from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, Checkbox, EmptyState, Icon } from "@devdigest/ui";
import type { Agent } from "@devdigest/shared";
import { useAgents } from "@/lib/hooks/agents";
import { useReviewAll } from "@/lib/hooks/reviews";
import { notify } from "@/lib/toast";

const PANEL_WIDTH = 320;

interface PanelPos {
  triggerTop: number;
  triggerBottom: number;
  left: number;
}

export function ReviewAllButton({ repoId }: { repoId: string }) {
  const t = useTranslations("prReview");
  const router = useRouter();
  const { data: agents } = useAgents();
  const reviewAll = useReviewAll(repoId);

  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<PanelPos | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const triggerRef = React.useRef<HTMLDivElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);

  const enabledAgents = (agents ?? []).filter((a) => a.enabled);
  const selectedIds = Array.from(selected);

  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      // Keep the panel open while a fan-out is starting so the member keeps
      // visibility into the in-flight request (mirrors MultiAgentPicker).
      if (reviewAll.isPending) return;
      if (
        triggerRef.current && !triggerRef.current.contains(e.target as Node) &&
        panelRef.current && !panelRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [reviewAll.isPending]);

  const toggleOpen = () => {
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPos({ triggerTop: rect.top, triggerBottom: rect.bottom, left: rect.right - PANEL_WIDTH });
    }
    setOpen((o) => !o);
  };

  const toggleAgent = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selectAll = () => setSelected(new Set(enabledAgents.map((a) => a.id)));
  const clearAll = () => setSelected(new Set());

  const handleConfirm = () => {
    if (selectedIds.length === 0) return;
    reviewAll.mutate(
      { agentIds: selectedIds },
      {
        onSuccess: (res) => {
          setOpen(false);
          if (res.triggered > 0) notify.success(t("list.reviewAllStarted", { count: res.triggered }));
          else notify.info(t("list.reviewAllNoneOpen"));
        },
        onError: () => notify.error(t("runReview.startFailed")),
      },
    );
  };

  const panel =
    open && pos
      ? createPortal(
          <ReviewAllPanel
            pos={pos}
            panelRef={panelRef}
            t={t}
            enabledAgents={enabledAgents}
            selected={selected}
            isPending={reviewAll.isPending}
            onToggleAgent={toggleAgent}
            onSelectAll={selectAll}
            onClearAll={clearAll}
            onConfirm={handleConfirm}
            onGoToAgents={() => router.push("/agents")}
          />,
          document.body,
        )
      : null;

  return (
    <div ref={triggerRef} style={{ position: "relative", display: "inline-block" }}>
      <div onClick={toggleOpen}>
        <Button
          kind="primary"
          size="sm"
          icon="Sparkles"
          iconRight="ChevronDown"
          loading={reviewAll.isPending}
        >
          {reviewAll.isPending ? t("list.reviewAllRunning") : t("list.reviewAll")}
        </Button>
      </div>
      {panel}
    </div>
  );
}

/** The portaled agent-selection panel — reuses Dropdown's edge-flip math and
   MultiAgentPicker's checkbox-list + confirm-footer layout, without the
   per-PR estimate rows. */
function ReviewAllPanel({
  pos,
  panelRef,
  t,
  enabledAgents,
  selected,
  isPending,
  onToggleAgent,
  onSelectAll,
  onClearAll,
  onConfirm,
  onGoToAgents,
}: {
  pos: PanelPos;
  panelRef: React.RefObject<HTMLDivElement | null>;
  t: ReturnType<typeof useTranslations>;
  enabledAgents: Agent[];
  selected: Set<string>;
  isPending: boolean;
  onToggleAgent: (id: string) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
  onConfirm: () => void;
  onGoToAgents: () => void;
}) {
  const spaceBelow = window.innerHeight - pos.triggerBottom - 8;
  const spaceAbove = pos.triggerTop - 8;
  const openDown = spaceBelow >= spaceAbove || spaceBelow >= 160;
  const maxH = Math.max(160, openDown ? spaceBelow : spaceAbove);
  const placement = openDown
    ? { top: pos.triggerBottom + 6 }
    : { bottom: window.innerHeight - pos.triggerTop + 6 };

  return (
    <div
      ref={panelRef}
      data-testid="review-all-panel"
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
              <Checkbox
                key={a.id}
                checked={selected.has(a.id)}
                onChange={() => onToggleAgent(a.id)}
                label={
                  <span style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                    <Icon.Cpu size={14} style={{ color: "var(--text-muted)", marginTop: 2, flexShrink: 0 }} />
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: "block", fontWeight: 600, fontSize: 13, color: "var(--text-primary)" }}>
                        {a.name}
                      </span>
                      <span style={{ display: "block", fontSize: 12, color: "var(--text-secondary)" }}>
                        {a.description}
                      </span>
                    </span>
                  </span>
                }
              />
            ))}
          </div>

          <div style={{ marginTop: 12 }}>
            <Button
              kind="primary"
              size="sm"
              full
              icon="Sparkles"
              loading={isPending}
              disabled={selected.size === 0 || isPending}
              onClick={onConfirm}
            >
              {isPending ? t("list.reviewAllRunning") : t("list.reviewAll")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
