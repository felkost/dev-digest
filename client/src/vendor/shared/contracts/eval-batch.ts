import { z } from 'zod';

/**
 * Eval Batch — batch runs, trend points (v2), case-list-item, and compare
 * contracts (L06).
 *
 * ADDITIVE ONLY. These sit alongside `eval-ci.ts`'s `EvalCaseInput` /
 * `EvalRunRecord` / `EvalRunResult` / `EvalTrendPoint` / `EvalDashboard` —
 * that file is untouched and reserved for future use. Here we add the
 * batch-oriented shapes: a "batch" groups many case runs executed together
 * (full-set or calibration subset) and reports aggregate recall/precision/
 * citation-accuracy plus a per-case outcome breakdown.
 */

// ===========================================================================
// Eval Case — expectations + list item + create/from-finding inputs
// ===========================================================================

/**
 * Which eval methodology a case uses. `expected_output` (see
 * `EvalCaseListItem`/`EvalCaseCreateInput` below) is REUSED across all three
 * kinds with a per-kind shape rather than adding new columns/fields:
 *   - `'review_finding'` (unchanged, pre-WS6 default) → `Expectation[]`
 *   - `'intent'` → `{ in_scope: string[]; out_of_scope: string[] }`
 *   - `'risk_brief_narrative'` → `{ key_points: string[] }`
 * Callers must narrow on `case_kind` before interpreting `expected_output`.
 */
export const EvalCaseKind = z.enum(['review_finding', 'intent', 'risk_brief_narrative']);
export type EvalCaseKind = z.infer<typeof EvalCaseKind>;

/** A single expectation an eval case's expected output must satisfy. */
export const Expectation = z.object({
  type: z.enum(['must_find', 'must_not_flag']),
  file: z.string().min(1),
  line_start: z.number().int(),
  line_end: z.number().int(),
  severity: z.string().nullish(),
  // Finding category (security/bug/perf/…) — display metadata only, copied from
  // the source finding; never read by scoring (AC-24). Shown in the case-row chip.
  category: z.string().nullish(),
  kind: z.string().nullish(),
});
export type Expectation = z.infer<typeof Expectation>;

/** Where an eval case originated from — a promoted finding, or hand-authored. */
export const EvalCaseSource = z.enum(['finding', 'manual']);
export type EvalCaseSource = z.infer<typeof EvalCaseSource>;

/** Row shape for the eval case list view (summary, not full case detail). */
export const EvalCaseListItem = z.object({
  id: z.string(),
  owner_id: z.string(),
  name: z.string(),
  source: EvalCaseSource,
  source_finding_id: z.string().nullish(),
  source_pr_number: z.number().int().nullish(),
  input_diff: z.string(),
  expected_output: z.array(Expectation),
  last_run_status: z.enum(['never_run', 'passed', 'failed', 'error', 'flaked']),
  last_run_summary: z.string().nullish(),
  // Latest run's duration/cost — additive (nullish for never_run and for rows
  // written before these were surfaced). Feeds the Case Editor "Last run" strip.
  last_run_duration_ms: z.number().int().nullish(),
  last_run_cost_usd: z.number().nullish(),
  // The provider/model that ACTUALLY served the case's most recent run — for
  // `intent`/`risk_brief_narrative` kinds this is resolved via a Settings
  // Feature Model override and can differ from the host agent's own
  // provider/model. Nullish: absent for `never_run` cases and for runs
  // written before this field existed.
  last_run_provider: z.string().nullish(),
  last_run_model: z.string().nullish(),
  notes: z.string().nullish(),
  // WS6 — eval methodology (`eval_cases.case_kind`, migration 0026).
  case_kind: EvalCaseKind,
  // WS6 — per-case threshold override (`eval_cases.passing_threshold`,
  // migration 0026). `null` = use the kind's built-in default threshold.
  passing_threshold: z.number().min(0).max(1).nullable(),
  // WS6 — per-kind expected output, populated ONLY for the matching
  // `case_kind` (null otherwise). `expected_output` above stays the
  // review_finding `Expectation[]` shape and is `[]` for the other two kinds,
  // so these carry what that column can't type — letting the Case Editor
  // round-trip intent / risk_brief_narrative expectations on edit.
  intent_expected: z.object({ in_scope: z.array(z.string()), out_of_scope: z.array(z.string()) }).nullish(),
  risk_brief_expected: z.object({ key_points: z.array(z.string()) }).nullish(),
});
export type EvalCaseListItem = z.infer<typeof EvalCaseListItem>;

/**
 * Request body for creating a hand-authored eval case.
 *
 * `expected_output` is REUSED across all `case_kind` values with a
 * per-kind shape (rather than adding new columns/fields per kind):
 *   - `'review_finding'` (unchanged, pre-WS6 default) → `Expectation[]`
 *   - `'intent'` → `{ in_scope: string[]; out_of_scope: string[] }`
 *   - `'risk_brief_narrative'` → `{ key_points: string[] }`
 * The Zod shape below stays `Expectation[]`-typed for the pre-WS6 default
 * path; a `case_kind`-narrowed parse/validation for the other two shapes
 * is added by the WS6 orchestrator step that consumes them.
 */
export const EvalCaseCreateInput = z.object({
  owner_id: z.string(),
  name: z.string().min(1),
  input_diff: z.string(),
  expected_output: z.array(Expectation),
  notes: z.string().nullish(),
  // WS6 — defaults to the pre-existing behavior for callers that don't
  // send it yet (e.g. the existing finding-promotion flow).
  case_kind: EvalCaseKind.default('review_finding'),
  // WS6 — per-case threshold override; omitted/null = use the kind's
  // built-in default threshold.
  passing_threshold: z.number().min(0).max(1).nullish(),
  // WS6 — per-kind expected output for the two non-review_finding kinds. The
  // server selects which one to persist into the JSONB `expected_output`
  // column by `case_kind`; for a review_finding case both are omitted and
  // `expected_output` (above) carries the `Expectation[]`.
  intent_expected: z.object({ in_scope: z.array(z.string()), out_of_scope: z.array(z.string()) }).nullish(),
  risk_brief_expected: z.object({ key_points: z.array(z.string()) }).nullish(),
});
export type EvalCaseCreateInput = z.infer<typeof EvalCaseCreateInput>;

/** Request body for promoting an existing finding into an eval case. */
export const EvalCaseFromFindingInput = z.object({
  finding_id: z.string(),
});
export type EvalCaseFromFindingInput = z.infer<typeof EvalCaseFromFindingInput>;

// ===========================================================================
// Eval Batch — a run of many cases together, plus per-case outcomes
// ===========================================================================

/** `full` = every case for the agent; `calibration` = an explicit subset. */
export const EvalBatchKind = z.enum(['full', 'calibration']);
export type EvalBatchKind = z.infer<typeof EvalBatchKind>;

/** `degraded` when any case errored or a skill-owned case had to be excluded. */
export const EvalBatchStatus = z.enum(['clean', 'degraded']);
export type EvalBatchStatus = z.infer<typeof EvalBatchStatus>;

/** A persisted eval batch row (aggregate metrics across its member cases). */
export const EvalBatch = z.object({
  id: z.string(),
  agent_id: z.string(),
  kind: EvalBatchKind,
  status: EvalBatchStatus.nullable(),
  agent_snapshot: z.unknown(),
  recall: z.number().nullable(),
  precision: z.number().nullable(),
  citation_accuracy: z.number().nullable(),
  cost_usd: z.number().nullable(),
  ran_at: z.string(),
  // Frozen copy of the host agent's system prompt at run time — `null` means
  // this batch predates the feature (never an empty string for "no prompt").
  system_prompt_snapshot: z.string().nullable(),
});
export type EvalBatch = z.infer<typeof EvalBatch>;

/** Per-case outcome within a batch. */
export const EvalBatchCaseOutcome = z.object({
  case_id: z.string(),
  case_name: z.string(),
  status: z.enum(['passed', 'failed', 'error']),
  expected_count: z.number().int(),
  matched_count: z.number().int(),
  findings_count: z.number().int(),
  cost_usd: z.number().nullable(),
  // Concise cause string for an errored run (per-case runtime failure), so a
  // Degraded batch's cause is visible in the UI drill-down instead of only
  // server stderr logs. Null for deterministic passed/failed runs.
  error_message: z.string().nullish(),
  // The provider/model that ACTUALLY served this run's LLM call (see
  // `EvalCaseListItem.last_run_provider`/`last_run_model` for why this can
  // differ from the batch's `agent_snapshot`). Nullish: absent on a runtime-
  // failed run (no call completed) or on rows written before this field existed.
  provider: z.string().nullish(),
  model: z.string().nullish(),
});
export type EvalBatchCaseOutcome = z.infer<typeof EvalBatchCaseOutcome>;

/** Full batch detail — aggregate row + the per-case breakdown. */
export const EvalBatchDetail = EvalBatch.extend({
  cases: z.array(EvalBatchCaseOutcome),
  excluded_skill_owned_count: z.number().int(),
});
export type EvalBatchDetail = z.infer<typeof EvalBatchDetail>;

/** One point on the batch trend chart (v2 — batch-oriented, supersedes nothing). */
export const EvalTrendPointV2 = z.object({
  batch_id: z.string(),
  ran_at: z.string(),
  recall: z.number(),
  precision: z.number(),
  citation_accuracy: z.number(),
  is_degraded: z.boolean(),
  agent_snapshot: z.unknown(),
  cost_usd: z.number().nullable(),
});
export type EvalTrendPointV2 = z.infer<typeof EvalTrendPointV2>;

/**
 * Request body for `POST /agents/:id/eval-batches` (or equivalent run-batch
 * route). Omitted/absent `case_ids` → full-set run; present with a strict
 * subset of the agent's cases → calibration batch. When present, must be a
 * non-empty array of UUIDs (seed and real cases always use real UUIDs).
 */
export const EvalRunBatchRequest = z.object({
  case_ids: z.array(z.string().uuid()).min(1).nullish(),
});
export type EvalRunBatchRequest = z.infer<typeof EvalRunBatchRequest>;

/** Result of comparing two batches (e.g. before/after an agent change). */
export const EvalBatchCompareResult = z.object({
  a: EvalBatchDetail,
  b: EvalBatchDetail,
  deltas: z.object({
    recall: z.number(),
    precision: z.number(),
    citation_accuracy: z.number(),
    cost_usd: z.number().nullable(),
  }),
  // Whether both batches carry a `system_prompt_snapshot` to diff — false when
  // either batch predates the feature (see `EvalBatch.system_prompt_snapshot`).
  prompt_diff_available: z.boolean(),
});
export type EvalBatchCompareResult = z.infer<typeof EvalBatchCompareResult>;

// ===========================================================================
// Eval Run — 202-accepted response + KPI delta + canonical wire types
// ===========================================================================

/**
 * Response body for `POST /agents/:id/evals/run` (202 Accepted). The client
 * then polls `GET /agents/:id/evals/batches/:batchId` (batch-detail) for
 * completion instead of waiting on this response synchronously.
 */
export const EvalRunAcceptedResponse = z.object({
  batch_id: z.string().uuid(),
});
export type EvalRunAcceptedResponse = z.infer<typeof EvalRunAcceptedResponse>;

/**
 * KPI delta vs. the previous FULL batch (AC-31 — calibration batches are
 * never used as the baseline). `null` when there is no previous full batch
 * to compare against (e.g. this is the agent's first full run).
 */
export const EvalKpiDeltaResponse = z
  .object({
    recall: z.number(),
    precision: z.number(),
    citation_accuracy: z.number(),
  })
  .nullable();
export type EvalKpiDeltaResponse = z.infer<typeof EvalKpiDeltaResponse>;

/** `GET /agents/:id/evals/cases` response envelope (case list + the visible
 *  count of workspace skill-owned cases excluded from it, AC-2). */
export const EvalCaseListResponse = z.object({
  cases: z.array(EvalCaseListItem),
  excluded_skill_owned_count: z.number().int(),
});
export type EvalCaseListResponse = z.infer<typeof EvalCaseListResponse>;

/**
 * `POST /agents/:id/evals/run` response — the orchestrator's immediate
 * return value (batch id/kind/status), not the full `EvalBatchDetail` (no
 * `cases`/exclusion count is composed at run time). snake_case wire shape —
 * canonical replacement for any camelCase local client copy.
 */
export const EvalRunBatchResponse = z.object({
  batch_id: z.string().uuid(),
  kind: EvalBatchKind,
  status: EvalBatchStatus.nullable(),
});
export type EvalRunBatchResponse = z.infer<typeof EvalRunBatchResponse>;

// ===========================================================================
// Cross-Agent Eval Dashboard — per-agent summary, recent-batch row, run-all
// result, and the eval→agent-version promote request
// ===========================================================================

/** One row on the dashboard's agent grid — latest batch + a recall sparkline. */
export const EvalAgentSummary = z.object({
  agent_id: z.string(),
  agent_name: z.string(),
  model: z.string(),
  latest_batch: EvalBatch.nullable(),
  // PROMPT version of the agent's latest full batch — bumps only when the
  // agent's system-prompt text changes (repeated runs on an unchanged prompt
  // share one version), NOT a run/attempt ordinal. Null when the latest full
  // batch predates prompt-snapshot tracking. Derived server-side (no column).
  latest_version: z.number().int().nullable(),
  sparkline_points: z.array(
    z.object({
      ran_at: z.string(),
      recall: z.number(),
    }),
  ),
  case_count: z.number().int(),
});
export type EvalAgentSummary = z.infer<typeof EvalAgentSummary>;

/** One row in the dashboard's cross-agent "recent batches" feed. */
export const EvalRecentBatchRow = z.object({
  batch: EvalBatch,
  agent_id: z.string(),
  agent_name: z.string(),
  // PROMPT version of this batch — bumps only when the agent's system-prompt
  // text changes (unchanged-prompt reruns share one version), NOT a run
  // ordinal. Null when the batch predates prompt-snapshot tracking.
  version: z.number().int().nullable(),
  pass_count: z.number().int(),
  total_count: z.number().int(),
});
export type EvalRecentBatchRow = z.infer<typeof EvalRecentBatchRow>;

/** Result of `POST /evals/run-all` — one entry per agent whose batch started. */
export const EvalRunAllResult = z.object({
  started: z.array(
    z.object({
      agent_id: z.string(),
      batch_id: z.string(),
    }),
  ),
});
export type EvalRunAllResult = z.infer<typeof EvalRunAllResult>;

/** Request body for promoting a batch's agent snapshot into a new `AgentVersion`. */
export const EvalPromoteRequest = z.object({
  batch_id: z.string().uuid(),
});
export type EvalPromoteRequest = z.infer<typeof EvalPromoteRequest>;
