import type { IconName } from "@devdigest/ui";

/** Constants for the CI Runs page (/ci-runs). */

/**
 * Grid template for both the header row and each run row (reference-matched
 * 9-column layout):
 * timestamp | pull request (#num + repo) | agent | source | duration |
 * findings | cost | status | trace.
 *
 * `repo` is folded into the pull-request cell as a secondary line (the CI Runs
 * page is cross-repo, so the repo still needs to be visible per row) while
 * `agent` and `source` get their own columns and `duration` is split out of the
 * cost cell — matching the reference design. `source` is a constant
 * "GitHub Actions" badge in v1 (the only functional export target, AC-33).
 *
 * The text columns (PR, agent, source, findings, status) share the row width as
 * weighted `fr` tracks rather than pinning everything except PR to a fixed
 * width — otherwise PR alone absorbs ALL the slack and opens a large gap
 * between the left-aligned PR cell and the AGENT column. Even distribution
 * matches the reference's balanced spacing.
 */
export const GRID = "128px 1.4fr 1.05fr 1.1fr 62px 1fr 80px 1.05fr 62px";

/** The single recency preset this page offers — "keep it simple" (AC-23). */
export const RECENCY_DAYS = 7;

/**
 * Poll while this page is mounted; React Query's own observer lifecycle stops
 * it automatically on unmount — no manual setInterval/visibility tracking
 * needed (AC-16).
 */
export const REFRESH_INTERVAL_MS = 15_000;

/** `CiRun.status` raw values, in display order (status filter + row badges). */
export const STATUS_VALUES = ["succeeded", "no_findings", "failed", "running", "skipped_fork", "skipped_large"] as const;

/**
 * Raw status → visual + i18n mapping (`runs.status.*`). Shared by the status
 * filter dropdown (CiRunsView) and the per-row badge (RunRow) so the two never
 * drift apart.
 */
export const STATUS_META: Record<string, { labelKey: string; color: string; bg: string; icon: IconName }> = {
  succeeded: { labelKey: "succeeded", color: "var(--ok)", bg: "var(--ok-bg)", icon: "CheckCircle" },
  // "No findings" is a clean run with nothing to report — a neutral/muted grey
  // (matches the reference design), distinct from the green "Succeeded" (a run
  // that DID surface findings). Only `succeeded` is green; `failed` is red.
  no_findings: { labelKey: "noFindings", color: "var(--text-muted)", bg: "var(--bg-hover)", icon: "Slash" },
  failed: { labelKey: "failed", color: "var(--crit)", bg: "var(--crit-bg)", icon: "XCircle" },
  running: { labelKey: "running", color: "var(--accent)", bg: "var(--accent-bg)", icon: "RefreshCw" },
  skipped_fork: { labelKey: "skippedFork", color: "var(--text-muted)", bg: "var(--bg-hover)", icon: "Slash" },
  // Review skipped because the PR diff exceeded GitHub's 300-file cap — muted,
  // same neutral treatment as a fork-skip (it isn't a pass, a fail, or "clean").
  skipped_large: { labelKey: "skippedLarge", color: "var(--text-muted)", bg: "var(--bg-hover)", icon: "Slash" },
};

/** Fallback for a null/unrecognized status value — a row must never crash. */
export const DEFAULT_STATUS_META: { labelKey: string; color: string; bg: string; icon: IconName } = {
  labelKey: "running",
  color: "var(--text-muted)",
  bg: "var(--bg-hover)",
  icon: "Clock",
};
