import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../../db/client.js';
import * as t from '../../../db/schema.js';
import { ConfigError } from '../../../platform/errors.js';

/** A `ci_runs` row (mirrors the Drizzle table exactly). */
export type CiRunRow = typeof t.ciRuns.$inferSelect;

/**
 * Fields observed from one GitHub Actions run (+ its parsed result artifact,
 * when present) that `upsertByGithubRunId` writes on every insert AND on
 * every conflicting update — see that method's doc comment.
 */
export interface CiRunUpsertValues {
  prNumber: number | null;
  ranAt: Date | null;
  status: string | null;
  findingsCount: number | null;
  critical: number | null;
  warning: number | null;
  suggestion: number | null;
  costUsd: number | null;
  durationS: number | null;
  githubUrl: string | null;
  repo: string | null;
  agent: string | null;
}

/** Filters accepted by `RunsRepository.list`. */
export interface CiRunsListFilters {
  agentId?: string;
  repo?: string;
  status?: string;
  sinceDays?: number;
}

/**
 * The `settings` key this repository uses to persist the workspace-scoped
 * "CI ingest last checked at" marker. Deliberately reuses the existing
 * `settings` key/value table (`server/src/db/schema/core.ts`) — no new
 * column, no new table.
 */
const CI_LAST_CHECKED_AT_KEY = 'ci_last_checked_at';

/**
 * The `settings` key marking when the workspace last CLEARED its CI run
 * history (the trash button). The ingest must NOT re-import GitHub runs older
 * than this, so a cleared history stays cleared instead of repopulating on the
 * next `checkForNewResults`. Same reused key/value `settings` table.
 */
const CI_RUNS_CLEARED_AT_KEY = 'ci_runs_cleared_at';

/**
 * RunsRepository — CI ingest reads/writes for `ci_runs`, plus the
 * workspace-scoped "last checked at" marker.
 *
 * All queries are scoped by `workspace_id` — no exceptions.
 */
export class RunsRepository {
  constructor(private db: Db) {}

  /**
   * Insert-or-update a `ci_runs` row keyed by GitHub's own run id.
   *
   * This is the ONLY write path for `ci_runs` — one GitHub Actions run always
   * maps to exactly one row, no matter how many times the ingest loop
   * observes it (e.g. once while `status: 'running'`, again once
   * `completed`). `values.durationS`/`values.agent` map straight onto the
   * `duration_s`/`agent` columns.
   */
  async upsertByGithubRunId(
    workspaceId: string,
    installationId: string,
    githubRunId: string,
    values: CiRunUpsertValues,
  ): Promise<CiRunRow> {
    const [row] = await this.db
      .insert(t.ciRuns)
      .values({
        workspaceId,
        ciInstallationId: installationId,
        githubRunId,
        prNumber: values.prNumber,
        ranAt: values.ranAt,
        status: values.status,
        findingsCount: values.findingsCount,
        critical: values.critical,
        warning: values.warning,
        suggestion: values.suggestion,
        costUsd: values.costUsd,
        durationS: values.durationS,
        githubUrl: values.githubUrl,
        repo: values.repo,
        agent: values.agent,
      })
      .onConflictDoUpdate({
        target: t.ciRuns.githubRunId,
        set: {
          prNumber: values.prNumber,
          ranAt: values.ranAt,
          status: values.status,
          findingsCount: values.findingsCount,
          critical: values.critical,
          warning: values.warning,
          suggestion: values.suggestion,
          costUsd: values.costUsd,
          durationS: values.durationS,
          githubUrl: values.githubUrl,
          repo: values.repo,
          agent: values.agent,
        },
        // Defense in depth: `github_run_id`'s unique index (schema/ci.ts) is
        // NOT scoped by workspace_id — two different workspaces' installations
        // could (rarely) track the same external repo string and observe the
        // same real GitHub run id. Without this guard, a cross-workspace
        // conflict would silently overwrite another workspace's row. With it,
        // Postgres skips the update entirely (no row returned) instead of
        // touching a row this workspace doesn't own — the caller sees a loud
        // failure (ConfigError below), never silent cross-tenant corruption.
        setWhere: eq(t.ciRuns.workspaceId, workspaceId),
      })
      .returning();

    if (!row) {
      throw new ConfigError(
        'upsertByGithubRunId: insert returned no row (githubRunId may belong to a different workspace)',
      );
    }
    return row;
  }

  /**
   * Currently-persisted `status`/`findings_count` for a batch of GitHub run
   * ids, keyed by `githubRunId` — lets the ingest check loop
   * (`IngestService.runCheckLoop`) tell whether a run it's about to observe
   * again was ALREADY fully ingested on a prior poll, so it can skip a
   * redundant artifact re-download (AC-27 budget; see
   * `ingest-service.ts`'s `resolveRunValues`). One query per installation
   * per check, not per run — `githubRunIds` is the whole batch from a single
   * `listWorkflowRuns` call.
   *
   * An empty `githubRunIds` short-circuits to an empty map without a DB
   * round-trip (defensive — `inArray` with an empty array already degrades
   * to a safe `sql\`false\`` at the drizzle-orm level, but there's no reason
   * to pay for the query at all when there's nothing to look up).
   */
  async statusesByGithubRunId(
    workspaceId: string,
    githubRunIds: string[],
  ): Promise<Map<string, { status: string | null; findingsCount: number | null }>> {
    const result = new Map<string, { status: string | null; findingsCount: number | null }>();
    if (githubRunIds.length === 0) return result;

    const rows = await this.db
      .select({
        githubRunId: t.ciRuns.githubRunId,
        status: t.ciRuns.status,
        findingsCount: t.ciRuns.findingsCount,
      })
      .from(t.ciRuns)
      .where(and(eq(t.ciRuns.workspaceId, workspaceId), inArray(t.ciRuns.githubRunId, githubRunIds)));

    for (const row of rows) {
      result.set(row.githubRunId, { status: row.status, findingsCount: row.findingsCount });
    }
    return result;
  }

  /**
   * List `ci_runs` for a workspace, optionally filtered.
   *
   * `ci_installations` is always left-joined (never inner — `ci_installation_id`
   * can be null after the parent installation's cascade-delete) so the
   * `agentId` filter can resolve through it. When `agentId` isn't requested
   * the join is simply unused — every other filter is answered directly from
   * the run's own denormalized `repo`/`status` columns. Orders by
   * `ran_at DESC NULLS LAST` (an in-flight/`running` row has no `ran_at` yet).
   */
  async list(workspaceId: string, filters: CiRunsListFilters): Promise<CiRunRow[]> {
    const conditions = [eq(t.ciRuns.workspaceId, workspaceId)];
    if (filters.repo) conditions.push(eq(t.ciRuns.repo, filters.repo));
    if (filters.status) conditions.push(eq(t.ciRuns.status, filters.status));
    if (filters.sinceDays != null) {
      conditions.push(sql`${t.ciRuns.ranAt} >= now() - make_interval(days => ${filters.sinceDays})`);
    }
    if (filters.agentId) conditions.push(eq(t.ciInstallations.agentId, filters.agentId));

    return this.db
      .select({
        id: t.ciRuns.id,
        ciInstallationId: t.ciRuns.ciInstallationId,
        prNumber: t.ciRuns.prNumber,
        prTitle: t.ciRuns.prTitle,
        ranAt: t.ciRuns.ranAt,
        status: t.ciRuns.status,
        findingsCount: t.ciRuns.findingsCount,
        costUsd: t.ciRuns.costUsd,
        githubUrl: t.ciRuns.githubUrl,
        source: t.ciRuns.source,
        workspaceId: t.ciRuns.workspaceId,
        githubRunId: t.ciRuns.githubRunId,
        repo: t.ciRuns.repo,
        agent: t.ciRuns.agent,
        durationS: t.ciRuns.durationS,
        critical: t.ciRuns.critical,
        warning: t.ciRuns.warning,
        suggestion: t.ciRuns.suggestion,
      })
      .from(t.ciRuns)
      .leftJoin(t.ciInstallations, eq(t.ciRuns.ciInstallationId, t.ciInstallations.id))
      .where(and(...conditions))
      .orderBy(sql`${t.ciRuns.ranAt} DESC NULLS LAST`);
  }

  /**
   * Delete every `ci_runs` row for a workspace — the CI Runs page "clear
   * history" (trash) action. Workspace-scoped; returns how many rows were
   * removed. Does not touch `ci_installations` (the CI deployment tab keeps
   * its repos) or the `ci_last_checked_at` marker.
   */
  async deleteAllForWorkspace(workspaceId: string): Promise<number> {
    const rows = await this.db
      .delete(t.ciRuns)
      .where(eq(t.ciRuns.workspaceId, workspaceId))
      .returning({ id: t.ciRuns.id });
    return rows.length;
  }

  /** The workspace's last successful `checkForNewResults` completion time, or `null` if it never ran. */
  async getLastCheckedAt(workspaceId: string): Promise<Date | null> {
    return this.getTimestampSetting(workspaceId, CI_LAST_CHECKED_AT_KEY);
  }

  /** Record `at` as the workspace's last `checkForNewResults` completion time. */
  async setLastCheckedAt(workspaceId: string, at: Date): Promise<void> {
    return this.setTimestampSetting(workspaceId, CI_LAST_CHECKED_AT_KEY, at);
  }

  /** When the workspace last cleared its CI run history, or `null` if never. */
  async getClearedAt(workspaceId: string): Promise<Date | null> {
    return this.getTimestampSetting(workspaceId, CI_RUNS_CLEARED_AT_KEY);
  }

  /** Record `at` as the workspace's "CI history cleared at" marker. */
  async setClearedAt(workspaceId: string, at: Date): Promise<void> {
    return this.setTimestampSetting(workspaceId, CI_RUNS_CLEARED_AT_KEY, at);
  }

  /** Read a workspace-level (`user_id IS NULL`) ISO-timestamp `settings` value, or `null`. */
  private async getTimestampSetting(workspaceId: string, key: string): Promise<Date | null> {
    const rows = await this.db
      .select({ value: t.settings.value })
      .from(t.settings)
      .where(and(eq(t.settings.workspaceId, workspaceId), isNull(t.settings.userId), eq(t.settings.key, key)))
      .limit(1);

    const value = rows[0]?.value;
    if (typeof value !== 'string') return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  /**
   * Upsert a workspace-level (`user_id IS NULL`) ISO-timestamp `settings` value.
   *
   * Implemented as an explicit read-then-write, NOT `onConflictDoUpdate`,
   * even though `settings_ws_user_key_uq` covers exactly
   * `(workspace_id, user_id, key)`. Reason: these keys are workspace-level
   * (`user_id IS NULL` by design), and Postgres unique indexes treat NULL as
   * distinct from NULL — an `ON CONFLICT (workspace_id, user_id, key)`
   * arbiter can never detect a conflict against an existing NULL-`user_id`
   * row, so it would silently INSERT a new row on every call instead of
   * updating the one row (a well-known Postgres NULL-uniqueness gotcha, not
   * a hypothetical). Read-then-write sidesteps it entirely while keeping the
   * exact same "one settings row per workspace for this key" behavior — no
   * schema change needed.
   *
   * Not perfectly race-free under concurrent calls for the same workspace
   * (a rare double-insert would just leave one harmless extra settings row) —
   * acceptable given these are only ever driven by rate-limited, low-concurrency
   * endpoints.
   */
  private async setTimestampSetting(workspaceId: string, key: string, at: Date): Promise<void> {
    const value = at.toISOString();
    const existing = await this.db
      .select({ id: t.settings.id })
      .from(t.settings)
      .where(and(eq(t.settings.workspaceId, workspaceId), isNull(t.settings.userId), eq(t.settings.key, key)))
      .limit(1);

    const existingId = existing[0]?.id;
    if (existingId) {
      await this.db.update(t.settings).set({ value }).where(eq(t.settings.id, existingId));
    } else {
      await this.db.insert(t.settings).values({ workspaceId, userId: null, key, value });
    }
  }
}
