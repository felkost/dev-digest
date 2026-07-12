/* format.ts — small display helpers shared by the Configure-run flow and the
   results page. Co-located at the feature root (not a route, not a
   component) so both `_components/ConfigureRunView` and
   `[runId]/_components/MultiAgentResultsView` can import it via the same
   `@/app/multi-agent-review/format` path without relative-depth counting. */

/** Formats a duration in milliseconds for compact display ("420ms", "8.2s", "1.4m"). */
export function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${(seconds / 60).toFixed(1)}m`;
}

/** Formats a KNOWN (non-null) token count for compact display ("340", "1.2k").
 *  Callers decide the "unknown" affordance for a null count (AC-33) — never
 *  coerce null to 0. */
export function formatTokenCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}
