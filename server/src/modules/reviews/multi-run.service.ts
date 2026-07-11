import type { Container } from '../../platform/container.js';
import type { AgentRow } from '../../db/rows.js';
import type {
  AgentColumn,
  AgentColumnFinding,
  AgentEstimate,
  FindingRecord,
  MultiAgentRun,
  MultiAgentRunStartResponse,
  Severity,
} from '@devdigest/shared';
import { NotFoundError } from '../../platform/errors.js';
import { ReviewRepository } from './repository.js';
import { findingRowToDto } from './helpers.js';
import { ReviewRunExecutor, type Logger } from './run-executor.js';
import { ReviewService } from './service.js';
import * as multiRunRepo from './repository/multi-run.repo.js';
import { computeConflicts, type MatcherColumn, type MatcherFinding } from './conflict-matcher.js';
import { MULTI_AGENT_CONCURRENCY_CAP } from './constants.js';

/**
 * Multi-Agent Review — orchestrates the "run N agents on the same PR in
 * parallel" flow: starting a fan-out group, composing its read-model
 * (columns + cross-agent conflicts), and pre-run cost/duration estimates from
 * an agent's own run history. Constructed the same way `ReviewService` is
 * (own `ReviewRepository` + `ReviewRunExecutor`) — kept as a SIBLING service
 * rather than added to `ReviewService` to stay under the "large file → new
 * sub-plugin" threshold documented in `server/insights.md`.
 */
export class MultiRunService {
  private repo: ReviewRepository;
  private agents: Container['agentsRepo'];
  private executor: ReviewRunExecutor;

  constructor(private container: Container) {
    this.repo = new ReviewRepository(container.db);
    this.agents = container.agentsRepo;
    this.executor = new ReviewRunExecutor(container, this.repo, this.agents);
  }

  /**
   * Start a multi-agent fan-out run: resolve targets, create the group row,
   * create one `agent_runs` row per target UP FRONT (so `runId`s are
   * available immediately — same pattern as `ReviewService.runReview`), then
   * fire-and-forget the CONCURRENT executor (never the sequential one).
   */
  async startRun(
    workspaceId: string,
    prId: string,
    agentIds: string[],
    logger?: Logger,
  ): Promise<MultiAgentRunStartResponse> {
    const pull = await this.repo.getPull(workspaceId, prId);
    if (!pull) throw new NotFoundError('Pull request not found');
    const repo = await this.repo.getRepo(pull.repoId);
    if (!repo) throw new NotFoundError('Repo not found');

    const targets = await new ReviewService(this.container, logger).resolveTargets(workspaceId, { agentIds });

    const groupId = await multiRunRepo.createGroup(this.container.db, { workspaceId, prId });

    const runs: MultiAgentRunStartResponse['runs'] = [];
    const jobs: { agent: AgentRow; runId: string }[] = [];
    for (const agent of targets) {
      const runId = await this.repo.createAgentRun({
        workspaceId,
        agentId: agent.id,
        prId,
        provider: agent.provider,
        model: agent.model,
        multiAgentRunId: groupId,
      });
      runs.push({ run_id: runId, agent_id: agent.id, agent_name: agent.name });
      jobs.push({ agent, runId });
    }

    // Fire-and-forget: the HTTP response returns now with the runIds; the
    // fan-out itself runs in the background through the CONCURRENT executor
    // (the sequential `executeRuns` is never used for a multi-agent group).
    void this.executor.executeRunsConcurrent(workspaceId, pull, repo, jobs, logger).catch((err) => {
      logger?.error({ prId, groupId, err: (err as Error).message }, 'multi-agent-run: background execution crashed');
    });

    return { multi_agent_run_id: groupId, pr_id: prId, runs };
  }

  /**
   * Compose the full read-model for a multi-agent run: one `AgentColumn` per
   * fan-out `agent_runs` row (findings only for 'done' ones), plus
   * cross-agent conflicts computed from the FULL findings (incl. rationale —
   * `computeConflicts` needs it for `ConflictTake.note`; `AgentColumn`'s own
   * `findings` array is the compact `AgentColumnFinding` projection). Returns
   * `undefined` when the group doesn't exist / isn't in this workspace — the
   * caller (route) turns that into a 404.
   */
  async getComposedRun(workspaceId: string, groupId: string): Promise<MultiAgentRun | undefined> {
    const group = await multiRunRepo.getGroupScoped(this.container.db, workspaceId, groupId);
    if (!group) return undefined;

    const runs = await multiRunRepo.listAgentRunsForGroup(this.container.db, groupId);
    const doneRunIds = runs.filter((r) => r.status === 'done').map((r) => r.id);
    const findingsByRun = await multiRunRepo.findingsAndReviewsForRuns(this.container.db, doneRunIds);

    // Agent display names: resolve each distinct agentId once (mirrors
    // `ReviewService.reviewsForPull`'s `names` Map pattern).
    const names = new Map<string, string>();
    for (const run of runs) {
      if (run.agentId && !names.has(run.agentId)) {
        const agent = await this.agents.getById(workspaceId, run.agentId);
        if (agent) names.set(run.agentId, agent.name);
      }
    }

    const columns: AgentColumn[] = [];
    const matcherColumns: MatcherColumn[] = [];
    for (const run of runs) {
      const status = toColumnStatus(run.status);
      const rf = findingsByRun.get(run.id);
      // `agent_id`/`agent_name` are non-nullable in the frozen AgentColumn
      // contract; `agent_runs.agent_id` is nullable (agent deleted after the
      // run) — fall back to an empty id / placeholder name rather than throw.
      const agentId = run.agentId ?? '';
      const agentName = run.agentId ? (names.get(run.agentId) ?? 'Unknown agent') : 'Unknown agent';

      const compactFindings: AgentColumnFinding[] = (rf?.findings ?? []).map((f) => ({
        id: f.id,
        severity: f.severity as Severity,
        category: f.category,
        title: f.title,
        file: f.file,
        start_line: f.startLine,
        kind: f.kind ?? null,
      }));

      columns.push({
        run_id: run.id,
        agent_id: agentId,
        agent_name: agentName,
        provider: run.provider,
        model: run.model,
        status,
        verdict: rf?.review.verdict ?? null,
        score: rf?.review.score ?? null,
        summary: rf?.review.summary ?? null,
        duration_ms: run.durationMs ?? null,
        cost_usd: run.costUsd ?? null,
        // AC-17: `error` is the dedicated failure-reason carrier (never
        // `summary` — no `reviews` row exists for a failed/cancelled run, so
        // `summary` stays null there; see the 2026-07-09 client/insights.md
        // entry this closes). Naturally null for a 'done' run.
        error: run.error ?? null,
        // AC-33: per-agent token usage, straight from the full-row select.
        tokens_in: run.tokensIn ?? null,
        tokens_out: run.tokensOut ?? null,
        findings: compactFindings,
      });

      const matcherFindings: MatcherFinding[] = (rf?.findings ?? []).map((f) => ({
        file: f.file,
        start_line: f.startLine,
        severity: f.severity as Severity,
        title: f.title,
        rationale: f.rationale,
      }));
      matcherColumns.push({ agent_id: agentId, agent_name: agentName, status, findings: matcherFindings });
    }

    // `computeConflicts` itself gates on "< 2 done columns → []" — call it
    // unconditionally rather than re-implementing the same gate here.
    const conflicts = computeConflicts(matcherColumns);

    // Full per-run findings for the Tabs view + reused RunTraceDrawer — the
    // page's SINGLE finding-detail source, so it never has to fall back to the
    // PR-detail `reviewsForPull` (which excludes multi-agent fan-out runs and
    // would leave the drawer/Tabs showing an empty list while columns show
    // findings). Only 'done' runs have a review/findings, so absent run_ids map
    // to [] on the client.
    const findings_by_run: Record<string, FindingRecord[]> = {};
    for (const [runId, rf] of findingsByRun) {
      findings_by_run[runId] = rf.findings.map(findingRowToDto);
    }

    return {
      id: group.id,
      pr_id: group.prId,
      pr_number: group.prNumber,
      ran_at: group.ranAt.toISOString(),
      agent_count: runs.length,
      total_duration_ms: computeTotalDurationMs(group.ranAt, runs),
      total_cost_usd: computeTotalCostUsd(runs),
      total_tokens_in: computeTotalTokensIn(runs),
      total_tokens_out: computeTotalTokensOut(runs),
      columns,
      conflicts,
      findings_by_run,
    };
  }

  /**
   * Pre-run cost/duration estimate per enabled agent, averaged over each
   * agent's last (up to) 3 successful ('done') runs against this PR's repo.
   * An agent with no successful history returns nulls + `sample_size: 0`
   * (AC-7) — never conflated with another agent's real numbers.
   */
  async estimatesForPr(workspaceId: string, prId: string): Promise<AgentEstimate[]> {
    const pull = await this.repo.getPull(workspaceId, prId);
    if (!pull) throw new NotFoundError('Pull request not found');

    const agents = await this.agents.listEnabled(workspaceId);
    const estimates: AgentEstimate[] = [];
    for (const agent of agents) {
      const rows = await this.repo.lastSuccessfulRuns({
        workspaceId,
        agentId: agent.id,
        repoId: pull.repoId,
        limit: 3,
      });
      if (rows.length === 0) {
        estimates.push({ agent_id: agent.id, avg_duration_ms: null, avg_cost_usd: null, sample_size: 0 });
        continue;
      }
      const avgDurationMs = rows.reduce((sum, r) => sum + r.durationMs, 0) / rows.length;
      const knownCostRows = rows.filter((r): r is { durationMs: number; costUsd: number } => r.costUsd != null);
      const avgCostUsd =
        knownCostRows.length > 0
          ? knownCostRows.reduce((sum, r) => sum + r.costUsd, 0) / knownCostRows.length
          : null;
      estimates.push({
        agent_id: agent.id,
        avg_duration_ms: Math.round(avgDurationMs),
        avg_cost_usd: avgCostUsd,
        sample_size: rows.length,
      });
    }
    return estimates;
  }
}

/** DB `agent_runs.status` ('running'|'done'|'failed'|'cancelled'|null) mapped
 *  to the frozen `AgentColumn.status` enum — 'cancelled' displays as 'failed'
 *  (observability.ts has no 'cancelled' column status). */
function toColumnStatus(status: string | null): 'done' | 'failed' | 'running' {
  if (status === 'done') return 'done';
  if (status === 'failed' || status === 'cancelled') return 'failed';
  return 'running';
}

/**
 * `total_cost_usd` is null when cost is unknown for AT LEAST ONE column — sum
 * only when EVERY run has a known (non-null) `cost_usd`.
 */
function computeTotalCostUsd(runs: { costUsd: number | null }[]): number | null {
  if (runs.some((r) => r.costUsd == null)) return null;
  return runs.reduce((sum, r) => sum + (r.costUsd as number), 0);
}

/**
 * `total_tokens_in`/`total_tokens_out` follow the SAME null-if-any-unknown
 * rule as `total_cost_usd` above (AC-33) — null when ANY column's respective
 * token count is unknown, otherwise the sum across all columns. Two separate
 * functions (not a shared generic) to mirror `computeTotalCostUsd`'s own
 * shape exactly, per the plan's explicit instruction not to invent a
 * different rule.
 */
function computeTotalTokensIn(runs: { tokensIn: number | null }[]): number | null {
  if (runs.some((r) => r.tokensIn == null)) return null;
  return runs.reduce((sum, r) => sum + (r.tokensIn as number), 0);
}

function computeTotalTokensOut(runs: { tokensOut: number | null }[]): number | null {
  if (runs.some((r) => r.tokensOut == null)) return null;
  return runs.reduce((sum, r) => sum + (r.tokensOut as number), 0);
}

/**
 * While any run is still 'running': elapsed wall-clock since the group
 * started (unchanged — see the "still running" branch below).
 *
 * Once every run has settled, `max(run.ran_at + run.duration_ms) -
 * group.ran_at` (the original formula) UNDERCOUNTS whenever the group's
 * agent count exceeds `MULTI_AGENT_CONCURRENCY_CAP`: `agent_runs.ran_at` is
 * stamped at row-CREATION time (`createAgentRun`, called up front for every
 * job in `MultiRunService.startRun`'s loop, BEFORE the concurrency-capped
 * worker pool ever dequeues any of them), while `duration_ms` measures only
 * the job's ACTIVE execution window — `Date.now() - start`, where `start` is
 * captured inside `runOneAgent` at the moment the job is actually dequeued
 * (`run-executor.ts`'s `runWithConcurrencyCap`). For a job queued behind the
 * cap, `ran_at + duration_ms` therefore reconstructs to LESS than its real
 * finish time — it silently omits the queueing wait. `agent_runs` has no
 * persisted "dequeued/started executing at" timestamp to reconstruct the
 * real finish time directly, so instead this simulates the worker pool's
 * schedule via greedy list scheduling: `runWithConcurrencyCap` assigns jobs
 * to at most `MULTI_AGENT_CONCURRENCY_CAP` workers, each worker picking up
 * the next unassigned job (in `runs`' own order — `ran_at ASC`, i.e.
 * creation/dispatch order, per `listAgentRunsForGroup`) as soon as it frees
 * up. Replaying that with only each run's own `duration_ms` (no wall-clock
 * reconstruction needed) reproduces the pool's real makespan exactly, and
 * is IDENTICAL to the original `max(duration_ms)` result whenever the agent
 * count is at or under the cap (every job then starts at t≈0, since nothing
 * is queued).
 */
function computeTotalDurationMs(
  groupRanAt: Date,
  runs: { status: string | null; ranAt: Date; durationMs: number | null }[],
): number {
  const groupStart = groupRanAt.getTime();
  const anyRunning = runs.some((r) => toColumnStatus(r.status) === 'running');
  if (anyRunning || runs.length === 0) {
    return Math.max(0, Date.now() - groupStart);
  }

  const workerCount = Math.max(1, Math.min(MULTI_AGENT_CONCURRENCY_CAP, runs.length));
  // `workerFreeAt[i]` = elapsed ms (relative to pool start) at which worker i
  // becomes free. Each run is assigned to whichever worker frees up earliest
  // — exactly what `runWithConcurrencyCap`'s shared-cursor `while` loop does
  // in practice.
  const workerFreeAt: number[] = new Array(workerCount).fill(0);
  for (const run of runs) {
    let idx = 0;
    for (let i = 1; i < workerFreeAt.length; i++) {
      if (workerFreeAt[i]! < workerFreeAt[idx]!) idx = i;
    }
    workerFreeAt[idx] = workerFreeAt[idx]! + (run.durationMs ?? 0);
  }
  const makespan = Math.max(...workerFreeAt);
  return Math.max(0, makespan);
}
