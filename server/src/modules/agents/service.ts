import type { Container } from '../../platform/container.js';
import type {
  Agent,
  AgentSkillLink,
  AgentCardStats,
  AgentVersion,
  AgentContextDocLink,
  AgentPerf,
  AgentPerfRow,
  AgentStatsDetail,
  CiFailOn,
  ModelInfo,
  PerfCostSegment,
  Provider,
  ReviewStrategy,
  StatPoint,
  WeeklySeverityPoint,
} from '@devdigest/shared';
import { AgentsRepository } from './repository.js';
import { toAgentDto, toAgentVersionDto } from './helpers.js';
import { NotFoundError, ValidationError } from '../../platform/errors.js';

/**
 * A2 — agents service. Business logic for the Agents tab + Agent Editor.
 * Provider/model selection uses the LLM adapter's dynamic model list.
 *
 * An Agent = provider + model + system_prompt + linked skills + output_schema +
 * enabled. Config changes are versioned via `agent_versions` (repository).
 */

// Re-exported for backwards compatibility; implementation lives in ./helpers.
export { toAgentDto } from './helpers.js';

export interface CreateAgentInput {
  name: string;
  description?: string;
  provider: Provider;
  model: string;
  system_prompt: string;
  output_schema?: unknown;
  strategy?: ReviewStrategy;
  ci_fail_on?: CiFailOn;
  repo_intel?: boolean;
  enabled?: boolean;
}

export interface UpdateAgentInput {
  name?: string;
  description?: string;
  provider?: Provider;
  model?: string;
  system_prompt?: string;
  output_schema?: unknown;
  strategy?: ReviewStrategy;
  ci_fail_on?: CiFailOn;
  repo_intel?: boolean;
  enabled?: boolean;
}

export class AgentsService {
  private repo: AgentsRepository;

  constructor(private container: Container) {
    this.repo = new AgentsRepository(container.db);
  }

  async list(workspaceId: string): Promise<Agent[]> {
    const rows = await this.repo.list(workspaceId);
    return rows.map(toAgentDto);
  }

  async get(workspaceId: string, id: string): Promise<Agent | undefined> {
    const row = await this.repo.getById(workspaceId, id);
    return row ? toAgentDto(row) : undefined;
  }

  /**
   * Rolled-up usage stats for every agent in the workspace (Agents list card
   * footer). Runs + avg cost from `agent_runs`; accept rate over
   * accepted+dismissed findings of the agent's reviews; linked-skill count.
   * `accept_pct` / `avg_cost_usd` are null when there is nothing to average.
   */
  async stats(workspaceId: string): Promise<AgentCardStats[]> {
    const [agents, runStats, acceptance, skillCounts] = await Promise.all([
      this.repo.list(workspaceId),
      this.repo.runStatsByAgent(workspaceId),
      this.repo.acceptanceByAgent(workspaceId),
      this.repo.skillCountByAgent(workspaceId),
    ]);
    return agents.map((a) => {
      const rs = runStats.get(a.id);
      const ac = acceptance.get(a.id);
      const acted = (ac?.accepted ?? 0) + (ac?.dismissed ?? 0);
      return {
        agent_id: a.id,
        runs: rs?.runs ?? 0,
        skill_count: skillCounts.get(a.id) ?? 0,
        accept_pct: acted > 0 ? Math.round(((ac!.accepted) / acted) * 100) : null,
        avg_cost_usd: rs?.avgCostUsd ?? null,
      };
    });
  }

  /** Delete an agent (and its versions/skill-links, via cascade). */
  async delete(workspaceId: string, id: string): Promise<boolean> {
    return this.repo.deleteById(workspaceId, id);
  }

  async create(workspaceId: string, input: CreateAgentInput, userId?: string): Promise<Agent> {
    const row = await this.repo.insert({
      workspaceId,
      name: input.name,
      description: input.description,
      provider: input.provider,
      model: input.model,
      systemPrompt: input.system_prompt,
      outputSchema: input.output_schema,
      ...(input.strategy !== undefined ? { strategy: input.strategy } : {}),
      ...(input.ci_fail_on !== undefined ? { ciFailOn: input.ci_fail_on } : {}),
      ...(input.repo_intel !== undefined ? { repoIntel: input.repo_intel } : {}),
      enabled: input.enabled,
      createdBy: userId ?? null,
    });
    return toAgentDto(row);
  }

  async update(
    workspaceId: string,
    id: string,
    patch: UpdateAgentInput,
  ): Promise<Agent | undefined> {
    const row = await this.repo.update(workspaceId, id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.provider !== undefined ? { provider: patch.provider } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.system_prompt !== undefined ? { systemPrompt: patch.system_prompt } : {}),
      ...(patch.output_schema !== undefined ? { outputSchema: patch.output_schema } : {}),
      ...(patch.strategy !== undefined ? { strategy: patch.strategy } : {}),
      ...(patch.ci_fail_on !== undefined ? { ciFailOn: patch.ci_fail_on } : {}),
      ...(patch.repo_intel !== undefined ? { repoIntel: patch.repo_intel } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    });
    return row ? toAgentDto(row) : undefined;
  }

  /**
   * Config history for an agent, newest version first. Workspace-scoped: returns
   * undefined when the agent isn't in this workspace (the route maps that to 404)
   * so version snapshots can't be read across tenants.
   */
  async listVersions(workspaceId: string, agentId: string): Promise<AgentVersion[] | undefined> {
    const agent = await this.repo.getById(workspaceId, agentId);
    if (!agent) return undefined;
    const rows = await this.repo.listVersions(agentId);
    return rows.map(toAgentVersionDto);
  }

  /**
   * A single config snapshot for an agent. Returns undefined when the agent isn't
   * in this workspace OR that version was never recorded (route → 404).
   */
  async getVersion(
    workspaceId: string,
    agentId: string,
    version: number,
  ): Promise<AgentVersion | undefined> {
    const agent = await this.repo.getById(workspaceId, agentId);
    if (!agent) return undefined;
    const row = await this.repo.getVersion(agentId, version);
    return row ? toAgentVersionDto(row) : undefined;
  }

  /** Linked skills for an agent as AgentSkillLink[] (ordered). */
  async skillLinks(agentId: string): Promise<AgentSkillLink[]> {
    const links = await this.repo.linkedSkills(agentId);
    return links.map((l) => ({ agent_id: agentId, skill_id: l.skill.id, order: l.order }));
  }

  /**
   * Set / reorder the agent's linked skills. If `skillIds` is provided, replaces
   * the whole set in that order. Returns the resulting ordered links.
   */
  async setSkills(
    workspaceId: string,
    agentId: string,
    skillIds: string[],
  ): Promise<AgentSkillLink[] | undefined> {
    const agent = await this.repo.getById(workspaceId, agentId);
    if (!agent) return undefined;
    await this.repo.setSkills(agentId, skillIds);
    return this.skillLinks(agentId);
  }

  /** Link a single skill (append or set order) — additive to existing links. */
  async linkSkill(
    workspaceId: string,
    agentId: string,
    skillId: string,
    order?: number,
  ): Promise<AgentSkillLink[] | undefined> {
    const agent = await this.repo.getById(workspaceId, agentId);
    if (!agent) return undefined;
    const existing = await this.repo.linkedSkills(agentId);
    const resolvedOrder = order ?? existing.length;
    await this.repo.linkSkill(agentId, skillId, resolvedOrder);
    return this.skillLinks(agentId);
  }

  /**
   * Attached context documents for an agent (ordered). 404-guards `agentId`
   * against `workspaceId` via `get()` BEFORE delegating to `ContextDocsService`
   * — `ContextDocsService.agentAttachments`/`setAgentAttachments` intentionally
   * do NOT re-validate workspace ownership themselves (see context-docs
   * service.ts's "ownership boundary" comment). Returns `undefined` when the
   * agent isn't in this workspace (route maps that to 404).
   */
  async contextDocLinks(
    workspaceId: string,
    agentId: string,
  ): Promise<AgentContextDocLink[] | undefined> {
    const agent = await this.repo.getById(workspaceId, agentId);
    if (!agent) return undefined;
    const links = await this.container.contextDocs.agentAttachments(agentId);
    return links.map((l) => ({ owner_id: agentId, path: l.path, order: l.order }));
  }

  /**
   * Replace the agent's full set of attached context-document paths (full
   * replace-and-reorder semantics, mirrors `setSkills`). Same workspace guard
   * as `contextDocLinks` — validated here, before `ContextDocsService` is
   * touched.
   */
  async setContextDocs(
    workspaceId: string,
    agentId: string,
    paths: string[],
  ): Promise<AgentContextDocLink[] | undefined> {
    const agent = await this.repo.getById(workspaceId, agentId);
    if (!agent) return undefined;
    const links = await this.container.contextDocs.setAgentAttachments(agentId, paths);
    return links.map((l) => ({ owner_id: agentId, path: l.path, order: l.order }));
  }

  /**
   * Dynamic model list from the provider adapter's /models. Degrades gracefully
   * to [] if the provider key is not configured (the editor still renders).
   */
  async listModels(provider: Provider): Promise<ModelInfo[]> {
    try {
      const llm = await this.container.llm(provider);
      return await llm.listModels();
    } catch {
      return [];
    }
  }

  /**
   * Promote an eval batch's frozen system-prompt snapshot onto this agent
   * (Agent Eval Dashboard). Reads the batch via `container.evalRepo` — the
   * ONE cross-module read into `eval`'s data, never a direct import of
   * `eval/repository.js` (R6). Ownership (`batch.agentId === agentId`) is
   * checked BEFORE any mutation (AC-25 — prevents a same-workspace IDOR where
   * agent A's batch overwrites agent B's prompt).
   */
  async promoteFromBatch(workspaceId: string, agentId: string, batchId: string): Promise<Agent> {
    const snapshot = await this.container.evalRepo.getBatchPromptSnapshot(workspaceId, batchId);
    if (!snapshot) throw new NotFoundError('Eval batch not found');
    if (snapshot.agentId !== agentId) {
      throw new ValidationError('Batch does not belong to this agent');
    }
    if (snapshot.systemPromptSnapshot === null) {
      throw new ValidationError('This batch has no stored prompt text and cannot be promoted');
    }

    const row = await this.repo.promoteSystemPrompt(
      workspaceId,
      agentId,
      snapshot.systemPromptSnapshot,
      batchId,
    );
    return toAgentDto(row!);
  }

  // ---- L08 Spec B: Agent Performance fleet + per-agent stats detail -------

  /**
   * Fleet-wide agent performance read (GET /agents/performance). EVERY agent
   * in the workspace appears, including zero-run ones (AC-3) — the agent
   * list is the anchor; every aggregate is a Map lookup that defaults a
   * missing entry to zeros/nulls (never fabricating a rate for an agent with
   * no acted findings). Mirrors `stats()`'s Promise.all composition style.
   */
  async performance(workspaceId: string): Promise<AgentPerf> {
    const [
      agents,
      runAgg,
      findingsAgg,
      workspaceWindows,
      mostActive,
      avgAcceptRatePct,
      costByAgentRows,
      costByModelRows,
    ] = await Promise.all([
      this.repo.list(workspaceId),
      this.repo.runAggregatesByAgent(workspaceId),
      this.repo.findingsAggregatesByAgent(workspaceId),
      this.repo.workspaceCostWindows(workspaceId),
      this.repo.mostActiveAgent30d(workspaceId),
      this.repo.avgAcceptRate30d(workspaceId),
      this.repo.costByAgent30d(workspaceId),
      this.repo.costByModel30d(workspaceId),
    ]);

    const agentRows: AgentPerfRow[] = agents.map((a) => {
      const ra = runAgg.get(a.id);
      const fa = findingsAgg.get(a.id);
      const runs = ra?.runs ?? 0;
      const accepted = fa?.accepted ?? 0;
      const dismissed = fa?.dismissed ?? 0;
      const acted = accepted + dismissed;
      const findingsTotal = fa?.total ?? 0;
      return {
        agent_id: a.id,
        agent_name: a.name,
        provider: a.provider,
        model: a.model,
        runs,
        findings_total: findingsTotal,
        accepted,
        dismissed,
        accept_rate: acted > 0 ? accepted / acted : null,
        dismiss_rate: acted > 0 ? dismissed / acted : null,
        avg_findings_per_run: runs > 0 ? findingsTotal / runs : null,
        // Zero-run agent (no run-aggregate row) SHALL display cost as 0, not
        // "—" (AC-3). An agent that DOES have runs but whose every run has
        // unknown cost still surfaces the genuine `null` from `ra.totalCostUsd`.
        total_cost_usd: ra ? ra.totalCostUsd : 0,
        avg_cost_usd: ra?.avgCostUsd ?? null,
        avg_latency_ms: ra?.avgLatencyMs ?? null,
        last_run_at: ra?.lastRunAt ? ra.lastRunAt.toISOString() : null,
        findings_by_severity: fa?.bySeverity ?? { CRITICAL: 0, WARNING: 0, SUGGESTION: 0 },
        // Recent per-run cost points (oldest→newest) for the row's sparkline.
        cost_trend: (ra?.costTrend ?? []).slice(-10),
      };
    });

    const costByAgent: PerfCostSegment[] = costByAgentRows.map((r) => ({
      label: r.agentName,
      value: r.cost,
    }));
    const costByModel: PerfCostSegment[] = costByModelRows.map((r) => ({
      label: r.model,
      value: r.cost,
    }));

    return {
      summary: {
        total_runs_all_time: workspaceWindows.totalRunsAllTime,
        total_cost_usd_30d: workspaceWindows.cost30d,
        cost_delta_usd_30d:
          workspaceWindows.cost30d == null
            ? null
            : workspaceWindows.cost30d - workspaceWindows.costPrior30d,
        avg_accept_rate_pct_30d: avgAcceptRatePct == null ? null : Math.round(avgAcceptRatePct),
        most_active_agent: mostActive
          ? {
              agent_id: mostActive.agentId,
              agent_name: mostActive.agentName,
              runs_30d: mostActive.runs30d,
            }
          : null,
      },
      agents: agentRows,
      cost_by_agent: costByAgent,
      cost_by_model: costByModel,
    };
  }

  /**
   * Per-agent stats detail (GET /agents/:id/stats). Workspace-scoped via
   * `get()` BEFORE any aggregate query runs — returns undefined on a 404-miss
   * (route maps that to NotFoundError). Composes the base `AgentStats`
   * metrics (defined in the shared contract since 2026-07-02 but never wired
   * to a route until now — see server/insights.md) plus the 5 L08 Spec B
   * additive fields.
   */
  async statsDetail(workspaceId: string, agentId: string): Promise<AgentStatsDetail | undefined> {
    const agent = await this.get(workspaceId, agentId);
    if (!agent) return undefined;

    // Computed once so the repo's lower bound and the zero-fill's 8 keys are
    // guaranteed to agree — see `eightUtcMondayWeekStarts` doc comment.
    const weekStarts = eightUtcMondayWeekStarts();
    const oldestWeekStart = weekStarts[0]!;

    const [runAgg, findingsAgg, costWindows, weeklyRaw, mostUsedSkills, memoryPulled, runHistory] =
      await Promise.all([
        this.repo.runAggregatesByAgent(workspaceId),
        this.repo.findingsAggregatesByAgent(workspaceId),
        this.repo.costWindowsByAgent(workspaceId),
        this.repo.weeklyFindingsBySeverity(workspaceId, agentId, oldestWeekStart),
        this.repo.mostUsedSkillsApprox(agentId),
        this.repo.memoryPulledSummary(agentId),
        this.repo.runHistoryForAgent(workspaceId, agentId),
      ]);

    const ra = runAgg.get(agentId);
    const fa = findingsAgg.get(agentId);
    const cw = costWindows.get(agentId);

    const runs = ra?.runs ?? 0;
    const accepted = fa?.accepted ?? 0;
    const dismissed = fa?.dismissed ?? 0;
    const acted = accepted + dismissed;
    const findingsTotal = fa?.total ?? 0;
    const pending = fa?.pending ?? 0;

    // Recent-cost sparkline: derived from run_history (already fetched, and
    // it carries ran_at), not runAggregatesByAgent's unlabeled cost_trend —
    // StatPoint needs a label. Runs with unknown cost are excluded FIRST,
    // THEN the most recent up-to-10 priced runs are taken — filtering after
    // slicing would show an empty sparkline whenever the 10 newest runs all
    // happen to have null cost, even with plenty of older priced runs.
    // Matches the fleet row's `cost_trend`, which filters nulls in SQL before
    // taking the last 10 (`runAggregatesByAgent`'s `array_agg ... filter`).
    const trend: StatPoint[] = runHistory
      .filter((r) => r.cost_usd != null)
      .slice(0, 10)
      .reverse()
      .map((r) => ({ label: r.ran_at.slice(0, 10), value: r.cost_usd as number }));

    return {
      agent_id: agent.id,
      agent_name: agent.name,
      runs,
      findings_total: findingsTotal,
      accepted,
      dismissed,
      pending,
      accept_rate: acted > 0 ? accepted / acted : null,
      dismiss_rate: acted > 0 ? dismissed / acted : null,
      avg_findings_per_run: runs > 0 ? findingsTotal / runs : null,
      total_cost_usd: ra?.totalCostUsd ?? null,
      avg_cost_usd: ra?.avgCostUsd ?? null,
      avg_latency_ms: ra?.avgLatencyMs ?? null,
      findings_by_severity: fa?.bySeverity ?? { CRITICAL: 0, WARNING: 0, SUGGESTION: 0 },
      trend,
      cost_delta_usd_30d: !cw || cw.cost30d == null ? null : cw.cost30d - cw.costPrior30d,
      weekly_findings_by_severity: zeroFillWeeklySeverity(weeklyRaw, weekStarts),
      most_used_skills: mostUsedSkills,
      memory_pulled_summary: memoryPulled,
      run_history: runHistory,
    };
  }
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The 8 UTC-Monday-aligned week-start dates (oldest→newest) that both the
 * weekly-severity repo call (its `oldestWeekStart` lower bound) and
 * `zeroFillWeeklySeverity` (its 8 zero-fill keys) must agree on — computed
 * ONCE by the caller and threaded through both, so the two can never drift
 * apart. Previously each side independently derived its own week window
 * (`now() - interval '8 weeks'` in SQL vs. 8 JS-computed keys); because
 * `now() - 8 weeks` lands mid-week, that mismatched span actually covered a
 * 9th Monday bucket with no matching zero-fill key, silently DROPPING any
 * finding in the oldest partial week. This single source of truth removes
 * that class of bug entirely.
 */
function eightUtcMondayWeekStarts(): Date[] {
  const now = new Date();
  const diffToMonday = (now.getUTCDay() + 6) % 7; // Mon=0 ... Sun=6
  const thisWeekStart = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - diffToMonday,
  );
  const weeks: Date[] = [];
  for (let i = 7; i >= 0; i--) {
    weeks.push(new Date(thisWeekStart - i * WEEK_MS));
  }
  return weeks;
}

/**
 * Expand the DB's sparse (week, severity) rows into exactly 8 ordered
 * `WeeklySeverityPoint`s (oldest→newest) — a week/severity combo with zero
 * findings is 0, not omitted (spec §9). `weekStarts` are the same 8
 * UTC-Monday dates already passed as the repo query's lower bound (see
 * `eightUtcMondayWeekStarts`), so every DB row is guaranteed to match one of
 * these 8 keys — the DB side groups by `date_trunc('week', … AT TIME ZONE
 * 'UTC')::date`, forcing UTC alignment independent of the DB session's
 * timezone.
 */
function zeroFillWeeklySeverity(
  raw: { weekStart: Date; severity: string; count: number }[],
  weekStarts: Date[],
): WeeklySeverityPoint[] {
  const weekKeys = weekStarts.map((d) => d.toISOString().slice(0, 10));

  const bucket = new Map<string, { CRITICAL: number; WARNING: number; SUGGESTION: number }>();
  for (const r of raw) {
    const key = r.weekStart.toISOString().slice(0, 10);
    const entry = bucket.get(key) ?? { CRITICAL: 0, WARNING: 0, SUGGESTION: 0 };
    if (r.severity === 'CRITICAL') entry.CRITICAL += r.count;
    else if (r.severity === 'WARNING') entry.WARNING += r.count;
    else if (r.severity === 'SUGGESTION') entry.SUGGESTION += r.count;
    bucket.set(key, entry);
  }

  return weekKeys.map((week_start) => ({
    week_start,
    ...(bucket.get(week_start) ?? { CRITICAL: 0, WARNING: 0, SUGGESTION: 0 }),
  }));
}
