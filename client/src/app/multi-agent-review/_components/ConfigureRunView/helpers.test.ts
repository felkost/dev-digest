import { describe, it, expect } from "vitest";
import { combineEstimates } from "./helpers";

const ESTIMATES = [
  { agent_id: "a1", avg_duration_ms: 8200, avg_cost_usd: 0.06, sample_size: 3 },
  { agent_id: "a2", avg_duration_ms: 6900, avg_cost_usd: 0.04, sample_size: 3 },
  { agent_id: "a3", avg_duration_ms: 7100, avg_cost_usd: 0.05, sample_size: 3 },
  { agent_id: "a4", avg_duration_ms: null, avg_cost_usd: null, sample_size: 0 },
];

describe("combineEstimates", () => {
  it("combines duration as MAX and cost as SUM across selected agents (AC-8)", () => {
    const result = combineEstimates(["a1", "a2", "a3"], ESTIMATES);
    expect(result.maxDurationMs).toBe(8200);
    expect(result.sumCostUsd).toBeCloseTo(0.15, 5);
    expect(result.missing).toBe(false);
  });

  it("flags missing and excludes the unavailable agent from both aggregates (AC-9)", () => {
    const result = combineEstimates(["a1", "a4"], ESTIMATES);
    expect(result.maxDurationMs).toBe(8200);
    expect(result.sumCostUsd).toBeCloseTo(0.06, 5);
    expect(result.missing).toBe(true);
  });

  it("returns nulls with missing=false when no agent is selected", () => {
    const result = combineEstimates([], ESTIMATES);
    expect(result).toEqual({ maxDurationMs: null, sumCostUsd: null, missing: false });
  });
});
