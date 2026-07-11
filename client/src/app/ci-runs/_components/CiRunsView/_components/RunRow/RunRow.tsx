"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, Icon, SEV } from "@devdigest/ui";
import type { CiRun } from "@devdigest/shared";
import { formatCost } from "@/lib/format";
import { githubPrUrl } from "@/lib/github-urls";
import { absoluteTime, formatDuration } from "../../helpers";
import { STATUS_META, DEFAULT_STATUS_META } from "../../constants";
import { s } from "../../styles";

/**
 * RunRow — one CI run in the CI Runs table (reference 9-column layout:
 * timestamp | PR (#num + repo) | agent | source | duration | findings | cost |
 * status | trace).
 *
 * The findings breakdown reuses PRRow's "always show all 3, dim 0-counts"
 * convention rather than a click-to-open popup: `CiRun` only carries aggregate
 * critical/warning/suggestion counts, never per-finding detail to drill into.
 * `SEV.*.label` (design-system tokens, not next-intl) is reused for the hover
 * title only, matching RunHistory.tsx's precedent.
 */
const SEV_COLS = [
  { key: "critical" as const, color: "var(--crit)", Icon: Icon.AlertOctagon, label: SEV.CRITICAL.label },
  { key: "warning" as const, color: "var(--warn)", Icon: Icon.AlertTriangle, label: SEV.WARNING.label },
  { key: "suggestion" as const, color: "var(--sugg)", Icon: Icon.Lightbulb, label: SEV.SUGGESTION.label },
];

// The generated workflow's `ci_runs.source` is a free-form string; map the
// known CI systems to their display label and fall back to the raw value for
// anything unrecognized (never throw on a missing i18n key).
const KNOWN_SOURCES = ["gha", "circle", "jenkins", "cli"];

export function RunRow({ run }: { run: CiRun }) {
  const t = useTranslations("ci");
  const meta = STATUS_META[run.status ?? ""] ?? DEFAULT_STATUS_META;
  const hasBreakdown = run.critical != null || run.warning != null || run.suggestion != null;
  const breakdownTitle = SEV_COLS.map(({ key, label }) => `${run[key] ?? 0} ${label}`).join(" · ");
  const src = run.source ?? "gha";
  const sourceLabel = KNOWN_SOURCES.includes(src) ? t(`exportWizard.targets.${src}`) : src;

  return (
    <div style={s.row}>
      <div className="mono" style={s.cellSecondary}>
        {absoluteTime(run.ran_at)}
      </div>

      <div style={{ minWidth: 0 }}>
        {run.pr_number == null ? (
          <span style={s.muted}>—</span>
        ) : run.repo ? (
          // A PR number links to the PR itself (…/pull/{n}), NOT the CI job run
          // (that's what the Trace column is for). Built from repo + pr_number
          // we already hold — see githubPrUrl.
          <a
            href={githubPrUrl(run.repo, run.pr_number)}
            target="_blank"
            rel="noreferrer"
            title={t("runs.viewPr")}
            aria-label={t("runs.viewPr")}
            className="mono"
            style={{ ...s.cellPrimary, color: "var(--accent-text)" }}
          >
            #{run.pr_number}
          </a>
        ) : (
          <span className="mono" style={s.cellPrimary}>
            #{run.pr_number}
          </span>
        )}
        <div style={s.cellSecondary}>{run.pr_title ?? run.repo ?? "—"}</div>
      </div>

      <div style={{ minWidth: 0 }}>
        <span style={s.cellPrimary}>{run.agent ?? "—"}</span>
      </div>

      <div>
        <Badge icon="Workflow">{sourceLabel}</Badge>
      </div>

      <div style={s.cellSecondary}>{formatDuration(run.duration_s)}</div>

      <div style={s.findingsCell}>
        <span style={s.cellPrimary}>{run.findings_count ?? "—"}</span>
        {hasBreakdown && (
          <div style={s.findingsBadgeRow} title={breakdownTitle}>
            {SEV_COLS.map(({ key, color, Icon: SevIcon }) => {
              const cnt = run[key] ?? 0;
              return (
                <span key={key} style={{ ...s.findingsBadge(color), opacity: cnt > 0 ? 1 : 0.45 }}>
                  <SevIcon size={11} />
                  {cnt}
                </span>
              );
            })}
          </div>
        )}
      </div>

      <div>
        <span style={s.cellPrimary}>{formatCost(run.cost_usd)}</span>
      </div>

      <div>
        <Badge dot color={meta.color} bg={meta.bg}>
          {t(`runs.status.${meta.labelKey}`)}
        </Badge>
      </div>

      <div>
        {run.github_url ? (
          <a href={run.github_url} target="_blank" rel="noreferrer" title={t("runs.viewJob")} style={s.traceLink}>
            {t("runs.trace")}
          </a>
        ) : (
          <span style={s.muted}>—</span>
        )}
      </div>
    </div>
  );
}
