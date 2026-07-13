import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../../db/client.js';
import * as t from '../../../db/schema.js';
import type { AgentRunRow, FindingRow } from '../../../db/rows.js';
import type { ReviewRow } from './review.repo.js';

/**
 * Multi-agent run linkage (Multi-Agent Review) — data access for the
 * `multi_agent_runs` group row and the `agent_runs` fan-out it links,
 * plus the reviews/findings produced by those runs. Plain exported
 * functions taking `db: Db` first, following the `pull.repo.ts`/`run.repo.ts`
 * pattern — NOT wrapped in `ReviewRepository` (imported as a namespace by
 * `routes.ts` directly, same as `pullRepo`/`reviewRepo`).
 */

// ---- group lifecycle --------------------------------------------------

/** Create a new multi-agent fan-out group for a PR. Returns the new group id. */
export async function createGroup(
  db: Db,
  values: { workspaceId: string; prId: string },
): Promise<string> {
  const [row] = await db
    .insert(t.multiAgentRuns)
    .values({ workspaceId: values.workspaceId, prId: values.prId })
    .returning({ id: t.multiAgentRuns.id });
  return row!.id;
}

/**
 * The group row, workspace-scoped directly on `multi_agent_runs.workspace_id`
 * (already `.notNull()` — no join needed for the scope check itself), left-joined
 * to `pull_requests` for `pr_number` (display only — a missing PR must not hide
 * the group row).
 */
export async function getGroupScoped(
  db: Db,
  workspaceId: string,
  groupId: string,
): Promise<{ id: string; prId: string; prNumber: number | null; ranAt: Date } | undefined> {
  const [row] = await db
    .select({
      id: t.multiAgentRuns.id,
      prId: t.multiAgentRuns.prId,
      ranAt: t.multiAgentRuns.ranAt,
      prNumber: t.pullRequests.number,
    })
    .from(t.multiAgentRuns)
    .leftJoin(t.pullRequests, eq(t.multiAgentRuns.prId, t.pullRequests.id))
    .where(and(eq(t.multiAgentRuns.workspaceId, workspaceId), eq(t.multiAgentRuns.id, groupId)));
  if (!row) return undefined;
  return { id: row.id, prId: row.prId, prNumber: row.prNumber ?? null, ranAt: row.ranAt };
}

/**
 * The workspace's most recent multi-agent groups (newest first), left-joined
 * to `pull_requests` for display (`pr_number`/`pr_title`) — a missing PR must
 * not hide the group row, same rationale as `getGroupScoped`. Used for the
 * /multi-agent-review page's history list (there is otherwise no way back to
 * a group's results page once its post-start redirect is gone — see
 * client/insights.md's entry on this gap).
 */
export async function listGroupsForWorkspace(
  db: Db,
  workspaceId: string,
  limit = 20,
): Promise<{ id: string; prId: string; prNumber: number | null; prTitle: string | null; ranAt: Date }[]> {
  const rows = await db
    .select({
      id: t.multiAgentRuns.id,
      prId: t.multiAgentRuns.prId,
      ranAt: t.multiAgentRuns.ranAt,
      prNumber: t.pullRequests.number,
      prTitle: t.pullRequests.title,
    })
    .from(t.multiAgentRuns)
    .leftJoin(t.pullRequests, eq(t.multiAgentRuns.prId, t.pullRequests.id))
    .where(eq(t.multiAgentRuns.workspaceId, workspaceId))
    .orderBy(desc(t.multiAgentRuns.ranAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    prId: r.prId,
    prNumber: r.prNumber ?? null,
    prTitle: r.prTitle ?? null,
    ranAt: r.ranAt,
  }));
}

// ---- fan-out runs -------------------------------------------------------

/** All `agent_runs` rows belonging to a group, in selection order (ran_at ascending). */
export async function listAgentRunsForGroup(db: Db, groupId: string): Promise<AgentRunRow[]> {
  return db
    .select()
    .from(t.agentRuns)
    .where(eq(t.agentRuns.multiAgentRunId, groupId))
    .orderBy(asc(t.agentRuns.ranAt));
}

/** All `agent_runs` rows belonging to ANY of the given groups — one query for
 *  a whole history page's worth of groups instead of N. */
export async function listAgentRunsForGroups(db: Db, groupIds: string[]): Promise<AgentRunRow[]> {
  if (groupIds.length === 0) return [];
  return db.select().from(t.agentRuns).where(inArray(t.agentRuns.multiAgentRunId, groupIds));
}

// ---- findings + reviews for the group's runs -----------------------------

/**
 * For each of the given run ids, its `reviews` row (there is at most one
 * `review` per `run_id`) plus that review's `findings` rows — keyed by
 * `run_id`. Modeled on `review.repo.ts`'s `reviewsForPull` query shape
 * (join `reviews` → `findings`, group in memory), filtered by
 * `reviews.run_id IN (runIds)` instead of `prId`.
 */
export async function findingsAndReviewsForRuns(
  db: Db,
  runIds: string[],
): Promise<Map<string, { review: ReviewRow; findings: FindingRow[] }>> {
  const result = new Map<string, { review: ReviewRow; findings: FindingRow[] }>();
  if (runIds.length === 0) return result;

  const reviews = await db.select().from(t.reviews).where(inArray(t.reviews.runId, runIds));
  if (reviews.length === 0) return result;

  const reviewIds = reviews.map((r) => r.id);
  const findings = await db.select().from(t.findings).where(inArray(t.findings.reviewId, reviewIds));

  for (const review of reviews) {
    if (!review.runId) continue; // reviews.run_id is nullable; skip any orphaned row
    result.set(review.runId, {
      review,
      findings: findings.filter((f) => f.reviewId === review.id),
    });
  }
  return result;
}
