"use client";

import React from "react";
import { Icon, Badge, type IconName } from "@devdigest/ui";
import type { EvalCaseListItem } from "@devdigest/shared";
import { s } from "../../styles";

/** Status → icon + color, 5 distinct visual states (AC-26/AC-27). */
const STATUS_META: Record<EvalCaseListItem["last_run_status"], { icon: IconName; color: string }> = {
  never_run: { icon: "Dot", color: "var(--text-muted)" },
  passed: { icon: "CheckCircle", color: "var(--ok)" },
  failed: { icon: "XCircle", color: "var(--crit)" },
  error: { icon: "AlertOctagon", color: "var(--crit)" },
  flaked: { icon: "AlertTriangle", color: "var(--warn)" },
};

interface CaseRowProps {
  evalCase: EvalCaseListItem;
  statusLabel: string;
  subtitle: string | null;
  expectationBadgeLabel: string;
  runLabel: string;
  editLabel: string;
  deleteLabel: string;
  onRun: () => void;
  onEdit: () => void;
  onDelete: () => void;
  isRunning: boolean;
  /** True whenever any batch run (this case, another case, or run-all) is in
      flight — disables Run so overlapping batches can't be triggered (S4). */
  runDisabled?: boolean;
}

export function CaseRow({
  evalCase,
  statusLabel,
  subtitle,
  expectationBadgeLabel,
  runLabel,
  editLabel,
  deleteLabel,
  onRun,
  onEdit,
  onDelete,
  isRunning,
  runDisabled,
}: CaseRowProps) {
  const meta = STATUS_META[evalCase.last_run_status];
  const StatusIcon = Icon[meta.icon];

  return (
    <div style={s.row} data-testid={`eval-case-row-${evalCase.id}`}>
      <StatusIcon size={16} style={{ color: meta.color, flexShrink: 0 }} aria-label={statusLabel} />
      <div style={s.rowMain}>
        <div style={s.rowName}>{evalCase.name}</div>
        {subtitle && <div style={s.rowSubtitle}>{subtitle}</div>}
      </div>
      <Badge color="var(--text-muted)">{expectationBadgeLabel}</Badge>
      <div style={s.rowActions}>
        <button type="button" style={s.iconAction} title={runLabel} aria-label={runLabel} onClick={onRun} disabled={isRunning || runDisabled}>
          <Icon.Play size={14} />
        </button>
        <button type="button" style={s.iconAction} title={editLabel} aria-label={editLabel} onClick={onEdit}>
          <Icon.Edit size={14} />
        </button>
        <button type="button" style={s.iconAction} title={deleteLabel} aria-label={deleteLabel} onClick={onDelete}>
          <Icon.Trash size={14} />
        </button>
      </div>
    </div>
  );
}
