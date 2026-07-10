import type { Container } from '../../platform/container.js';
import { ExternalServiceError } from '../../platform/errors.js';
import { withTimeout, TimeoutError } from '../../platform/resilience.js';
import type {
  GitHubClient,
  RepoRef,
  CiCheckResult,
  CiRunsResponse,
  CiRun,
  CiResultArtifact,
} from '@devdigest/shared';
import { InstallationsRepository, type CiInstallationRow } from './repository/installations.repo.js';
import {
  RunsRepository,
  type CiRunRow,
  type CiRunUpsertValues,
  type CiRunsListFilters,
} from './repository/runs.repo.js';
import { CI_RESULT_ARTIFACT_NAME } from './helpers.js';
import { parseResultArtifact, mapGithubRunToStatus } from './ingest-helpers.js';

/** Wall-clock budget for one full `checkForNewResults` call (AC-27). */
const CHECK_TIMEOUT_MS = 30_000;

/**
 * Every installation generates the exact same single workflow file in its
 * own repo (flat, one-agent-per-repo layout, §1 of the plan) — fixed, never
 * derived per-installation.
 */
const WORKFLOW_FILE = 'devdigest-review.yml';

const RUNS_PER_PAGE = 10;

/**
 * `ci_runs.status` values that can never change once GitHub reports a run as
 * `completed` — used by `resolveRunValues` to skip a redundant artifact
 * re-download for a run already fully ingested on a prior poll (AC-27
 * budget). Mirrors `CiRunStatus` minus `'running'` (the one non-terminal
 * value); compared as plain strings since `ci_runs.status` is untyped text
 * at the DB layer, same as `CiRunUpsertValues.status`.
 */
const TERMINAL_STATUSES = new Set<string>(['succeeded', 'failed', 'no_findings', 'skipped_fork']);

/** One element of `GitHubClient.listWorkflowRuns`'s return array. */
type WorkflowRun = Awaited<ReturnType<GitHubClient['listWorkflowRuns']>>[number];

/**
 * Minimal structured logger (pino-compatible: (obj, msg)) for runtime logs.
 * Redeclared locally rather than imported from another module — a type-only
 * cross-module import still couples the two modules' file graphs (see
 * server/insights.md 2026-07-06 Quirk on this exact tradeoff).
 */
type Logger = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
  debug: (obj: unknown, msg?: string) => void;
};

/**
 * Splits a stored `"owner/name"` installation `repo` string into a `RepoRef`.
 * Defensive, never throws — a malformed string (no `/`) yields `{owner: repo, name: ''}`
 * rather than crashing the whole check loop over one bad row.
 */
function parseRepoRef(repo: string): RepoRef {
  const idx = repo.indexOf('/');
  if (idx === -1) return { owner: repo, name: '' };
  return { owner: repo.slice(0, idx), name: repo.slice(idx + 1) };
}

/** Maps a persisted `ci_runs` row to its API-facing DTO. */
function toCiRunDto(row: CiRunRow): CiRun {
  return {
    id: row.id,
    ci_installation_id: row.ciInstallationId,
    pr_number: row.prNumber,
    pr_title: row.prTitle ?? null,
    ran_at: row.ranAt ? row.ranAt.toISOString() : null,
    status: row.status,
    findings_count: row.findingsCount,
    critical: row.critical,
    warning: row.warning,
    suggestion: row.suggestion,
    cost_usd: row.costUsd,
    github_url: row.githubUrl,
    source: row.source,
    agent: row.agent,
    duration_s: row.durationS,
    repo: row.repo,
  };
}

/**
 * IngestService — pulls GitHub Actions workflow-run + result-artifact data
 * for every tracked CI installation in a workspace and upserts `ci_runs`
 * rows (`checkForNewResults`), plus a thin read path over the persisted
 * history (`listRuns`).
 *
 * SECURITY BOUNDARY (AC-22): every upserted row's `repo`/`agent` snapshot
 * comes ONLY from the installation/agent the server itself queried — NEVER
 * from the parsed artifact's own `agent`/`pr_number` fields. Those fields are
 * the runner's own self-report and are never a trust source for attribution.
 */
export class IngestService {
  private _installationsRepo: InstallationsRepository | null = null;
  private _runsRepo: RunsRepository | null = null;
  private logger: Logger;

  constructor(private container: Container, logger?: Logger) {
    this.logger = logger ?? console;
  }

  private get installationsRepo(): InstallationsRepository {
    if (!this._installationsRepo) {
      this._installationsRepo = new InstallationsRepository(this.container.db);
    }
    return this._installationsRepo;
  }

  private get runsRepo(): RunsRepository {
    if (!this._runsRepo) {
      this._runsRepo = new RunsRepository(this.container.db);
    }
    return this._runsRepo;
  }

  /**
   * Pulls the last `RUNS_PER_PAGE` workflow runs for every non-disconnected
   * installation in `workspaceId`, upserts a `ci_runs` row per run, and marks
   * the workspace's "last checked at" marker once every installation has
   * been ATTEMPTED (not necessarily succeeded — see `runCheckLoop`'s
   * per-installation try/catch: one installation's own failure degrades only
   * that installation, it never aborts the others or skips the marker). The
   * whole body is additionally bounded by a 30s wall-clock timeout (AC-27) —
   * a genuine cut-short by that outer budget is the only case that must NOT
   * reach the "last checked at" write at all; a timeout is rethrown as a
   * client-facing `ExternalServiceError` rather than leaking the internal
   * `TimeoutError`.
   */
  async checkForNewResults(workspaceId: string): Promise<CiCheckResult> {
    try {
      return await withTimeout(this.runCheckLoop(workspaceId), CHECK_TIMEOUT_MS);
    } catch (err) {
      if (err instanceof TimeoutError) {
        throw new ExternalServiceError('CI check timed out after 30s');
      }
      throw err;
    }
  }

  private async runCheckLoop(workspaceId: string): Promise<CiCheckResult> {
    const gh = await this.container.github();
    const installations = await this.installationsRepo.listTracked(workspaceId);
    const updatedRows: CiRunRow[] = [];
    // Accumulated for the summary log line below — never surfaced on the
    // (frozen) CiCheckResult contract, but keeps the "N installations
    // degraded this check" fact somewhere a caller could extend into later.
    const failures: { installationId: string; error: unknown }[] = [];

    for (const installation of installations) {
      try {
        const repoRef = parseRepoRef(installation.repo);
        // One agent lookup per installation is fine — this loop already does
        // one GitHub round-trip per installation anyway.
        const agent = await this.container.agentsRepo.getById(workspaceId, installation.agentId);
        const agentName = agent?.name ?? null;

        const runs = await gh.listWorkflowRuns(repoRef, WORKFLOW_FILE, { perPage: RUNS_PER_PAGE });

        // AC-27 budget: consult every observed run's ALREADY-PERSISTED
        // status/findings ONCE per installation (not once per run), so
        // `resolveRunValues` can skip a redundant artifact re-download for a
        // run whose terminal outcome was already fully ingested on a prior
        // poll — see that method's own doc comment.
        const priorStatuses = await this.runsRepo.statusesByGithubRunId(
          workspaceId,
          runs.map((run) => String(run.id)),
        );

        for (const run of runs) {
          const values = await this.resolveRunValues(
            gh,
            repoRef,
            run,
            installation,
            agentName,
            priorStatuses.get(String(run.id)),
          );
          // `null` = nothing new to persist (already fully ingested with a
          // real artifact on a prior poll) — skip the upsert entirely.
          if (values === null) continue;
          const row = await this.runsRepo.upsertByGithubRunId(
            workspaceId,
            installation.id,
            String(run.id),
            values,
          );
          updatedRows.push(row);
        }
      } catch (err) {
        // One installation's failure — its GitHub repo renamed/deleted/
        // inaccessible (404/403), a lost token scope, or (via
        // upsertByGithubRunId) a cross-workspace github_run_id collision
        // surfacing as ConfigError — must never abort the check for every
        // OTHER installation in this workspace. Mirrors resolveArtifact's
        // own per-run isolation one level up (server/insights.md 2026-07-10
        // Decision). Log and move on to the next installation; the loop as a
        // whole still completes its full pass, so setLastCheckedAt below
        // still fires even though this one installation is degraded.
        failures.push({ installationId: installation.id, error: err });
        this.logger.error(
          {
            installationId: installation.id,
            repo: installation.repo,
            err: err instanceof Error ? err.message : String(err),
          },
          'ci ingest: installation check failed, skipping to the next installation',
        );
      }
    }

    if (failures.length > 0) {
      this.logger.warn(
        { failedInstallations: failures.length, totalInstallations: installations.length, workspaceId },
        'ci ingest: check completed with one or more degraded installations',
      );
    }

    // Reached once the loop has finished a full pass over every
    // installation — regardless of whether some were individually degraded
    // above. Deliberately NOT in a `finally` — a genuine cut-short (the
    // `withTimeout` race in `checkForNewResults` losing) must never mark a
    // check as having completed at all, which is a different concern from
    // "some installations failed but every installation was still
    // attempted" (handled by the try/catch above).
    await this.runsRepo.setLastCheckedAt(workspaceId, new Date());

    return {
      checked_at: new Date().toISOString(),
      runs_updated: updatedRows.map(toCiRunDto),
    };
  }

  /**
   * Resolves the full set of upsert values for one observed GitHub run — or
   * `null` when there is nothing new to persist and the caller should skip
   * the upsert entirely.
   *
   * `null` happens only when (AC-27 budget): GitHub reports the run as
   * `completed`, AND `prior` (this run's ALREADY-PERSISTED status from a
   * previous poll, looked up once per installation in `runCheckLoop`) is
   * already a TERMINAL status, AND that persisted row has a real, populated
   * artifact (`findingsCount != null`). A GitHub Actions run's own outcome
   * never changes once completed, so re-downloading its artifact on every
   * subsequent poll is pure waste. `findingsCount == null` deliberately
   * excludes a row that was previously persisted via the DEGRADED
   * null-artifact fallback (`resolveArtifact` returned `null`) — that case
   * must keep retrying on every poll, since the artifact may become
   * available later (e.g. GitHub upload eventual consistency, or a
   * previously-expired-looking artifact that wasn't actually expired).
   */
  private async resolveRunValues(
    gh: GitHubClient,
    repoRef: RepoRef,
    run: WorkflowRun,
    installation: CiInstallationRow,
    agentName: string | null,
    prior: { status: string | null; findingsCount: number | null } | undefined,
  ): Promise<CiRunUpsertValues | null> {
    const shared = {
      ranAt: run.created_at ? new Date(run.created_at) : null,
      githubUrl: run.html_url,
      // AC-22: identity snapshot comes from the installation the server
      // itself queried — never from the artifact.
      repo: installation.repo,
      agent: agentName,
    };

    if (run.status !== 'completed') {
      return {
        ...shared,
        prNumber: null,
        status: 'running',
        findingsCount: null,
        critical: null,
        warning: null,
        suggestion: null,
        costUsd: null,
        durationS: null,
      };
    }

    if (run.conclusion === 'skipped') {
      // No artifact exists for a skipped (fork PR) run — null metrics too.
      return {
        ...shared,
        prNumber: null,
        status: 'skipped_fork',
        findingsCount: null,
        critical: null,
        warning: null,
        suggestion: null,
        costUsd: null,
        durationS: null,
      };
    }

    // AC-27 budget: this run's outcome was already fully ingested (terminal
    // status + a real artifact) on a prior poll — GitHub's own report for a
    // completed run never changes, so skip the artifact re-fetch and the
    // upsert entirely. See this method's doc comment for the exact
    // conditions and why a degraded (null-artifact) prior row is excluded.
    if (prior && TERMINAL_STATUSES.has(prior.status ?? '') && prior.findingsCount != null) {
      return null;
    }

    const artifact = await this.resolveArtifact(gh, repoRef, run.id);
    const durationMs = artifact?.duration_ms;

    return {
      ...shared,
      // Known limitation: `listWorkflowRuns` returns no PR number at all, so
      // this is the ONLY available source; when the artifact itself is
      // unavailable this is also null (documented gap, not worked around).
      prNumber: artifact?.pr_number ?? null,
      status: mapGithubRunToStatus(run, artifact),
      findingsCount: artifact?.findings_count ?? null,
      critical: artifact?.critical ?? null,
      warning: artifact?.warning ?? null,
      suggestion: artifact?.suggestion ?? null,
      costUsd: artifact?.cost_usd ?? null,
      // THE one and only place duration_ms -> duration_s conversion happens.
      durationS: durationMs != null ? Math.round(durationMs / 1000) : null,
    };
  }

  /**
   * Finds and downloads the run's result artifact, selected by the shared
   * `CI_RESULT_ARTIFACT_NAME` constant — never positionally. Degrades to
   * `null` on ANY failure along the way (no name match, a download failure,
   * or a corrupt/invalid payload once downloaded) — mirrors
   * `parseResultArtifact`'s own never-throw contract one level up, so one
   * unreachable/expired artifact can never abort the rest of the check loop
   * for every other run/installation in this call.
   */
  private async resolveArtifact(
    gh: GitHubClient,
    repoRef: RepoRef,
    runId: number,
  ): Promise<CiResultArtifact | null> {
    try {
      const artifacts = await gh.listRunArtifacts(repoRef, runId);
      const matched = artifacts.find((a) => a.name === CI_RESULT_ARTIFACT_NAME);
      if (!matched) return null;
      const buf = await gh.downloadArtifact(repoRef, matched.id);
      return await parseResultArtifact(buf);
    } catch {
      return null;
    }
  }

  /** Run history for a workspace, plus the last successful check's timestamp. */
  async listRuns(workspaceId: string, filters: CiRunsListFilters): Promise<CiRunsResponse> {
    const rows = await this.runsRepo.list(workspaceId, filters);
    const lastCheckedAt = await this.runsRepo.getLastCheckedAt(workspaceId);
    return {
      runs: rows.map(toCiRunDto),
      last_checked_at: lastCheckedAt ? lastCheckedAt.toISOString() : null,
    };
  }
}
