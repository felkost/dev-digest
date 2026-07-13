import type { AgentEstimate } from "@devdigest/shared";

export interface CombinedEstimate {
  /** MAX of the selected agents' known average durations (AC-8). Null when none is known. */
  maxDurationMs: number | null;
  /** SUM of the selected agents' known average costs (AC-8). Null when none is known. */
  sumCostUsd: number | null;
  /** True when at least one selected agent's duration or cost estimate is unavailable (AC-9). */
  missing: boolean;
}

/**
 * Combine the pre-run estimates of the selected agents: duration takes the
 * MAXIMUM (agents run concurrently), cost takes the SUM (each agent is
 * billed independently) — AC-8. An agent with no run history (or an
 * independently-unknown cost) is excluded from its respective aggregate
 * rather than treated as zero, and flips `missing` to true — AC-9.
 */
export function combineEstimates(
  selectedAgentIds: string[],
  estimates: AgentEstimate[],
): CombinedEstimate {
  const byId = new Map(estimates.map((e) => [e.agent_id, e]));
  let maxDurationMs: number | null = null;
  let sumCostUsd = 0;
  let anyCostKnown = false;
  let missing = false;

  for (const id of selectedAgentIds) {
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
