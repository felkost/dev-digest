import { and, count, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../../../db/client.js';
import * as t from '../../../db/schema.js';
import type { RunSummary, RunTrace } from '@devdigest/shared';

// ---- in-flight / history --------------------------------------------------

/** In-flight runs for a PR (status='running') — the server-side source of
 *  truth for "which agents are running now". Joined with the agent name. */
export async function activeRunsForPull(
  db: Db,
  workspaceId: string,
  prId: string,
): Promise<{ run_id: string; agent_id: string | null; agent_name: string | null; ran_at: string | null }[]> {
  const rows = await db
    .select({
      id: t.agentRuns.id,
      agentId: t.agentRuns.agentId,
      ranAt: t.agentRuns.ranAt,
      agentName: t.agents.name,
    })
    .from(t.agentRuns)
    .leftJoin(t.agents, eq(t.agents.id, t.agentRuns.agentId))
    .where(
      and(
        eq(t.agentRuns.workspaceId, workspaceId),
        eq(t.agentRuns.prId, prId),
        eq(t.agentRuns.status, 'running'),
      ),
    );
  return rows.map((r) => ({
    run_id: r.id,
    agent_id: r.agentId,
    agent_name: r.agentName ?? null,
    ran_at: r.ranAt ? r.ranAt.toISOString() : null,
  }));
}

/** All SINGLE-AGENT runs for a PR (any status), newest first — the PR run
 *  history shown on the PR-detail "Agent runs" tab. Multi-agent fan-out runs
 *  are EXCLUDED: they belong to a `multi_agent_runs` group and are viewed on
 *  the dedicated /multi-agent-review page (queried via
 *  multi-run.repo `listAgentRunsForGroup`). Including them here would let a
 *  fan-out run displace the newest single-agent run in the default-open
 *  accordion and render its members ungrouped as loose runs. */
export async function listRunsForPull(
  db: Db,
  workspaceId: string,
  prId: string,
): Promise<RunSummary[]> {
  const rows = await db
    .select({ run: t.agentRuns, agentName: t.agents.name })
    .from(t.agentRuns)
    .leftJoin(t.agents, eq(t.agents.id, t.agentRuns.agentId))
    .where(
      and(
        eq(t.agentRuns.workspaceId, workspaceId),
        eq(t.agentRuns.prId, prId),
        isNull(t.agentRuns.multiAgentRunId),
      ),
    )
    .orderBy(desc(t.agentRuns.ranAt));

  // Per-severity counts per run: JOIN findings via reviews.run_id.
  // Severity is stored UPPERCASE in the DB ('CRITICAL'/'WARNING'/'SUGGESTION').
  const runIds = rows.map((r) => r.run.id);
  const breakdownByRun = new Map<string, { critical: number; warning: number; suggestion: number }>();
  if (runIds.length > 0) {
    const countRows = await db
      .select({
        runId: t.reviews.runId,
        severity: t.findings.severity,
        cnt: count(),
      })
      .from(t.findings)
      .innerJoin(t.reviews, eq(t.findings.reviewId, t.reviews.id))
      .where(and(inArray(t.reviews.runId, runIds), isNull(t.findings.dismissedAt)))
      .groupBy(t.reviews.runId, t.findings.severity);
    for (const row of countRows) {
      if (!row.runId) continue;
      const bd = breakdownByRun.get(row.runId) ?? { critical: 0, warning: 0, suggestion: 0 };
      if (row.severity === 'CRITICAL') bd.critical = row.cnt;
      else if (row.severity === 'WARNING') bd.warning = row.cnt;
      else if (row.severity === 'SUGGESTION') bd.suggestion = row.cnt;
      breakdownByRun.set(row.runId, bd);
    }
  }

  return rows.map(({ run, agentName }) => ({
    run_id: run.id,
    agent_id: run.agentId,
    agent_name: agentName ?? null,
    provider: run.provider,
    model: run.model,
    status: run.status,
    error: run.error,
    duration_ms: run.durationMs,
    tokens_in: run.tokensIn,
    tokens_out: run.tokensOut,
    findings_count: run.findingsCount,
    grounding: run.grounding,
    ran_at: run.ranAt ? run.ranAt.toISOString() : null,
    score: run.score,
    blockers: run.blockers,
    cost_usd: run.costUsd ?? null,
    findings_breakdown: breakdownByRun.get(run.id) ?? null,
  }));
}

/**
 * Delete one agent run (+ its trace via FK cascade) AND the review it produced.
 * Workspace-scoped. `reviews.run_id` has no FK to `agent_runs`, so the review
 * (and its findings, which DO cascade from `reviews`) must be removed explicitly
 * here — otherwise deleting a run from the timeline leaves its findings orphaned
 * in the Review Runs list below.
 */
export async function deleteAgentRun(
  db: Db,
  workspaceId: string,
  runId: string,
): Promise<boolean> {
  await db
    .delete(t.reviews)
    .where(and(eq(t.reviews.runId, runId), eq(t.reviews.workspaceId, workspaceId)));
  const rows = await db
    .delete(t.agentRuns)
    .where(and(eq(t.agentRuns.id, runId), eq(t.agentRuns.workspaceId, workspaceId)))
    .returning({ id: t.agentRuns.id });
  return rows.length > 0;
}

/** Mark a still-running run as cancelled (no-op if it already finished). */
export async function cancelRunIfRunning(db: Db, runId: string): Promise<boolean> {
  const rows = await db
    .update(t.agentRuns)
    .set({ status: 'cancelled' })
    .where(and(eq(t.agentRuns.id, runId), eq(t.agentRuns.status, 'running')))
    .returning({ id: t.agentRuns.id });
  return rows.length > 0;
}

/** On boot: any run still 'running' is orphaned (its process died / restarted),
 *  so mark it failed. Prevents permanently stuck "running" runs in the UI. */
export async function reapStaleRunningRuns(db: Db): Promise<number> {
  const rows = await db
    .update(t.agentRuns)
    .set({ status: 'failed' })
    .where(eq(t.agentRuns.status, 'running'))
    .returning({ id: t.agentRuns.id });
  return rows.length;
}

// ---- observability: agent_runs + run_traces -------------------------------

/** Create an agent_runs row in `running` state; returns its id (= the runId). */
export async function createAgentRun(
  db: Db,
  values: {
    workspaceId: string;
    agentId: string | null;
    prId: string;
    provider: string | null;
    model: string | null;
    /** Links this run to a multi-agent fan-out group (Multi-Agent Review). */
    multiAgentRunId?: string | null;
  },
): Promise<string> {
  const [row] = await db
    .insert(t.agentRuns)
    .values({
      workspaceId: values.workspaceId,
      agentId: values.agentId,
      prId: values.prId,
      provider: values.provider,
      model: values.model,
      status: 'running',
      source: 'local',
      multiAgentRunId: values.multiAgentRunId ?? null,
    })
    .returning({ id: t.agentRuns.id });
  return row!.id;
}

/**
 * The last `limit` successful ('done') runs of one agent against one repo's
 * PRs — the sample `MultiRunService.estimatesForPr` averages over (Multi-Agent
 * Review, AC-7). Joined to `pull_requests` on `pr_id` only to filter by
 * `repoId` (a run's own `agent_runs` row has no direct `repo_id` column).
 */
export async function lastSuccessfulRuns(
  db: Db,
  params: { workspaceId: string; agentId: string; repoId: string; limit: number },
): Promise<{ durationMs: number; costUsd: number | null }[]> {
  const rows = await db
    .select({ durationMs: t.agentRuns.durationMs, costUsd: t.agentRuns.costUsd })
    .from(t.agentRuns)
    .innerJoin(t.pullRequests, eq(t.agentRuns.prId, t.pullRequests.id))
    .where(
      and(
        eq(t.agentRuns.workspaceId, params.workspaceId),
        eq(t.agentRuns.agentId, params.agentId),
        eq(t.pullRequests.repoId, params.repoId),
        eq(t.agentRuns.status, 'done'),
      ),
    )
    .orderBy(desc(t.agentRuns.ranAt))
    .limit(params.limit);
  return rows.map((r) => ({ durationMs: r.durationMs ?? 0, costUsd: r.costUsd ?? null }));
}

export async function completeAgentRun(
  db: Db,
  runId: string,
  values: {
    status: 'done' | 'failed' | 'cancelled';
    durationMs: number;
    findingsCount: number;
    grounding: string;
    /** Review score (0-100); null on failed/cancelled runs. */
    score?: number | null;
    /** Findings that tripped the agent's gate; 0 on failed/cancelled runs. */
    blockers?: number | null;
    /** Failure reason (status='failed') / cancellation note. Null clears it. */
    error?: string | null;
    /** USD cost from the provider (or estimated). Null = unknown. Omit to
     *  leave the column unchanged. */
    costUsd?: number | null;
    /** Input/output token counts. Null = genuinely unknown (LLM never
     *  returned). Omit to leave the column unchanged — same contract as
     *  costUsd (AC-33: tokens follow the identical null-semantics). */
    tokensIn?: number | null;
    tokensOut?: number | null;
  },
): Promise<void> {
  await db
    .update(t.agentRuns)
    .set({
      status: values.status,
      durationMs: values.durationMs,
      findingsCount: values.findingsCount,
      grounding: values.grounding,
      score: values.score ?? null,
      blockers: values.blockers ?? null,
      error: values.error ?? null,
      // Only write these columns when the caller explicitly provides them
      // (even as null). Omitting a field leaves the column unchanged,
      // preventing a second completeAgentRun call (retry / catch path) from
      // overwriting real data already persisted by the success path.
      ...(values.costUsd !== undefined ? { costUsd: values.costUsd } : {}),
      ...(values.tokensIn !== undefined ? { tokensIn: values.tokensIn } : {}),
      ...(values.tokensOut !== undefined ? { tokensOut: values.tokensOut } : {}),
    })
    .where(eq(t.agentRuns.id, runId));
}

/** Persist the WHOLE run log as ONE document. PK = runId → agent_runs. */
export async function saveRunTrace(db: Db, runId: string, trace: RunTrace): Promise<void> {
  await db
    .insert(t.runTraces)
    .values({ runId, trace })
    .onConflictDoUpdate({ target: t.runTraces.runId, set: { trace } });
}

export async function getRunTrace(db: Db, runId: string): Promise<RunTrace | undefined> {
  const [row] = await db.select().from(t.runTraces).where(eq(t.runTraces.runId, runId));
  return row ? (row.trace as RunTrace) : undefined;
}
