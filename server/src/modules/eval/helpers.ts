import type {
  Expectation,
  EvalBatch,
  EvalBatchCaseOutcome,
  EvalBatchDetail,
  EvalCaseListItem,
  EvalCaseSource,
  EvalRunBatchResponse,
  EvalTrendPointV2,
} from '@devdigest/shared';
import type * as t from '../../db/schema.js';
import type { CaseScoreResult } from './scoring.js';
import { matchesExpectation } from './scoring.js';

type EvalCaseRow = typeof t.evalCases.$inferSelect;
type EvalBatchRow = typeof t.evalBatches.$inferSelect;
type EvalRunRow = typeof t.evalRuns.$inferSelect;

/**
 * eval/helpers.ts — pure DTO mapping between Drizzle row shapes and the
 * Step 2 `@devdigest/shared` contract shapes. No I/O, no business rules —
 * those live in service.ts / run-orchestrator.ts / scoring.ts respectively.
 */

/** `eval_cases.expected_output` is untyped JSONB — parse defensively to `Expectation[]`. */
export function expectationsFromJson(raw: unknown): Expectation[] {
  if (!Array.isArray(raw)) return [];
  return raw as Expectation[];
}

/**
 * A case's `last_run_status`/`last_run_summary`, given its most recent run (if
 * any) and whether it is currently flagged as flaked (service-computed).
 */
export function caseListItem(
  row: EvalCaseRow,
  latestRun: EvalRunRow | null,
  flaked: boolean,
): EvalCaseListItem {
  const expected_output = expectationsFromJson(row.expectedOutput);

  let last_run_status: EvalCaseListItem['last_run_status'];
  let last_run_summary: string | null = null;

  if (!latestRun) {
    last_run_status = 'never_run';
  } else if (flaked) {
    last_run_status = 'flaked';
    last_run_summary = summaryForRun(latestRun, expected_output);
  } else if (latestRun.pass === null) {
    last_run_status = 'error';
  } else if (latestRun.pass) {
    last_run_status = 'passed';
    last_run_summary = summaryForRun(latestRun, expected_output);
  } else {
    last_run_status = 'failed';
    last_run_summary = summaryForRun(latestRun, expected_output);
  }

  return {
    id: row.id,
    owner_id: row.ownerId,
    name: row.name,
    source: (row.inputMeta as { source?: EvalCaseSource } | null)?.source ?? 'manual',
    source_finding_id: (row.inputMeta as { source_finding_id?: string } | null)?.source_finding_id ?? null,
    source_pr_number: (row.inputMeta as { source_pr_number?: number } | null)?.source_pr_number ?? null,
    input_diff: row.inputDiff ?? '',
    expected_output,
    last_run_status,
    last_run_summary,
    notes: row.notes,
  };
}

/**
 * Composes the case-list "last run" summary string (#15). A `must_not_flag`
 * -only case (zero `must_find` expectations — `expectedOutput` has at least
 * one `must_not_flag` entry and none `must_find`) has no recall to report at
 * all ("recall —% · precision X%" is misleading, not just incomplete — there
 * was never anything to find). For that case, the adapted wording spells out
 * exactly what was guarded against and how many findings actually landed in
 * the guarded zone(s), using the run's OWN `actual_output` (the findings
 * produced by that specific run) rather than re-deriving from current state.
 */
function summaryForRun(run: EvalRunRow, expectedOutput: Expectation[]): string | null {
  const mustFindTotal = expectedOutput.filter((e) => e.type === 'must_find').length;
  const mustNotFlagExpectations = expectedOutput.filter((e) => e.type === 'must_not_flag');

  if (mustFindTotal === 0 && mustNotFlagExpectations.length > 0) {
    const actualFindings = Array.isArray(run.actualOutput)
      ? (run.actualOutput as { file: string; start_line: number; end_line: number }[])
      : [];
    const violatingCount = actualFindings.filter((f) =>
      mustNotFlagExpectations.some((expectation) =>
        matchesExpectation({ file: f.file, startLine: f.start_line, endLine: f.end_line }, expectation),
      ),
    ).length;
    return `expected 0 flagged in guarded zone(s), got ${violatingCount}`;
  }

  const recallPct = run.recall != null ? Math.round(run.recall * 100) : null;
  const precisionPct = run.precision != null ? Math.round(run.precision * 100) : null;
  if (recallPct === null && precisionPct === null) return null;
  return `recall ${recallPct ?? '—'}% · precision ${precisionPct ?? '—'}%`;
}

/** Map an `eval_batches` row to the shared `EvalBatch` DTO. */
export function batchDto(row: EvalBatchRow): EvalBatch {
  return {
    id: row.id,
    agent_id: row.agentId,
    kind: row.kind,
    status: row.status,
    agent_snapshot: row.agentSnapshot,
    recall: row.recall,
    precision: row.precision,
    citation_accuracy: row.citationAccuracy,
    cost_usd: row.costUsd,
    ran_at: row.ranAt.toISOString(),
  };
}

/** Map an `eval_runs` row (+ its case) to the shared per-case outcome DTO. */
export function batchCaseOutcome(
  run: EvalRunRow,
  caseRow: EvalCaseRow,
  scoreResult: CaseScoreResult | null,
  status: 'passed' | 'failed' | 'error',
): EvalBatchCaseOutcome {
  return {
    case_id: caseRow.id,
    case_name: caseRow.name,
    status,
    expected_count: scoreResult?.mustFindTotal ?? 0,
    matched_count: scoreResult?.mustFindMatched ?? 0,
    findings_count: scoreResult?.findingsCount ?? 0,
    cost_usd: run.costUsd,
  };
}

/** Assemble a full `EvalBatchDetail` from its row + per-case outcomes. */
export function batchDetailDto(
  row: EvalBatchRow,
  cases: EvalBatchCaseOutcome[],
  excludedSkillOwnedCount: number,
): EvalBatchDetail {
  return {
    ...batchDto(row),
    cases,
    excluded_skill_owned_count: excludedSkillOwnedCount,
  };
}

/**
 * Map an `eval_batches` row to the `POST /agents/:id/evals/run` wire response
 * (snake_case wire fix): the orchestrator/service work with a camelCase
 * `batchId` internally, but the finalized `EvalRunBatchResponse` contract
 * specifies snake_case `batch_id` — this is the single translation point.
 */
export function runBatchResponseDto(row: EvalBatchRow): EvalRunBatchResponse {
  return {
    batch_id: row.id,
    kind: row.kind,
    status: row.status,
  };
}

/** Map a 'full'-kind batch row to a trend point (AC-28/29/30). */
export function trendPoint(row: EvalBatchRow): EvalTrendPointV2 {
  return {
    batch_id: row.id,
    ran_at: row.ranAt.toISOString(),
    recall: row.recall ?? 0,
    precision: row.precision ?? 0,
    citation_accuracy: row.citationAccuracy ?? 0,
    is_degraded: row.status === 'degraded',
    agent_snapshot: row.agentSnapshot,
    cost_usd: row.costUsd,
  };
}
