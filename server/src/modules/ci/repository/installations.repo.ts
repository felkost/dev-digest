import { and, eq, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../../../db/client.js';
import * as t from '../../../db/schema.js';
import { AppError } from '../../../platform/errors.js';
import type { CiTarget } from '@devdigest/shared';

/**
 * `ci_installations` row shape, inferred straight from the Drizzle table.
 * Not centralized in `db/rows.ts` (outside this step's owned paths) —
 * exported here instead, the same way every repository in this codebase
 * re-exports its row type for cross-cutting consumers to import.
 */
export type CiInstallationRow = typeof t.ciInstallations.$inferSelect;

export interface UpsertPublishedValues {
  agentId: string;
  repo: string;
  targetType: CiTarget;
  /**
   * Configuration-file identity for this installation. `upsertPublished`
   * always writes this value verbatim on conflict — it does NOT decide
   * itself whether to keep it frozen. The CALLER (`export-service.ts`'s
   * `resolveInstallationTarget`) is responsible for passing the EXISTING
   * (frozen) slug for a same-agent re-export/reconnect, and a FRESH slug only
   * when a different agent is taking over a previously-disconnected slot —
   * see `upsertPublished`'s doc comment.
   */
  slug: string;
  triggers: string[];
  postAs: 'github_review' | 'pr_comment' | 'none';
  workflowContents: string;
}

/**
 * `InstallationsRepository` — dumb data access for `ci_installations`.
 *
 * Every query is scoped by `workspace_id` (backend-onion-architecture R1 /
 * AP-3 — no exceptions). Business rules (one-agent-per-repo conflict
 * detection; whether a found row's `agent_id` matches the caller's requested
 * agent) belong in the SERVICE layer (a later step, `export-service.ts`) —
 * never here. These methods only read and write rows exactly as instructed
 * by their caller; they do not themselves enforce any business rule.
 */
export class InstallationsRepository {
  constructor(private db: Db) {}

  /**
   * The one-agent-per-repo lookup: is there ALREADY an installation for this
   * `(workspace, repo)`, regardless of which agent it belongs to? Returns
   * the row unconditionally — the caller decides whether `row.agentId`
   * matching the requested agent means "reuse" or "conflict".
   */
  async findByRepo(workspaceId: string, repo: string): Promise<CiInstallationRow | undefined> {
    const rows = await this.db
      .select()
      .from(t.ciInstallations)
      .where(and(eq(t.ciInstallations.workspaceId, workspaceId), eq(t.ciInstallations.repo, repo)))
      .limit(1);
    return rows[0];
  }

  /**
   * All installations for one agent (includes disconnected ones — the
   * caller filters as needed). One agent can have many installations across
   * many *different* repos (only one repo per installation).
   */
  async listByAgent(workspaceId: string, agentId: string): Promise<CiInstallationRow[]> {
    return this.db
      .select()
      .from(t.ciInstallations)
      .where(and(eq(t.ciInstallations.workspaceId, workspaceId), eq(t.ciInstallations.agentId, agentId)));
  }

  /** Non-disconnected installations for a workspace — used by ingest's check loop. */
  async listTracked(workspaceId: string): Promise<CiInstallationRow[]> {
    return this.db
      .select()
      .from(t.ciInstallations)
      .where(
        and(eq(t.ciInstallations.workspaceId, workspaceId), isNull(t.ciInstallations.disconnectedAt)),
      );
  }

  /**
   * Insert-or-update the single installation row for `(workspaceId, repo)`.
   *
   * `slug` IS included in the `DO UPDATE SET` list below — this method
   * always writes whatever `values.slug` the caller passes. The "frozen
   * across a same-agent rename" invariant is no longer enforced by omission
   * here; it's enforced by `export-service.ts`'s `resolveInstallationTarget`
   * always COMPUTING the correct value (the existing row's own slug for a
   * same-agent re-export/reconnect, a fresh one only for a different-agent
   * takeover of a disconnected slot) before calling this method. `id`,
   * `target_type`, and `installed_at` are still never overwritten on
   * conflict — only the seven columns listed in `set` below ever change on
   * an existing row.
   *
   * `disconnected_at` is unconditionally cleared to `null` on every
   * successful call — `upsertPublished` is invoked ONLY to represent a
   * successful publish (fresh export, re-export, or takeover), so by
   * definition any row it touches is no longer disconnected. This is a
   * no-op for a row that was never disconnected (already `null`) and
   * correctly un-disconnects a previously disconnected one on reconnect —
   * `listTracked()` and `active_count` (`getAgentCiSurface`) depend on this
   * to treat a reconnected installation as active again immediately.
   *
   * This is the ONLY place `workflow_version` increments, and only on a call
   * that represents a successful publish.
   *
   * **`setWhere` — the DB-level one-agent-per-repo guard (closes a TOCTOU
   * race).** The service layer (`resolveInstallationTarget`) reads
   * "is there a conflicting row?" and only later calls this method to write
   * — two near-simultaneous calls for the same repo but different agents can
   * both pass that read-time check before either write lands. `setWhere`
   * makes the SAME guard atomic at the DB level, in the same statement as
   * the write: the conflict-path UPDATE is allowed only when EITHER (a) the
   * EXISTING row already belongs to `values.agentId` (same-agent re-export/
   * reconnect — always allowed, whatever `disconnected_at` currently is), OR
   * (b) the EXISTING row is currently disconnected (a fully free slot — any
   * agent may claim it, per the confirmed product decision that disconnect
   * is not a permanent lock). It blocks only the genuine hijack case: a
   * DIFFERENT agent trying to overwrite an ACTIVE installation. When blocked,
   * Postgres skips the update entirely and `RETURNING` yields no row — see
   * the empty-`rows` handling below, which is a SECOND, real enforcement
   * point (not just documentation trusting the caller), since the race this
   * guards against can only be closed at the DB level.
   */
  async upsertPublished(
    workspaceId: string,
    id: string,
    values: UpsertPublishedValues,
  ): Promise<CiInstallationRow> {
    const rows = await this.db
      .insert(t.ciInstallations)
      .values({
        id,
        workspaceId,
        agentId: values.agentId,
        repo: values.repo,
        targetType: values.targetType,
        slug: values.slug,
        triggers: values.triggers,
        postAs: values.postAs,
        workflowContents: values.workflowContents,
      })
      .onConflictDoUpdate({
        target: [t.ciInstallations.workspaceId, t.ciInstallations.repo],
        set: {
          agentId: values.agentId,
          slug: values.slug,
          triggers: values.triggers,
          postAs: values.postAs,
          workflowContents: values.workflowContents,
          workflowVersion: sql`${t.ciInstallations.workflowVersion} + 1`,
          disconnectedAt: null,
        },
        setWhere: or(
          eq(t.ciInstallations.agentId, values.agentId),
          isNotNull(t.ciInstallations.disconnectedAt),
        ),
      })
      .returning();

    const row = rows[0];
    if (!row) {
      // `setWhere` blocked the conflict-path update: a DIFFERENT agent tried
      // to overwrite an ACTIVE installation for this repo (the race-loser
      // case, or a caller that skipped the service-layer check entirely).
      throw new AppError(
        'repo_already_installed',
        `${values.repo} already has DevDigest installed for a different agent. ` +
          'Disconnect it from this repository first, or choose another repository.',
        409,
      );
    }
    return row;
  }

  /**
   * Fully removes an installation — a hard delete, not a soft "mark
   * disconnected". Confirmed product decision (2026-07-11): disconnecting a
   * repo must be a clean removal so that re-adding it starts from a blank
   * status, never resurrecting the reused row's pre-disconnect run history
   * (the "Failed 7h ago on a just-added repo" bug).
   *
   * Any `ci_runs` attached to this installation are NOT deleted: the FK
   * `ci_runs.ci_installation_id` is `ON DELETE SET NULL` (schema/ci.ts), so
   * they detach and remain visible on the cross-agent CI Runs page through
   * their own denormalized `repo`/`agent` snapshot columns (`runs.repo.ts`
   * `list` already left-joins installations precisely because
   * `ci_installation_id` can be null after this delete). Re-adding the same
   * repo is therefore a fresh INSERT in `upsertPublished` (its `findByRepo`
   * lookup now finds nothing), with a new id and a clean run history.
   *
   * The `disconnected_at` column and the soft-disconnect branches that read it
   * (`listTracked`, `upsertPublished`'s `setWhere`, `resolveInstallationTarget`)
   * are intentionally left in place: they still correctly tolerate any legacy
   * soft-disconnected rows written before this change.
   */
  async disconnect(workspaceId: string, id: string): Promise<CiInstallationRow | undefined> {
    const rows = await this.db
      .delete(t.ciInstallations)
      .where(and(eq(t.ciInstallations.id, id), eq(t.ciInstallations.workspaceId, workspaceId)))
      .returning();
    return rows[0];
  }

  async getById(workspaceId: string, id: string): Promise<CiInstallationRow | undefined> {
    const rows = await this.db
      .select()
      .from(t.ciInstallations)
      .where(and(eq(t.ciInstallations.workspaceId, workspaceId), eq(t.ciInstallations.id, id)))
      .limit(1);
    return rows[0];
  }
}
