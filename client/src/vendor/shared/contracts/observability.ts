import { z } from 'zod';
import { Severity } from './findings.js';
import { FindingRecord } from './review-api.js';

/**
 * A5 — Observability / Multi-agent contracts (L07).
 *
 * These are NEW contracts (A5 owns this file; the barrel re-exports it). They
 * sit alongside A2's `review-api.ts`:
 *   - MultiAgentRun        the response of POST /pulls/:id/multi-agent-run
 *   - AgentColumn          one agent's column in the multi-agent view
 *   - Conflict / ConflictTake  where agents disagree on the same file:line
 *   - AgentStats           per-agent quality aggregates (GET /agents/:id/stats)
 *   - CuratorResult        the cross-session memory curator outcome
 *
 * The single-document run trace itself stays in `contracts/trace.ts` (RunTrace).
 */

// ---------------------------------------------------------------------------
// Multi-Agent Review
// ---------------------------------------------------------------------------

/** A finding as surfaced in a multi-agent column (subset of FindingRecord). */
export const AgentColumnFinding = z.object({
  id: z.string(),
  severity: Severity,
  category: z.string(),
  title: z.string(),
  file: z.string(),
  start_line: z.number().int(),
  kind: z.string().nullish(),
});
export type AgentColumnFinding = z.infer<typeof AgentColumnFinding>;

/** One agent's result column in the multi-agent review. */
export const AgentColumn = z.object({
  run_id: z.string(),
  agent_id: z.string(),
  agent_name: z.string(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  status: z.enum(['done', 'failed', 'running']),
  verdict: z.string().nullable(),
  score: z.number().int().nullable(),
  summary: z.string().nullable(),
  duration_ms: z.number().int().nullable(),
  cost_usd: z.number().nullable(),
  // Additive extension approved 2026-07-10 to satisfy AC-17 (error) / AC-33
  // (tokens); the only consumers are this feature's own service + client
  // views — see server/insights.md and client/insights.md 2026-07-09 entries
  // documenting the gap this closes.
  error: z.string().nullable(),
  tokens_in: z.number().int().nullable(),
  tokens_out: z.number().int().nullable(),
  findings: z.array(AgentColumnFinding),
});
export type AgentColumn = z.infer<typeof AgentColumn>;

/** One agent's stance on a contended file:line. */
export const ConflictTake = z.object({
  agent_id: z.string(),
  persona: z.string(),
  /** Severity if the agent flagged it, or 'ignored' when it did not. */
  verdict: z.union([Severity, z.literal('ignored')]),
  note: z.string(),
});
export type ConflictTake = z.infer<typeof ConflictTake>;

/**
 * A conflict = a file:line that at least one agent flagged and at least one
 * other agent (that also reviewed) did NOT, OR where agents assigned divergent
 * severities. Computed from persisted findings; not stored.
 */
export const Conflict = z.object({
  file: z.string(),
  line: z.number().int(),
  title: z.string(),
  takes: z.array(ConflictTake),
});
export type Conflict = z.infer<typeof Conflict>;

/** Response of POST /pulls/:id/multi-agent-run and GET /pulls/:id/multi-agent. */
export const MultiAgentRun = z.object({
  id: z.string(),
  pr_id: z.string(),
  pr_number: z.number().int().nullish(),
  ran_at: z.string(),
  agent_count: z.number().int(),
  total_duration_ms: z.number().int(),
  total_cost_usd: z.number().nullable(),
  // Additive extension approved 2026-07-10 to satisfy AC-33 (token usage);
  // same null-if-any-unknown semantics as total_cost_usd. The only consumers
  // are this feature's own service + client views.
  total_tokens_in: z.number().int().nullable(),
  total_tokens_out: z.number().int().nullable(),
  columns: z.array(AgentColumn),
  conflicts: z.array(Conflict),
  // Full per-run findings (keyed by run_id) for the results page's Tabs view
  // and the reused RunTraceDrawer — the SINGLE source of finding detail for
  // this page. Deliberately NOT sourced from the PR-detail `GET /pulls/:id/reviews`
  // (which excludes multi-agent fan-out runs), so the drawer/Tabs never show
  // an empty findings list while the columns show findings. `AgentColumn.findings`
  // stays the compact projection; this carries the full FindingRecord shape.
  findings_by_run: z.record(z.string(), z.array(FindingRecord)),
});
export type MultiAgentRun = z.infer<typeof MultiAgentRun>;

// ---------------------------------------------------------------------------
// Per-agent Stats (GET /agents/:id/stats)
// ---------------------------------------------------------------------------

/** A single (date, value) point for a sparkline/trend. */
export const StatPoint = z.object({ label: z.string(), value: z.number() });
export type StatPoint = z.infer<typeof StatPoint>;

export const AgentStats = z.object({
  agent_id: z.string(),
  agent_name: z.string(),
  runs: z.number().int(),
  findings_total: z.number().int(),
  /** accept-rate is the headline quality signal. 0..1 over acted findings. */
  accepted: z.number().int(),
  dismissed: z.number().int(),
  pending: z.number().int(),
  accept_rate: z.number().nullable(),
  dismiss_rate: z.number().nullable(),
  avg_findings_per_run: z.number().nullable(),
  total_cost_usd: z.number().nullable(),
  avg_cost_usd: z.number().nullable(),
  avg_latency_ms: z.number().nullable(),
  findings_by_severity: z.object({
    CRITICAL: z.number().int(),
    WARNING: z.number().int(),
    SUGGESTION: z.number().int(),
  }),
  /** recent runs for a small trend chart (oldest→newest). */
  trend: z.array(StatPoint),
});
export type AgentStats = z.infer<typeof AgentStats>;

// ---------------------------------------------------------------------------
// Per-agent Stats — additive detail wrapper (GET /agents/:id/stats, L08 Spec B)
// ---------------------------------------------------------------------------

/** One run in an agent's run history. Studio runs only (source='local'). */
export const AgentRunHistoryRow = z.object({
  run_id: z.string(),
  ran_at: z.string(),
  status: z.string().nullable(),
  cost_usd: z.number().nullable(),
  findings_count: z.number().int().nullable(),
  pr_number: z.number().int().nullable(),
});
export type AgentRunHistoryRow = z.infer<typeof AgentRunHistoryRow>;

/** One week's findings-by-severity counts for the weekly stacked-bar chart.
 *  Zero-filled by the service — a week with no findings of a given severity
 *  is 0, not omitted (8 ordered points, oldest→newest). */
export const WeeklySeverityPoint = z.object({
  week_start: z.string(),
  CRITICAL: z.number().int(),
  WARNING: z.number().int(),
  SUGGESTION: z.number().int(),
});
export type WeeklySeverityPoint = z.infer<typeof WeeklySeverityPoint>;

/** A ranked usage row — shared shape for `most_used_skills` and
 *  `memory_pulled_summary`. `usage_estimate` is an approximation (flat
 *  magnitude from the agent's run volume), never a measured usage count. */
export const AgentRankedUsageRow = z.object({
  id: z.string(),
  name: z.string(),
  usage_estimate: z.number(),
});
export type AgentRankedUsageRow = z.infer<typeof AgentRankedUsageRow>;

/**
 * Response of GET /agents/:id/stats. Additive wrapper around the existing
 * `AgentStats` base metrics (unchanged) — mirrors the `EvalBatchDetail =
 * EvalBatch.extend({...})` pattern in `eval-batch.ts`.
 */
export const AgentStatsDetail = AgentStats.extend({
  cost_delta_usd_30d: z.number().nullable(),
  weekly_findings_by_severity: z.array(WeeklySeverityPoint),
  most_used_skills: z.array(AgentRankedUsageRow),
  memory_pulled_summary: z.array(AgentRankedUsageRow),
  run_history: z.array(AgentRunHistoryRow),
});
export type AgentStatsDetail = z.infer<typeof AgentStatsDetail>;

// ---------------------------------------------------------------------------
// Cross-session memory curator
// ---------------------------------------------------------------------------

/** A merge the curator performed (or would perform in dry-run). */
export const CuratorMerge = z.object({
  kept_id: z.string(),
  merged_ids: z.array(z.string()),
  content: z.string(),
  similarity: z.number(),
});
export type CuratorMerge = z.infer<typeof CuratorMerge>;

export const CuratorResult = z.object({
  scanned: z.number().int(),
  merges: z.array(CuratorMerge),
  removed: z.number().int(),
  dry_run: z.boolean(),
});
export type CuratorResult = z.infer<typeof CuratorResult>;
