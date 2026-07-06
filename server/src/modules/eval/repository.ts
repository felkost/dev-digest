import { and, count, desc, eq, isNotNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';
import { ConfigError } from '../../platform/errors.js';

// Row shapes (Drizzle's inferred select/insert types for the eval tables).
type EvalCaseRow = typeof t.evalCases.$inferSelect;
type EvalCaseInsert = typeof t.evalCases.$inferInsert;
type EvalBatchRow = typeof t.evalBatches.$inferSelect;
type EvalBatchInsert = typeof t.evalBatches.$inferInsert;
type EvalRunRow = typeof t.evalRuns.$inferSelect;
type EvalRunInsert = typeof t.evalRuns.$inferInsert;

/**
 * EvalRepository — infrastructure-only DB access for eval cases, batches, and
 * runs (L06). Every method is workspace-scoped: either directly (eval_batches
 * has its own workspace_id column) or transitively (eval_runs has none of its
 * own — scope flows through eval_cases.workspace_id or eval_batches.workspace_id).
 *
 * No business rules here (e.g. "flaked" detection, degraded-status derivation)
 * — those live in the eval service.
 */
export class EvalRepository {
  constructor(private db: Db) {}

  // -------------------------------------------------------------- eval_cases

  /** Agent-owned eval cases for the given agent, workspace-scoped. */
  async listCases(workspaceId: string, agentId: string): Promise<EvalCaseRow[]> {
    return this.db
      .select()
      .from(t.evalCases)
      .where(
        and(
          eq(t.evalCases.workspaceId, workspaceId),
          eq(t.evalCases.ownerKind, 'agent'),
          eq(t.evalCases.ownerId, agentId),
        ),
      );
  }

  /** Count of skill-owned cases in the workspace (feeds the visible-exclusion count). */
  async countSkillOwnedCases(workspaceId: string): Promise<number> {
    const rows = await this.db
      .select({ cnt: count() })
      .from(t.evalCases)
      .where(and(eq(t.evalCases.workspaceId, workspaceId), eq(t.evalCases.ownerKind, 'skill')));
    return rows[0]?.cnt ?? 0;
  }

  /** A single eval case row, or null if it doesn't exist / isn't in this workspace. */
  async getCase(workspaceId: string, caseId: string): Promise<EvalCaseRow | null> {
    const rows = await this.db
      .select()
      .from(t.evalCases)
      .where(and(eq(t.evalCases.id, caseId), eq(t.evalCases.workspaceId, workspaceId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Insert a new eval case; returns the inserted row. */
  async insertCase(data: EvalCaseInsert): Promise<EvalCaseRow> {
    const [row] = await this.db.insert(t.evalCases).values(data).returning();
    if (!row) throw new ConfigError('insertCase: insert returned no row');
    return row;
  }

  /**
   * Full-replacement update of an eval case's editable fields (name, diff,
   * expectations, notes), workspace-scoped. Does NOT touch `ownerKind`/
   * `ownerId`/`inputMeta` — provenance is preserved by the caller (service
   * layer never passes those fields here). Returns the updated row, or null
   * if the case doesn't exist / isn't in this workspace.
   */
  async updateCase(
    workspaceId: string,
    caseId: string,
    data: { name: string; inputDiff: string; expectedOutput: unknown; notes: string | null },
  ): Promise<EvalCaseRow | null> {
    const rows = await this.db
      .update(t.evalCases)
      .set({
        name: data.name,
        inputDiff: data.inputDiff,
        expectedOutput: data.expectedOutput,
        notes: data.notes,
      })
      .where(and(eq(t.evalCases.id, caseId), eq(t.evalCases.workspaceId, workspaceId)))
      .returning();
    return rows[0] ?? null;
  }

  /** Delete an eval case, workspace-scoped. Returns true if a row was deleted. */
  async deleteCase(workspaceId: string, caseId: string): Promise<boolean> {
    const rows = await this.db
      .delete(t.evalCases)
      .where(and(eq(t.evalCases.id, caseId), eq(t.evalCases.workspaceId, workspaceId)))
      .returning({ id: t.evalCases.id });
    return rows.length > 0;
  }

  // --------------------------------------------------------------- eval_runs

  /**
   * Most recent eval_runs row for a case (feeds last_run_status /
   * last_run_summary). eval_runs has no workspace_id of its own; scope is
   * transitive via eval_cases — callers must have already resolved/verified
   * the case in the workspace (e.g. via `getCase(workspaceId, caseId)`)
   * before calling this, per the plan's specified signature.
   */
  async latestRunForCase(caseId: string): Promise<EvalRunRow | null> {
    const rows = await this.db
      .select()
      .from(t.evalRuns)
      .where(eq(t.evalRuns.caseId, caseId))
      .orderBy(desc(t.evalRuns.ranAt))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Raw pass/fail/error outcomes (newest first, max 3) for a case across its
   * last three FULL batches only. Feeds the service-layer "flaked" decision —
   * this method returns the raw sequence, no interpretation.
   */
  async lastThreeFullBatchOutcomesForCase(
    caseId: string,
    agentId: string,
  ): Promise<('passed' | 'failed' | 'error')[]> {
    const rows = await this.db
      .select({ pass: t.evalRuns.pass })
      .from(t.evalRuns)
      .innerJoin(t.evalBatches, eq(t.evalRuns.batchId, t.evalBatches.id))
      .where(
        and(
          eq(t.evalRuns.caseId, caseId),
          eq(t.evalBatches.agentId, agentId),
          eq(t.evalBatches.kind, 'full'),
        ),
      )
      .orderBy(desc(t.evalRuns.ranAt))
      .limit(3);

    return rows.map((r) => outcomeFromPass(r.pass));
  }

  /** Insert a new eval_runs row (includes the nullable batch_id); returns it. */
  async insertRun(data: EvalRunInsert): Promise<EvalRunRow> {
    const [row] = await this.db.insert(t.evalRuns).values(data).returning();
    if (!row) throw new ConfigError('insertRun: insert returned no row');
    return row;
  }

  /** Per-case eval_runs rows belonging to a batch (for a batch detail view). */
  async runsForBatch(batchId: string): Promise<EvalRunRow[]> {
    return this.db.select().from(t.evalRuns).where(eq(t.evalRuns.batchId, batchId));
  }

  // ------------------------------------------------------------ eval_batches

  /** Insert a new eval_batches row; returns the inserted row. */
  async insertBatch(data: EvalBatchInsert): Promise<EvalBatchRow> {
    const [row] = await this.db.insert(t.evalBatches).values(data).returning();
    if (!row) throw new ConfigError('insertBatch: insert returned no row');
    return row;
  }

  /** Update the aggregate metrics on a batch once all its case-runs complete. */
  async updateBatchAggregate(
    batchId: string,
    metrics: {
      recall: number | null;
      precision: number | null;
      citationAccuracy: number | null;
      costUsd: number | null;
      status: 'clean' | 'degraded' | null;
    },
  ): Promise<void> {
    await this.db
      .update(t.evalBatches)
      .set({
        recall: metrics.recall,
        precision: metrics.precision,
        citationAccuracy: metrics.citationAccuracy,
        costUsd: metrics.costUsd,
        status: metrics.status,
      })
      .where(eq(t.evalBatches.id, batchId));
  }

  /** All batches for an agent, newest first (AC-33). */
  async listBatchHistory(workspaceId: string, agentId: string): Promise<EvalBatchRow[]> {
    return this.db
      .select()
      .from(t.evalBatches)
      .where(and(eq(t.evalBatches.workspaceId, workspaceId), eq(t.evalBatches.agentId, agentId)))
      .orderBy(desc(t.evalBatches.ranAt));
  }

  /**
   * 'full'-kind batches only for an agent, newest first (AC-28 trend chart).
   * `status IS NOT NULL` excludes unsealed batches (#5) — a batch row is
   * inserted with `status: null` BEFORE its cases run (run-orchestrator's
   * `startBatch`), so an in-flight or crash-orphaned full batch would
   * otherwise plot as a false clean 0%/0%/0% dip. `desc(id)` is a secondary
   * sort key (N2) so two batches sharing an identical `ran_at` instant order
   * deterministically.
   */
  async listTrendBatches(workspaceId: string, agentId: string): Promise<EvalBatchRow[]> {
    return this.db
      .select()
      .from(t.evalBatches)
      .where(
        and(
          eq(t.evalBatches.workspaceId, workspaceId),
          eq(t.evalBatches.agentId, agentId),
          eq(t.evalBatches.kind, 'full'),
          isNotNull(t.evalBatches.status),
        ),
      )
      .orderBy(desc(t.evalBatches.ranAt), desc(t.evalBatches.id));
  }

  /** A single batch row, or null (AC-32). */
  async getBatch(workspaceId: string, batchId: string): Promise<EvalBatchRow | null> {
    const rows = await this.db
      .select()
      .from(t.evalBatches)
      .where(and(eq(t.evalBatches.id, batchId), eq(t.evalBatches.workspaceId, workspaceId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * The most recent 'full'-kind batch that ran strictly before `beforeRanAt`
   * (AC-31's skip-calibration delta baseline). `status IS NOT NULL` excludes
   * unsealed batches (#5) — an in-flight/crashed full batch must never be
   * used as a KPI-delta baseline. `desc(id)` is a secondary sort key (N2)
   * so a tied `ran_at` can't cause the strict `<` to skip a true predecessor
   * nondeterministically.
   */
  async previousFullBatch(
    workspaceId: string,
    agentId: string,
    beforeRanAt: Date,
  ): Promise<EvalBatchRow | null> {
    const rows = await this.db
      .select()
      .from(t.evalBatches)
      .where(
        and(
          eq(t.evalBatches.workspaceId, workspaceId),
          eq(t.evalBatches.agentId, agentId),
          eq(t.evalBatches.kind, 'full'),
          isNotNull(t.evalBatches.status),
          lt(t.evalBatches.ranAt, beforeRanAt),
        ),
      )
      .orderBy(desc(t.evalBatches.ranAt), desc(t.evalBatches.id))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * The eval case previously created from this exact finding, if any (#12 —
   * idempotency guard for `createCaseFromFinding`). `input_meta` is JSONB;
   * `->>'source_finding_id'` extracts the text value for comparison.
   */
  async findCaseBySourceFindingId(workspaceId: string, findingId: string): Promise<EvalCaseRow | null> {
    const rows = await this.db
      .select()
      .from(t.evalCases)
      .where(
        and(
          eq(t.evalCases.workspaceId, workspaceId),
          sql`${t.evalCases.inputMeta} ->> 'source_finding_id' = ${findingId}`,
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }
}

function outcomeFromPass(pass: boolean | null): 'passed' | 'failed' | 'error' {
  if (pass === null) return 'error';
  return pass ? 'passed' : 'failed';
}
