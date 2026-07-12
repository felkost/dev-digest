import { and, asc, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';
import type {
  AgentRankedUsageRow,
  AgentRunHistoryRow,
  CiFailOn,
  Provider,
  ReviewStrategy,
} from '@devdigest/shared';
import { DEFAULT_AGENT_DESCRIPTION, INITIAL_AGENT_VERSION } from './constants.js';
import { isConfigChange } from './helpers.js';

/**
 * A2 — agents data-access. Owns `agents`, `agent_versions`, and the
 * `agent_skills` link table (shared with A1's skills repository, but A2 owns the
 * agent side: link/reorder/list for an agent). Workspace-scoped throughout.
 */

import type { AgentRow, AgentVersionRow } from '../../db/rows.js';
export type { AgentRow, AgentVersionRow };

export interface InsertAgent {
  workspaceId: string;
  name: string;
  description?: string;
  provider: Provider;
  model: string;
  systemPrompt: string;
  outputSchema?: unknown;
  strategy?: ReviewStrategy;
  ciFailOn?: CiFailOn;
  repoIntel?: boolean;
  enabled?: boolean;
  createdBy?: string | null;
}

export interface UpdateAgent {
  name?: string;
  description?: string;
  provider?: Provider;
  model?: string;
  systemPrompt?: string;
  outputSchema?: unknown;
  strategy?: ReviewStrategy;
  ciFailOn?: CiFailOn;
  repoIntel?: boolean;
  enabled?: boolean;
}

/** A skill linked to an agent (with its order), joined from agent_skills. */
export interface LinkedSkillRow {
  skill: typeof t.skills.$inferSelect;
  order: number;
}

export class AgentsRepository {
  constructor(private db: Db) {}

  async list(workspaceId: string): Promise<AgentRow[]> {
    return this.db.select().from(t.agents).where(eq(t.agents.workspaceId, workspaceId));
  }

  async listEnabled(workspaceId: string): Promise<AgentRow[]> {
    return this.db
      .select()
      .from(t.agents)
      .where(and(eq(t.agents.workspaceId, workspaceId), eq(t.agents.enabled, true)));
  }

  async getById(workspaceId: string, id: string): Promise<AgentRow | undefined> {
    const [row] = await this.db
      .select()
      .from(t.agents)
      .where(and(eq(t.agents.workspaceId, workspaceId), eq(t.agents.id, id)));
    return row;
  }

  /** Delete an agent (scoped to workspace). Versions/skill-links cascade;
   *  agent_runs keep their history with agent_id set null. Returns false if
   *  no such agent existed in the workspace. */
  async deleteById(workspaceId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(t.agents)
      .where(and(eq(t.agents.workspaceId, workspaceId), eq(t.agents.id, id)))
      .returning({ id: t.agents.id });
    return rows.length > 0;
  }

  /** Insert an agent AND record version 1 in agent_versions (immutable snapshot). */
  async insert(values: InsertAgent): Promise<AgentRow> {
    const [row] = await this.db
      .insert(t.agents)
      .values({
        workspaceId: values.workspaceId,
        name: values.name,
        description: values.description ?? DEFAULT_AGENT_DESCRIPTION,
        provider: values.provider,
        model: values.model,
        systemPrompt: values.systemPrompt,
        outputSchema: (values.outputSchema as object | undefined) ?? null,
        ...(values.strategy !== undefined ? { strategy: values.strategy } : {}),
        ...(values.ciFailOn !== undefined ? { ciFailOn: values.ciFailOn } : {}),
        ...(values.repoIntel !== undefined ? { repoIntel: values.repoIntel } : {}),
        enabled: values.enabled ?? true,
        version: INITIAL_AGENT_VERSION,
        createdBy: values.createdBy ?? null,
      })
      .returning();
    await this.snapshotVersion(row!, INITIAL_AGENT_VERSION);
    return row!;
  }

  /**
   * Update an agent. Any config change bumps the version and snapshots the new
   * config into agent_versions (reproducibility for eval). The optional
   * `promote` argument marks the resulting version snapshot's provenance
   * (Agent Eval Dashboard promote-from-batch flow); omitted for every ordinary
   * caller (agent creation, normal config edits), which defaults to 'manual'.
   */
  async update(
    workspaceId: string,
    id: string,
    patch: UpdateAgent,
    promote?: { sourceBatchId: string },
  ): Promise<AgentRow | undefined> {
    const existing = await this.getById(workspaceId, id);
    if (!existing) return undefined;

    // A config-affecting change (anything except just toggling enabled) bumps version.
    const configChanged = isConfigChange(existing, patch);
    const nextVersion = configChanged ? existing.version + 1 : existing.version;

    const [row] = await this.db
      .update(t.agents)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.provider !== undefined ? { provider: patch.provider } : {}),
        ...(patch.model !== undefined ? { model: patch.model } : {}),
        ...(patch.systemPrompt !== undefined ? { systemPrompt: patch.systemPrompt } : {}),
        ...(patch.outputSchema !== undefined
          ? { outputSchema: patch.outputSchema as object }
          : {}),
        ...(patch.strategy !== undefined ? { strategy: patch.strategy } : {}),
        ...(patch.ciFailOn !== undefined ? { ciFailOn: patch.ciFailOn } : {}),
        ...(patch.repoIntel !== undefined ? { repoIntel: patch.repoIntel } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(configChanged ? { version: nextVersion } : {}),
      })
      .where(and(eq(t.agents.workspaceId, workspaceId), eq(t.agents.id, id)))
      .returning();

    if (configChanged && row) {
      await this.snapshotVersion(
        row,
        nextVersion,
        promote ? { source: 'eval_promote', sourceBatchId: promote.sourceBatchId } : undefined,
      );
    }
    return row;
  }

  private async snapshotVersion(
    row: AgentRow,
    version: number,
    provenance?: { source: 'eval_promote'; sourceBatchId: string },
  ): Promise<void> {
    const skills = await this.skillIdsForAgent(row.id);
    await this.db
      .insert(t.agentVersions)
      .values({
        agentId: row.id,
        version,
        configJson: {
          provider: row.provider,
          model: row.model,
          system_prompt: row.systemPrompt,
          output_schema: row.outputSchema,
          strategy: row.strategy,
          ci_fail_on: row.ciFailOn,
          repo_intel: row.repoIntel,
          skills,
        },
        source: provenance?.source ?? 'manual',
        sourceBatchId: provenance?.sourceBatchId ?? null,
      })
      .onConflictDoNothing();
  }

  /**
   * Promote an eval batch's frozen system-prompt snapshot onto this agent
   * (Agent Eval Dashboard). A system-prompt change always qualifies as a
   * config change (`isConfigChange`), so this reuses the existing `update()`
   * version-bump/snapshot path unchanged — only the version row's provenance
   * differs (`source: 'eval_promote'`, `source_batch_id: sourceBatchId`).
   */
  async promoteSystemPrompt(
    workspaceId: string,
    agentId: string,
    newSystemPrompt: string,
    sourceBatchId: string,
  ): Promise<AgentRow | undefined> {
    return this.update(workspaceId, agentId, { systemPrompt: newSystemPrompt }, { sourceBatchId });
  }

  // ---- agent_versions (immutable config snapshots) ------------------------

  /** All config snapshots for an agent, newest version first. */
  async listVersions(agentId: string): Promise<AgentVersionRow[]> {
    return this.db
      .select()
      .from(t.agentVersions)
      .where(eq(t.agentVersions.agentId, agentId))
      .orderBy(desc(t.agentVersions.version));
  }

  /** A single config snapshot, or undefined if that version was never recorded. */
  async getVersion(agentId: string, version: number): Promise<AgentVersionRow | undefined> {
    const [row] = await this.db
      .select()
      .from(t.agentVersions)
      .where(and(eq(t.agentVersions.agentId, agentId), eq(t.agentVersions.version, version)));
    return row;
  }

  // ---- agent_skills link table (A2 owns the agent side) -------------------

  /** Skills linked to an agent, in `order` ascending. */
  async linkedSkills(agentId: string): Promise<LinkedSkillRow[]> {
    const rows = await this.db
      .select({ skill: t.skills, order: t.agentSkills.order })
      .from(t.agentSkills)
      .innerJoin(t.skills, eq(t.agentSkills.skillId, t.skills.id))
      .where(eq(t.agentSkills.agentId, agentId))
      .orderBy(asc(t.agentSkills.order));
    return rows.map((r) => ({ skill: r.skill, order: r.order }));
  }

  async skillIdsForAgent(agentId: string): Promise<string[]> {
    const links = await this.linkedSkills(agentId);
    return links.map((l) => l.skill.id);
  }

  /** Link a skill to an agent at a given order (idempotent: upserts order). */
  async linkSkill(agentId: string, skillId: string, order: number): Promise<void> {
    await this.db
      .insert(t.agentSkills)
      .values({ agentId, skillId, order })
      .onConflictDoUpdate({
        target: [t.agentSkills.agentId, t.agentSkills.skillId],
        set: { order },
      });
  }

  async unlinkSkill(agentId: string, skillId: string): Promise<void> {
    await this.db
      .delete(t.agentSkills)
      .where(and(eq(t.agentSkills.agentId, agentId), eq(t.agentSkills.skillId, skillId)));
  }

  /**
   * Replace the full set of linked skills for an agent with `skillIds`, assigning
   * order = index. Used by the "Skills" editor tab (attach/reorder). Skills not in
   * the list are unlinked.
   */
  async setSkills(agentId: string, skillIds: string[]): Promise<void> {
    await this.db.delete(t.agentSkills).where(eq(t.agentSkills.agentId, agentId));
    if (skillIds.length === 0) return;
    await this.db
      .insert(t.agentSkills)
      .values(skillIds.map((skillId, i) => ({ agentId, skillId, order: i })));
  }

  // ---- usage stats (Agents list card footer) -----------------------------

  /** Run count + avg cost per agent, from `agent_runs` (workspace-scoped).
   *  avgCostUsd is null when no run in the group reported a cost. */
  async runStatsByAgent(
    workspaceId: string,
  ): Promise<Map<string, { runs: number; avgCostUsd: number | null }>> {
    const rows = await this.db
      .select({
        agentId: t.agentRuns.agentId,
        runs: sql<number>`count(*)::int`,
        avgCostUsd: sql<number | null>`avg(${t.agentRuns.costUsd})`,
      })
      .from(t.agentRuns)
      .where(eq(t.agentRuns.workspaceId, workspaceId))
      .groupBy(t.agentRuns.agentId);
    const map = new Map<string, { runs: number; avgCostUsd: number | null }>();
    for (const r of rows) {
      if (!r.agentId) continue; // runs whose agent was deleted (agent_id set null)
      map.set(r.agentId, {
        runs: r.runs,
        avgCostUsd: r.avgCostUsd == null ? null : Number(r.avgCostUsd),
      });
    }
    return map;
  }

  /** Accepted / dismissed finding counts per agent, joined findings → reviews
   *  (workspace-scoped via reviews). Drives the accept-rate on the card. */
  async acceptanceByAgent(
    workspaceId: string,
  ): Promise<Map<string, { accepted: number; dismissed: number }>> {
    const rows = await this.db
      .select({
        agentId: t.reviews.agentId,
        accepted: sql<number>`count(*) filter (where ${t.findings.acceptedAt} is not null)::int`,
        dismissed: sql<number>`count(*) filter (where ${t.findings.dismissedAt} is not null)::int`,
      })
      .from(t.findings)
      .innerJoin(t.reviews, eq(t.findings.reviewId, t.reviews.id))
      .where(eq(t.reviews.workspaceId, workspaceId))
      .groupBy(t.reviews.agentId);
    const map = new Map<string, { accepted: number; dismissed: number }>();
    for (const r of rows) {
      if (!r.agentId) continue;
      map.set(r.agentId, { accepted: r.accepted, dismissed: r.dismissed });
    }
    return map;
  }

  /** Linked-skill count per agent for this workspace (agent_skills grouped). */
  async skillCountByAgent(workspaceId: string): Promise<Map<string, number>> {
    const rows = await this.db
      .select({
        agentId: t.agentSkills.agentId,
        count: sql<number>`count(*)::int`,
      })
      .from(t.agentSkills)
      .innerJoin(t.agents, eq(t.agentSkills.agentId, t.agents.id))
      .where(eq(t.agents.workspaceId, workspaceId))
      .groupBy(t.agentSkills.agentId);
    const map = new Map<string, number>();
    for (const r of rows) map.set(r.agentId, r.count);
    return map;
  }

  // ---- L08 Spec B: Agent Performance fleet + per-agent stats detail -------
  // All queries here are workspace-scoped and filter agent_runs.source = 'local'
  // — CI-executed runs are excluded from every run/cost view this section
  // powers (AC-26). findings/reviews carry no CI data at all (CI ingestion
  // writes only to ci_runs — see modules/ci/ingest-service.ts), so the
  // findings-based queries below need no separate source filter.

  /** Current (last 30d) vs prior (30-60d ago) cost + run-count windows per
   *  agent (source='local'). `cost30d` is null only when EVERY run in the
   *  current window has unknown cost (AC-28); `costPrior30d` is 0 — never
   *  null — when the prior window had no runs, a legitimate baseline (AC-27). */
  async costWindowsByAgent(
    workspaceId: string,
  ): Promise<Map<string, { cost30d: number | null; costPrior30d: number; runs30d: number }>> {
    const rows = await this.db
      .select({
        agentId: t.agentRuns.agentId,
        cost30d: sql<number | null>`sum(${t.agentRuns.costUsd}) filter (where ${t.agentRuns.ranAt} >= now() - interval '30 days')`,
        costPrior30d: sql<number>`coalesce(sum(${t.agentRuns.costUsd}) filter (where ${t.agentRuns.ranAt} >= now() - interval '60 days' and ${t.agentRuns.ranAt} < now() - interval '30 days'), 0)`,
        runs30d: sql<number>`count(*) filter (where ${t.agentRuns.ranAt} >= now() - interval '30 days')::int`,
      })
      .from(t.agentRuns)
      .where(
        and(
          eq(t.agentRuns.workspaceId, workspaceId),
          eq(t.agentRuns.source, 'local'),
          isNotNull(t.agentRuns.agentId),
        ),
      )
      .groupBy(t.agentRuns.agentId);
    const map = new Map<string, { cost30d: number | null; costPrior30d: number; runs30d: number }>();
    for (const r of rows) {
      if (!r.agentId) continue;
      map.set(r.agentId, {
        cost30d: r.cost30d == null ? null : Number(r.cost30d),
        costPrior30d: Number(r.costPrior30d),
        runs30d: Number(r.runs30d),
      });
    }
    return map;
  }

  /** Same two-window shape as `costWindowsByAgent`, but ungrouped and with NO
   *  agent filter — whole-workspace totals deliberately include a deleted
   *  agent's historical runs (AC-29), unlike every per-agent breakdown above.
   *  Also carries the workspace's all-time (lifetime) run count for
   *  `AgentPerf.summary.total_runs_all_time` — same WHERE clause, one extra
   *  unfiltered `count(*)`, so it's free to compute alongside the windows. */
  async workspaceCostWindows(workspaceId: string): Promise<{
    totalRunsAllTime: number;
    cost30d: number | null;
    costPrior30d: number;
    runs30d: number;
  }> {
    const [row] = await this.db
      .select({
        totalRunsAllTime: sql<number>`count(*)::int`,
        cost30d: sql<number | null>`sum(${t.agentRuns.costUsd}) filter (where ${t.agentRuns.ranAt} >= now() - interval '30 days')`,
        costPrior30d: sql<number>`coalesce(sum(${t.agentRuns.costUsd}) filter (where ${t.agentRuns.ranAt} >= now() - interval '60 days' and ${t.agentRuns.ranAt} < now() - interval '30 days'), 0)`,
        runs30d: sql<number>`count(*) filter (where ${t.agentRuns.ranAt} >= now() - interval '30 days')::int`,
      })
      .from(t.agentRuns)
      .where(and(eq(t.agentRuns.workspaceId, workspaceId), eq(t.agentRuns.source, 'local')));
    return {
      totalRunsAllTime: row ? Number(row.totalRunsAllTime) : 0,
      cost30d: row?.cost30d == null ? null : Number(row.cost30d),
      costPrior30d: row ? Number(row.costPrior30d) : 0,
      runs30d: row ? Number(row.runs30d) : 0,
    };
  }

  /** The agent with the highest run count in the trailing 30 days, or
   *  undefined when no agent has run in that window. */
  async mostActiveAgent30d(
    workspaceId: string,
  ): Promise<{ agentId: string; agentName: string; runs30d: number } | undefined> {
    const rows = await this.db
      .select({
        agentId: t.agentRuns.agentId,
        agentName: t.agents.name,
        runs30d: sql<number>`count(*)::int`,
      })
      .from(t.agentRuns)
      .innerJoin(t.agents, eq(t.agents.id, t.agentRuns.agentId))
      .where(
        and(
          eq(t.agentRuns.workspaceId, workspaceId),
          eq(t.agentRuns.source, 'local'),
          isNotNull(t.agentRuns.agentId),
          sql`${t.agentRuns.ranAt} >= now() - interval '30 days'`,
        ),
      )
      .groupBy(t.agentRuns.agentId, t.agents.name)
      .orderBy(sql`count(*) desc`)
      .limit(1);
    const r = rows[0];
    if (!r || !r.agentId) return undefined;
    return { agentId: r.agentId, agentName: r.agentName, runs30d: Number(r.runs30d) };
  }

  /** Blended accept-rate (0-100, a percentage) across the whole workspace's
   *  findings on reviews CREATED in the trailing 30 days (windows on
   *  `reviews.created_at`, consistent with the feature's other 30d windows —
   *  not "findings acted on in the trailing 30 days"; a finding accepted/
   *  dismissed outside the window still counts as long as its review was
   *  created inside it). Reuses `acceptanceByAgent`'s findings → reviews join
   *  shape, ungrouped. Null when nothing was accepted or dismissed in the
   *  window. */
  async avgAcceptRate30d(workspaceId: string): Promise<number | null> {
    const [row] = await this.db
      .select({
        accepted: sql<number>`count(*) filter (where ${t.findings.acceptedAt} is not null)::int`,
        dismissed: sql<number>`count(*) filter (where ${t.findings.dismissedAt} is not null)::int`,
      })
      .from(t.findings)
      .innerJoin(t.reviews, eq(t.findings.reviewId, t.reviews.id))
      .where(
        and(
          eq(t.reviews.workspaceId, workspaceId),
          sql`${t.reviews.createdAt} >= now() - interval '30 days'`,
        ),
      );
    const accepted = row ? Number(row.accepted) : 0;
    const dismissed = row ? Number(row.dismissed) : 0;
    const acted = accepted + dismissed;
    return acted > 0 ? (accepted / acted) * 100 : null;
  }

  /** Trailing-30-day cost per agent (source='local'). A group whose every
   *  run has unknown cost returns `cost: null` (AC-28), not omitted/0. */
  async costByAgent30d(
    workspaceId: string,
  ): Promise<{ agentId: string; agentName: string; cost: number | null }[]> {
    const rows = await this.db
      .select({
        agentId: t.agentRuns.agentId,
        agentName: t.agents.name,
        cost: sql<number | null>`sum(${t.agentRuns.costUsd})`,
      })
      .from(t.agentRuns)
      .innerJoin(t.agents, eq(t.agents.id, t.agentRuns.agentId))
      .where(
        and(
          eq(t.agentRuns.workspaceId, workspaceId),
          eq(t.agentRuns.source, 'local'),
          isNotNull(t.agentRuns.agentId),
          sql`${t.agentRuns.ranAt} >= now() - interval '30 days'`,
        ),
      )
      .groupBy(t.agentRuns.agentId, t.agents.name);
    const out: { agentId: string; agentName: string; cost: number | null }[] = [];
    for (const r of rows) {
      if (!r.agentId) continue;
      out.push({
        agentId: r.agentId,
        agentName: r.agentName,
        cost: r.cost == null ? null : Number(r.cost),
      });
    }
    return out;
  }

  /** Trailing-30-day cost per model (source='local'). Same null semantics as
   *  `costByAgent30d` (AC-28). */
  async costByModel30d(workspaceId: string): Promise<{ model: string; cost: number | null }[]> {
    const rows = await this.db
      .select({
        model: t.agentRuns.model,
        cost: sql<number | null>`sum(${t.agentRuns.costUsd})`,
      })
      .from(t.agentRuns)
      .where(
        and(
          eq(t.agentRuns.workspaceId, workspaceId),
          eq(t.agentRuns.source, 'local'),
          isNotNull(t.agentRuns.model),
          sql`${t.agentRuns.ranAt} >= now() - interval '30 days'`,
        ),
      )
      .groupBy(t.agentRuns.model);
    const out: { model: string; cost: number | null }[] = [];
    for (const r of rows) {
      if (!r.model) continue;
      out.push({ model: r.model, cost: r.cost == null ? null : Number(r.cost) });
    }
    return out;
  }

  /** All-time run aggregates per agent (source='local') — runs, cost sum/avg,
   *  avg latency, most-recent run, and an oldest→newest cost-history trend
   *  (unknown-cost runs excluded — a $0 point would misleadingly imply a free
   *  run). Extends the `runStatsByAgent` idiom with the extra fields
   *  `AgentPerfRow`/`AgentStats` need; `runStatsByAgent` itself is untouched
   *  (still feeds the existing `GET /agents/stats` card footer). */
  async runAggregatesByAgent(workspaceId: string): Promise<
    Map<
      string,
      {
        runs: number;
        totalCostUsd: number | null;
        avgCostUsd: number | null;
        avgLatencyMs: number | null;
        lastRunAt: Date | null;
        costTrend: number[];
      }
    >
  > {
    const rows = await this.db
      .select({
        agentId: t.agentRuns.agentId,
        runs: sql<number>`count(*)::int`,
        totalCostUsd: sql<number | null>`sum(${t.agentRuns.costUsd})`,
        avgCostUsd: sql<number | null>`avg(${t.agentRuns.costUsd})`,
        avgLatencyMs: sql<number | null>`avg(${t.agentRuns.durationMs})`,
        lastRunAt: sql<Date | null>`max(${t.agentRuns.ranAt})`,
        costTrend: sql<number[] | null>`array_agg(${t.agentRuns.costUsd} order by ${t.agentRuns.ranAt} asc) filter (where ${t.agentRuns.costUsd} is not null)`,
      })
      .from(t.agentRuns)
      .where(and(eq(t.agentRuns.workspaceId, workspaceId), eq(t.agentRuns.source, 'local')))
      .groupBy(t.agentRuns.agentId);
    const map = new Map<
      string,
      {
        runs: number;
        totalCostUsd: number | null;
        avgCostUsd: number | null;
        avgLatencyMs: number | null;
        lastRunAt: Date | null;
        costTrend: number[];
      }
    >();
    for (const r of rows) {
      if (!r.agentId) continue;
      map.set(r.agentId, {
        runs: Number(r.runs),
        totalCostUsd: r.totalCostUsd == null ? null : Number(r.totalCostUsd),
        avgCostUsd: r.avgCostUsd == null ? null : Number(r.avgCostUsd),
        avgLatencyMs: r.avgLatencyMs == null ? null : Number(r.avgLatencyMs),
        lastRunAt: r.lastRunAt ? new Date(r.lastRunAt) : null,
        costTrend: (r.costTrend ?? []).map((c) => Number(c)),
      });
    }
    return map;
  }

  /** All-time findings totals + severity breakdown per agent, joined
   *  findings → reviews (workspace-scoped via reviews; no source filter
   *  needed — CI ingestion never writes to findings/reviews). Extends the
   *  `acceptanceByAgent` idiom with `total`/`pending`/severity counts that
   *  `AgentPerfRow`/`AgentStats` need; `acceptanceByAgent` itself is untouched. */
  async findingsAggregatesByAgent(workspaceId: string): Promise<
    Map<
      string,
      {
        total: number;
        accepted: number;
        dismissed: number;
        pending: number;
        bySeverity: { CRITICAL: number; WARNING: number; SUGGESTION: number };
      }
    >
  > {
    const rows = await this.db
      .select({
        agentId: t.reviews.agentId,
        severity: t.findings.severity,
        total: sql<number>`count(*)::int`,
        accepted: sql<number>`count(*) filter (where ${t.findings.acceptedAt} is not null)::int`,
        dismissed: sql<number>`count(*) filter (where ${t.findings.dismissedAt} is not null)::int`,
      })
      .from(t.findings)
      .innerJoin(t.reviews, eq(t.findings.reviewId, t.reviews.id))
      .where(eq(t.reviews.workspaceId, workspaceId))
      .groupBy(t.reviews.agentId, t.findings.severity);

    const map = new Map<
      string,
      {
        total: number;
        accepted: number;
        dismissed: number;
        pending: number;
        bySeverity: { CRITICAL: number; WARNING: number; SUGGESTION: number };
      }
    >();
    for (const r of rows) {
      if (!r.agentId) continue;
      const entry = map.get(r.agentId) ?? {
        total: 0,
        accepted: 0,
        dismissed: 0,
        pending: 0,
        bySeverity: { CRITICAL: 0, WARNING: 0, SUGGESTION: 0 },
      };
      entry.total += Number(r.total);
      entry.accepted += Number(r.accepted);
      entry.dismissed += Number(r.dismissed);
      if (r.severity === 'CRITICAL') entry.bySeverity.CRITICAL += Number(r.total);
      else if (r.severity === 'WARNING') entry.bySeverity.WARNING += Number(r.total);
      else if (r.severity === 'SUGGESTION') entry.bySeverity.SUGGESTION += Number(r.total);
      map.set(r.agentId, entry);
    }
    for (const entry of map.values()) {
      entry.pending = entry.total - entry.accepted - entry.dismissed;
    }
    return map;
  }

  /** Findings-by-severity counts per UTC-Monday-aligned ISO week for one
   *  agent, trailing 8 weeks — RAW rows only (only weeks that actually have
   *  findings); the service zero-fills the full 8-week span (spec §9: a week
   *  with zero findings of a given severity is 0, not omitted).
   *  `oldestWeekStart` is the caller-computed oldest of the 8 UTC Monday
   *  buckets (not `now() - interval '8 weeks'`) — that fixed 8-week interval
   *  lands mid-week, which would span a 9th Monday bucket the service's
   *  zero-fill never generates a key for, silently dropping the oldest
   *  partial week. Grouping forces `AT TIME ZONE 'UTC'` so the bucket
   *  boundary is independent of the DB session's timezone and matches the
   *  service's UTC-Monday keys exactly. */
  async weeklyFindingsBySeverity(
    workspaceId: string,
    agentId: string,
    oldestWeekStart: Date,
  ): Promise<{ weekStart: Date; severity: string; count: number }[]> {
    const weekBucket = sql<Date>`date_trunc('week', ${t.reviews.createdAt} AT TIME ZONE 'UTC')::date`;
    const rows = await this.db
      .select({
        weekStart: weekBucket,
        severity: t.findings.severity,
        count: sql<number>`count(*)::int`,
      })
      .from(t.findings)
      .innerJoin(t.reviews, eq(t.findings.reviewId, t.reviews.id))
      .where(
        and(
          eq(t.reviews.workspaceId, workspaceId),
          eq(t.reviews.agentId, agentId),
          sql`${t.reviews.createdAt} >= ${oldestWeekStart.toISOString()}`,
        ),
      )
      .groupBy(weekBucket, t.findings.severity);
    return rows.map((r) => ({
      weekStart: new Date(r.weekStart),
      severity: r.severity,
      count: Number(r.count),
    }));
  }

  /** This agent's studio-executed run history (source='local'), newest
   *  first. A NEW agent-scoped query — does NOT reuse
   *  `reviews/repository/run.repo.ts`'s `listRunsForPull` (cross-module
   *  import would violate the module-boundary rule R6/AP-4); only its shape
   *  is used as a style reference. */
  async runHistoryForAgent(workspaceId: string, agentId: string): Promise<AgentRunHistoryRow[]> {
    const rows = await this.db
      .select({
        runId: t.agentRuns.id,
        ranAt: t.agentRuns.ranAt,
        status: t.agentRuns.status,
        costUsd: t.agentRuns.costUsd,
        findingsCount: t.agentRuns.findingsCount,
        prNumber: t.pullRequests.number,
      })
      .from(t.agentRuns)
      .leftJoin(t.pullRequests, eq(t.pullRequests.id, t.agentRuns.prId))
      .where(
        and(
          eq(t.agentRuns.workspaceId, workspaceId),
          eq(t.agentRuns.agentId, agentId),
          eq(t.agentRuns.source, 'local'),
        ),
      )
      .orderBy(desc(t.agentRuns.ranAt));
    return rows.map((r) => ({
      run_id: r.runId,
      ran_at: r.ranAt.toISOString(),
      status: r.status,
      cost_usd: r.costUsd,
      findings_count: r.findingsCount,
      pr_number: r.prNumber ?? null,
    }));
  }

  /** Ranked approximation of an agent's most-used linked skills.
   *  `usage_estimate` is a FLAT magnitude (the agent's own run count) shared
   *  by every linked skill — ranking comes only from `agent_skills.order`
   *  ascending, since no real per-skill usage is tracked (spec §8). Empty
   *  list when the agent has no linked skills (AC-13). */
  async mostUsedSkillsApprox(agentId: string): Promise<AgentRankedUsageRow[]> {
    const links = await this.linkedSkills(agentId);
    if (links.length === 0) return [];
    const [runRow] = await this.db
      .select({ runs: sql<number>`count(*)::int` })
      .from(t.agentRuns)
      .where(and(eq(t.agentRuns.agentId, agentId), eq(t.agentRuns.source, 'local')));
    const usageEstimate = runRow ? Number(runRow.runs) : 0;
    return links.map((l) => ({ id: l.skill.id, name: l.skill.name, usage_estimate: usageEstimate }));
  }

  /** No memory-pull write instrumentation exists yet — an honest empty read,
   *  never a fabricated approximation (AC-14). */
  async memoryPulledSummary(_agentId: string): Promise<AgentRankedUsageRow[]> {
    return [];
  }
}
