import type { Conflict } from "@devdigest/shared";

/**
 * AC-29/30: a location is a genuine disagreement when its takes do not all
 * share one verdict (some agent flagged it and another didn't, or two agents
 * flagged it at different severities). `computeConflicts` (server) already
 * includes full-agreement locations in its output on purpose — this is the
 * client-side display filter that narrows to disagreements only (AC-31's
 * default-on "Show only conflicts" state).
 */
export function isDisagreement(conflict: Conflict): boolean {
  const verdicts = new Set(conflict.takes.map((take) => take.verdict));
  return verdicts.size > 1;
}
