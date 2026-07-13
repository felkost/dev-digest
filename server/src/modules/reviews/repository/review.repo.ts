import { and, desc, eq, getTableColumns, inArray, isNull, notInArray, or } from 'drizzle-orm';
import type { Db } from '../../../db/client.js';
import * as t from '../../../db/schema.js';
import type { Finding } from '@devdigest/shared';
import type { FindingRow, PullRow } from '../../../db/rows.js';
import { fanOutGroupIds } from './run.repo.js';

export type ReviewRow = typeof t.reviews.$inferSelect;

// ---- reviews + findings ---------------------------------------------------

export async function insertReview(
  db: Db,
  values: {
    workspaceId: string;
    prId: string;
    agentId: string | null;
    runId: string | null;
    kind: 'summary' | 'review';
    verdict: string | null;
    summary: string | null;
    score: number | null;
    model: string | null;
  },
): Promise<ReviewRow> {
  const [row] = await db.insert(t.reviews).values(values).returning();
  return row!;
}

export async function insertFindings(
  db: Db,
  reviewId: string,
  findings: Finding[],
): Promise<FindingRow[]> {
  if (findings.length === 0) return [];
  const rows = await db
    .insert(t.findings)
    .values(
      findings.map((f) => ({
        reviewId,
        file: f.file,
        startLine: f.start_line,
        endLine: f.end_line,
        severity: f.severity,
        category: f.category,
        title: f.title,
        rationale: f.rationale,
        suggestion: f.suggestion ?? null,
        confidence: f.confidence,
        kind: f.kind ?? 'finding',
        trifectaComponents: f.trifecta_components ?? null,
      })),
    )
    .returning();
  return rows;
}

/** Reviews for a PR (newest first), each with its findings.
 *  EXCLUDES reviews produced by a TRUE multi-agent fan-out run (a
 *  `multi_agent_runs` group with more than one member — see
 *  `run.repo.ts`'s `fanOutGroupIds`): those belong on the dedicated
 *  /multi-agent-review page, not the PR-detail "Review runs" list (whose
 *  first/newest accordion opens by default and would otherwise be displaced).
 *  The LEFT JOIN keeps standalone reviews (`run_id IS NULL`), single-agent
 *  reviews (`multi_agent_run_id IS NULL`), AND one-member-group reviews (the
 *  `MultiAgentPicker`'s "exactly one agent" mode — no accordion conflict since
 *  there's nothing to fan out); only true multi-member-group reviews drop. */
export async function reviewsForPull(
  db: Db,
  prId: string,
): Promise<{ review: ReviewRow; findings: FindingRow[] }[]> {
  const fanOutIds = await fanOutGroupIds(db, prId);
  const reviews = await db
    .select(getTableColumns(t.reviews))
    .from(t.reviews)
    .leftJoin(t.agentRuns, eq(t.agentRuns.id, t.reviews.runId))
    .where(
      and(
        eq(t.reviews.prId, prId),
        fanOutIds.length > 0
          ? or(isNull(t.agentRuns.multiAgentRunId), notInArray(t.agentRuns.multiAgentRunId, fanOutIds))
          : undefined,
      ),
    )
    .orderBy(desc(t.reviews.createdAt));
  if (reviews.length === 0) return [];
  const ids = reviews.map((r) => r.id);
  const findings = await db.select().from(t.findings).where(inArray(t.findings.reviewId, ids));
  return reviews.map((review) => ({
    review,
    findings: findings.filter((f) => f.reviewId === review.id),
  }));
}

export async function getReview(db: Db, reviewId: string): Promise<ReviewRow | undefined> {
  const [row] = await db.select().from(t.reviews).where(eq(t.reviews.id, reviewId));
  return row;
}

export async function findingsForReview(
  db: Db,
  reviewId: string,
  workspaceId: string,
): Promise<FindingRow[]> {
  // Inner join with reviews (which carries workspaceId) scopes the query to the
  // caller's workspace — prevents cross-workspace data leak if the call site changes.
  const rows = await db
    .select({
      id: t.findings.id,
      reviewId: t.findings.reviewId,
      file: t.findings.file,
      startLine: t.findings.startLine,
      endLine: t.findings.endLine,
      severity: t.findings.severity,
      category: t.findings.category,
      title: t.findings.title,
      rationale: t.findings.rationale,
      suggestion: t.findings.suggestion,
      confidence: t.findings.confidence,
      kind: t.findings.kind,
      trifectaComponents: t.findings.trifectaComponents,
      acceptedAt: t.findings.acceptedAt,
      dismissedAt: t.findings.dismissedAt,
    })
    .from(t.findings)
    .innerJoin(t.reviews, eq(t.findings.reviewId, t.reviews.id))
    .where(and(eq(t.findings.reviewId, reviewId), eq(t.reviews.workspaceId, workspaceId)));
  return rows as FindingRow[];
}

/** Delete a whole review (one agent's run) + its findings (cascade), scoped
 *  to the workspace. Returns false if not found in the workspace. */
export async function deleteReview(
  db: Db,
  workspaceId: string,
  reviewId: string,
): Promise<boolean> {
  const rows = await db
    .delete(t.reviews)
    .where(and(eq(t.reviews.workspaceId, workspaceId), eq(t.reviews.id, reviewId)))
    .returning({ id: t.reviews.id });
  return rows.length > 0;
}

// ---- finding actions ------------------------------------------------------

export async function getFinding(db: Db, findingId: string): Promise<FindingRow | undefined> {
  const [row] = await db.select().from(t.findings).where(eq(t.findings.id, findingId));
  return row;
}

/** Resolve workspace_id + pr_id for a finding (via review → pr). */
export async function findingContext(
  db: Db,
  findingId: string,
): Promise<{ finding: FindingRow; review: ReviewRow; pull: PullRow } | undefined> {
  const finding = await getFinding(db, findingId);
  if (!finding) return undefined;
  const review = await getReview(db, finding.reviewId);
  if (!review) return undefined;
  const [pull] = await db
    .select()
    .from(t.pullRequests)
    .where(eq(t.pullRequests.id, review.prId));
  if (!pull) return undefined;
  return { finding, review, pull };
}

export async function setFindingAccepted(
  db: Db,
  findingId: string,
  at: Date | null,
): Promise<FindingRow | undefined> {
  const [row] = await db
    .update(t.findings)
    .set({ acceptedAt: at, dismissedAt: null })
    .where(eq(t.findings.id, findingId))
    .returning();
  return row;
}

export async function setFindingDismissed(
  db: Db,
  findingId: string,
  at: Date | null,
): Promise<FindingRow | undefined> {
  const [row] = await db
    .update(t.findings)
    .set({ dismissedAt: at, acceptedAt: null })
    .where(eq(t.findings.id, findingId))
    .returning();
  return row;
}
