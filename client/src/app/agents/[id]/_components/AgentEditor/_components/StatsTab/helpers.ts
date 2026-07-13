import type { AgentRunHistoryRow } from "@devdigest/shared";

/** Short "Jun 30"-style label for a week-start ISO date, used as the x-axis
 *  label for the weekly severity chart. Falls back to the raw string for an
 *  unparseable date rather than rendering "Invalid Date". */
export function weekLabel(isoDate: string): string {
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return isoDate;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Formats a latency in milliseconds as seconds (e.g. 8200 → "8.2s"), or
 *  "—" when unknown. */
export function formatLatency(ms: number | null): string {
  if (ms == null) return "—";
  return `${(ms / 1000).toFixed(1)}s`;
}

/** `agent_runs.status` is free text (not a DB enum) — these are the values
 *  the run executor actually writes (`run-executor.ts` / `run.repo.ts`).
 *  Anything else (legacy/unexpected) falls back to the muted "unknown"
 *  treatment below rather than crashing on a missing i18n key. */
const KNOWN_RUN_STATUSES = ["done", "failed", "running", "cancelled"] as const;
type KnownRunStatus = (typeof KNOWN_RUN_STATUSES)[number];

export function isKnownRunStatus(status: string): status is KnownRunStatus {
  return (KNOWN_RUN_STATUSES as readonly string[]).includes(status);
}

/** Badge color/background pair for a run-history row's status. */
export function runStatusMeta(status: AgentRunHistoryRow["status"]): { color: string; bg: string } {
  if (status === "done") return { color: "var(--ok)", bg: "var(--ok-bg)" };
  if (status === "failed") return { color: "var(--crit)", bg: "var(--crit-bg)" };
  if (status === "running") return { color: "var(--accent)", bg: "var(--accent-bg)" };
  return { color: "var(--text-muted)", bg: "var(--bg-hover)" };
}
