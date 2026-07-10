"use client";

import React from "react";
import type { useTranslations } from "next-intl";
import { Badge, Button, Icon } from "@devdigest/ui";
import type { CiInstallation } from "@devdigest/shared";
// Reused directly (not duplicated) from the CI Runs page's own canonical
// status→color/label map, which exists specifically so its filter dropdown and
// row badge never drift apart (see that file's doc comment).
import { STATUS_META, DEFAULT_STATUS_META } from "@/app/ci-runs/_components/CiRunsView/constants";
import { s } from "../styles";

/** "4m ago" / "1h ago" / "3d ago" for the latest run; null when never run. */
function relativeAgo(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const m = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

interface InstallationRowProps {
  t: ReturnType<typeof useTranslations>;
  installation: CiInstallation;
  onDisconnect: (installationId: string) => void;
  disconnectPending: boolean;
}

export function InstallationRow({ t, installation, onDisconnect, disconnectPending }: InstallationRowProps) {
  const [hover, setHover] = React.useState(false);
  const status = installation.latest_run_status;
  // `null` (never run) keeps its own "—" fallback below — distinct from
  // DEFAULT_STATUS_META, which only guards an unrecognized non-null string.
  const meta = status ? (STATUS_META[status] ?? DEFAULT_STATUS_META) : null;
  const lastRun = relativeAgo(installation.latest_run_at);
  return (
    <div
      style={{ ...s.row, background: hover ? "var(--bg-hover)" : "var(--bg-elevated)" }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div style={s.rowMain}>
        <Icon.GitBranch size={15} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
        <span style={s.rowRepo}>{installation.repo}</span>
      </div>
      <div style={s.rowMeta}>
        <Badge icon="Workflow">{t(`exportWizard.targets.${installation.target_type}`)}</Badge>
        {meta ? (
          <Badge dot color={meta.color} bg={meta.bg}>
            {t(`runs.status.${meta.labelKey}`)}
          </Badge>
        ) : (
          <span style={s.rowMuted}>—</span>
        )}
        {lastRun && <span style={s.rowVersion}>{lastRun}</span>}
        {/* Revealed on row hover via opacity so the row keeps a calm, clean
            resting state (matches the reference) without a layout shift. */}
        <span style={{ opacity: hover ? 1 : 0, pointerEvents: hover ? "auto" : "none", transition: "opacity .12s" }}>
          <Button
            kind="danger"
            size="sm"
            onClick={() => onDisconnect(installation.id)}
            disabled={disconnectPending}
          >
            {t("ciTab.disconnect")}
          </Button>
        </span>
      </div>
    </div>
  );
}
