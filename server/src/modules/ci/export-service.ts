import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import PQueue from 'p-queue';
import type {
  CiExportPreviewInput,
  CiExportPreview,
  CiExportInput,
  CiExport,
  CiInstallation,
  CiBulkUpdateResult,
  CiBulkUpdateOutcome,
  CiDisconnectResult,
  CiAgentSurface,
  CiRunStatus,
  RepoRef,
} from '@devdigest/shared';
import type { Container } from '../../platform/container.js';
import { AppError, NotFoundError, ValidationError } from '../../platform/errors.js';
import * as t from '../../db/schema.js';
import type { AgentRow } from '../../db/rows.js';
import { InstallationsRepository, type CiInstallationRow } from './repository/installations.repo.js';
import { RunsRepository, type CiRunRow } from './repository/runs.repo.js';
import { composeCiFiles, slugify } from './helpers.js';
import type { ManifestAgentInput } from './manifest.js';

/**
 * `ExportService` — CI producer: preview, publish (open_pr/files), bulk-update,
 * disconnect, and the agent-level CI surface (Export-to-CI plan, Step 7).
 *
 * All GitHub/RunnerBundler access goes through `container.github()` /
 * `container.runnerBundler` — never a concrete adapter import here
 * (backend-onion-architecture R2/AP-2).
 */

// One fixed branch for every installation — v1 is one agent per repository
// (§1 design decision, Export-to-CI plan), so a single stable branch name is
// always sufficient; there is never a need to disambiguate between multiple
// installations in the same target repo.
const CI_BRANCH = 'devdigest/ci';

// Must match the path `composeCiFiles` (helpers.ts) assembles the workflow
// file at — used only to pull the actual (generated-or-overridden) workflow
// text back out of the composed `CiFile[]` for persistence.
const CI_WORKFLOW_PATH = '.github/workflows/devdigest-review.yml';

const BULK_UPDATE_CONCURRENCY = 3;

const CI_SURFACE_WINDOW_DAYS = 7;

/**
 * `exportInstallation` returns the plain persisted `CiExport` — nothing more.
 * It deliberately NEVER echoes the OpenRouter secret back to the client: that
 * value is a live credential the user already holds (they configured it in
 * Settings), and re-emitting it into the browser DOM/clipboard is a needless
 * leak. The client only needs the secret's NAME (`OPENROUTER_API_KEY`) to tell
 * the user which GitHub Actions secret to add — the value never leaves the
 * server.
 */
export type CiExportResult = CiExport;

function parseRepoFullName(repo: string): RepoRef {
  const [owner, name] = repo.split('/');
  if (!owner || !name) {
    throw new ValidationError(`Invalid repo format: "${repo}" (expected "owner/name")`);
  }
  return { owner, name };
}

/**
 * `slugify(name)` can return `''` for an agent name with zero ASCII
 * alphanumeric characters after lowercasing (e.g. emoji-only or
 * non-Latin-script — agent names only require non-empty, no ASCII
 * requirement, so this is reachable). An empty slug would produce a
 * malformed manifest path (`.devdigest/agents/.yaml`) and persist as
 * `ci_installations.slug = ''`. `slugify` itself is deliberately left
 * returning `''` for this input (that's its own correct, documented
 * behavior) — the fallback to a stable, always-non-empty default belongs
 * HERE, in the caller that derives a slug from an agent name. Use this
 * everywhere `resolveInstallationTarget` computes a slug from `agentName`.
 */
function slugFor(name: string, agentId: string): string {
  return slugify(name) || `agent-${agentId.slice(0, 8)}`;
}

function toManifestAgentInput(agent: AgentRow): ManifestAgentInput {
  return {
    name: agent.name,
    provider: agent.provider,
    model: agent.model,
    systemPrompt: agent.systemPrompt,
    strategy: agent.strategy,
    ciFailOn: agent.ciFailOn,
  };
}

function toCiInstallationDto(
  row: CiInstallationRow,
  latestRunStatus: CiRunStatus | null,
  latestRunAt: string | null = null,
): CiInstallation {
  return {
    id: row.id,
    agent_id: row.agentId,
    repo: row.repo,
    target_type: row.targetType,
    installed_at: row.installedAt.toISOString(),
    slug: row.slug,
    workflow_version: row.workflowVersion,
    disconnected_at: row.disconnectedAt ? row.disconnectedAt.toISOString() : null,
    triggers: row.triggers,
    post_as: row.postAs,
    latest_run_status: latestRunStatus,
    latest_run_at: latestRunAt,
  };
}

function exportPrBody(agentName: string): string {
  return [
    `This PR adds a DevDigest CI review workflow for the **${agentName}** agent.`,
    '',
    'Once merged, DevDigest automatically reviews new pull requests via GitHub Actions.',
    '',
    "Before merging, add the `OPENROUTER_API_KEY` secret to this repository's Actions " +
      'secrets (Settings → Secrets and variables → Actions).',
  ].join('\n');
}

export class ExportService {
  private _installationsRepo: InstallationsRepository | null = null;
  private _runsRepo: RunsRepository | null = null;

  /**
   * `installationsRepo`/`runsRepo` overrides are for unit tests only (mirrors
   * `BlastService`'s `repo?` constructor override) — every production caller
   * constructs with just `container` and relies on the lazy getters below.
   */
  constructor(
    private container: Container,
    installationsRepo?: InstallationsRepository,
    runsRepo?: RunsRepository,
  ) {
    if (installationsRepo) this._installationsRepo = installationsRepo;
    if (runsRepo) this._runsRepo = runsRepo;
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
   * Workspace-scoped repo existence check (AC-1's real enforcement point —
   * only a repo already tracked/connected in this workspace may be exported
   * to). There is no `container.reposRepo` facade (only `agentsRepo` /
   * `reviewRepo` / `skillsRepo` / `evalRepo` are exposed on `Container`), and
   * this step's owned paths are limited to this single file — so this mirrors
   * `RepoRepository.getById`'s exact query directly against `t.repos` rather
   * than importing that module's repository class (module isolation,
   * backend-onion-architecture R6/AP-4: a module may query shared schema
   * directly, it just may not import another module's `repository.ts`).
   */
  private async getRepoRow(
    workspaceId: string,
    repoId: string,
  ): Promise<{ id: string; fullName: string } | undefined> {
    const rows = await this.container.db
      .select({ id: t.repos.id, fullName: t.repos.fullName })
      .from(t.repos)
      .where(and(eq(t.repos.workspaceId, workspaceId), eq(t.repos.id, repoId)))
      .limit(1);
    return rows[0];
  }

  /**
   * One-agent-per-repo resolution (§1 design decision, Export-to-CI plan).
   * Shared by `previewFiles` and `exportInstallation` so the conflict rule is
   * enforced in exactly one place, never duplicated.
   *
   * A DISCONNECTED installation is a FULLY FREE slot (confirmed product
   * decision) — any agent, including a different one, may claim it. Only an
   * ACTIVE installation belonging to a different agent is a genuine conflict.
   * This SERVICE-level check is a fast, user-facing rejection; the DB-level
   * `setWhere` guard in `upsertPublished` (installations.repo.ts) is the
   * atomic second enforcement point that actually closes the TOCTOU race
   * between two near-simultaneous calls for the same repo.
   */
  private async resolveInstallationTarget(
    workspaceId: string,
    repo: string,
    agentId: string,
    agentName: string,
  ): Promise<{ id: string; slug: string; existing: CiInstallationRow | undefined }> {
    const existing = await this.installationsRepo.findByRepo(workspaceId, repo);

    if (existing && existing.disconnectedAt === null && existing.agentId !== agentId) {
      // Name the specific agent (and repo) holding the slot so the user knows
      // exactly what to disconnect — "a different agent" left them guessing
      // which of their agents owns this repository.
      const conflicting = await this.container.agentsRepo.getById(workspaceId, existing.agentId);
      const forWhom = conflicting ? `the "${conflicting.name}" agent` : 'a different agent';
      throw new AppError(
        'repo_already_installed',
        `${repo} already has DevDigest installed for ${forWhom}. ` +
          'Disconnect it from this repository first, or choose another repository.',
        409,
      );
    }

    if (existing && existing.agentId === agentId) {
      // Re-exporting (active) or reconnecting (disconnected) the SAME
      // agent's own installation correctly reuses this id/slug below — the
      // frozen slug invariant applies. `upsertPublished` (installations.repo.ts)
      // unconditionally clears `disconnected_at` in its conflict SET list on
      // every successful publish, so `listTracked()` (the ingest check loop)
      // and `active_count` (`getAgentCiSurface`) immediately treat a
      // reconnected installation as active again.
      return { id: existing.id, slug: existing.slug, existing };
    }

    if (existing) {
      // Takeover: `existing` is disconnected AND belongs to a DIFFERENT
      // agent. Reuse the SAME row (one-row-per-repo invariant — never a
      // second installation for this repo) but the slug must NOT carry
      // over: it named the abandoned agent, not this one. This is the one
      // case where the "frozen slug" invariant does not apply — it's a new
      // agent claiming an abandoned installation, not a rename of the same
      // one.
      return { id: existing.id, slug: slugFor(agentName, agentId), existing };
    }

    return { id: randomUUID(), slug: slugFor(agentName, agentId), existing: undefined };
  }

  /**
   * No-side-effect preview: no DB write, no GitHub call. Uses a placeholder
   * empty string for the runner bundle (never shown to the user, AC-37).
   */
  async previewFiles(
    workspaceId: string,
    repoId: string,
    agentId: string,
    input: CiExportPreviewInput,
  ): Promise<CiExportPreview> {
    const repoRow = await this.getRepoRow(workspaceId, repoId);
    if (!repoRow) throw new NotFoundError('Repo not found');

    const agent = await this.container.agentsRepo.getById(workspaceId, agentId);
    if (!agent) throw new NotFoundError('Agent not found');

    const linked = await this.container.agentsRepo.linkedSkills(agentId);
    const skills = linked
      .filter((l) => l.skill.enabled)
      .map((l) => ({ name: l.skill.name, body: l.skill.body }));

    // Preview has no `repo` input field of its own — the repo string comes
    // from the route-param-resolved row, not from the caller's body.
    const { slug } = await this.resolveInstallationTarget(
      workspaceId,
      repoRow.fullName,
      agentId,
      agent.name,
    );

    const files = composeCiFiles({
      slug,
      agent: toManifestAgentInput(agent),
      skills,
      triggers: input.triggers,
      postAs: input.post_as,
      workflowOverride: undefined,
      runnerBundleContents: '',
    });

    return { files };
  }

  /**
   * Full publish flow: validate → resolve target → build bundle → compose
   * files → (open_pr | files) → persist. The persisting write
   * (`upsertPublished`) is the LAST step, and only runs after any GitHub call
   * has succeeded (AC-12 — no installation recorded on failure).
   */
  async exportInstallation(
    workspaceId: string,
    repoId: string,
    agentId: string,
    input: CiExportInput,
  ): Promise<CiExportResult> {
    const repoRow = await this.getRepoRow(workspaceId, repoId);
    if (!repoRow) throw new NotFoundError('Repo not found');

    const agent = await this.container.agentsRepo.getById(workspaceId, agentId);
    if (!agent) throw new NotFoundError('Agent not found');

    // The exported workflow runs the reviewer with
    // `${{ secrets.OPENROUTER_API_KEY }}`, so refuse to export until the user
    // has actually configured that key — but this is a presence check ONLY.
    // The value must never be read beyond this guard or returned to the client
    // (see the CiExportResult note above).
    const hasOpenRouterKey = await this.container.secrets.get('OPENROUTER_API_KEY');
    if (!hasOpenRouterKey) {
      throw new ValidationError('Configure an OpenRouter API key in Settings before exporting to CI');
    }

    // `repoRow.fullName` (never `input.repo`) is the identity used from here
    // on — the actual GitHub target and the value stored on `ci_installations`
    // — exactly mirroring `previewFiles` above. `input.repo` is still accepted
    // on the wire (frozen `CiExportInput` contract, never edited) but must
    // never be trusted for anything identity-critical: `repoId`'s existence
    // check above is what actually proves the repo is connected to this
    // workspace, and a client-supplied `input.repo` naming a different repo
    // string must never be able to redirect the GitHub calls or the persisted
    // row (AC-1).
    const { id, slug } = await this.resolveInstallationTarget(
      workspaceId,
      repoRow.fullName,
      agentId,
      agent.name,
    );

    const { contents: runnerBundleContents } = await this.container.runnerBundler.build();

    const linked = await this.container.agentsRepo.linkedSkills(agentId);
    const skills = linked
      .filter((l) => l.skill.enabled)
      .map((l) => ({ name: l.skill.name, body: l.skill.body }));

    const files = composeCiFiles({
      slug,
      agent: toManifestAgentInput(agent),
      skills,
      triggers: input.triggers,
      postAs: input.post_as,
      workflowOverride: input.workflow_override ?? undefined,
      runnerBundleContents,
    });

    const repoRef = parseRepoFullName(repoRow.fullName);

    let prUrl: string | null = null;
    if (input.action === 'open_pr') {
      // Any GitHub failure propagates unchanged (no catch here) — AC-12.
      const gh = await this.container.github();
      await gh.commitFiles(repoRef, {
        branch: CI_BRANCH,
        base: input.base,
        message: `chore: configure DevDigest CI review (${agent.name})`,
        files: files.map((f) => ({ path: f.path, contents: f.contents })),
      });
      const openPr = await gh.findOpenPr(repoRef, CI_BRANCH);
      if (openPr) {
        prUrl = openPr.url;
      } else {
        const opened = await gh.openPullRequest(repoRef, {
          title: `Add DevDigest CI review (${agent.name})`,
          head: CI_BRANCH,
          base: input.base,
          body: exportPrBody(agent.name),
        });
        prUrl = opened.url;
      }
    }
    // input.action === 'files': no GitHub call at all — pr_url stays null.

    const workflowContents = files.find((f) => f.path === CI_WORKFLOW_PATH)?.contents ?? '';

    const row = await this.installationsRepo.upsertPublished(workspaceId, id, {
      agentId,
      repo: repoRow.fullName,
      targetType: input.target,
      slug,
      triggers: input.triggers,
      postAs: input.post_as,
      workflowContents,
    });

    return {
      installation: toCiInstallationDto(row, null),
      files,
      pr_url: prUrl,
    };
  }

  /**
   * Refreshes every non-disconnected installation's agent-config/skills/
   * memory files from the agent's CURRENT state, reusing each installation's
   * own frozen `slug` and stored `workflowContents` verbatim (never
   * regenerated, never a new PR — AC-40/AC-41). Each installation's outcome is
   * independent: one GitHub failure must not abort the others.
   */
  async bulkUpdate(workspaceId: string, agentId: string): Promise<CiBulkUpdateResult> {
    const agent = await this.container.agentsRepo.getById(workspaceId, agentId);
    if (!agent) throw new NotFoundError('Agent not found');

    const all = await this.installationsRepo.listByAgent(workspaceId, agentId);
    const active = all.filter((inst) => inst.disconnectedAt === null);
    // Nothing to do — skip the bundle build and GitHub client construction
    // entirely rather than paying for both just to map an empty array.
    if (active.length === 0) return { results: [] };

    const linked = await this.container.agentsRepo.linkedSkills(agentId);
    const skills = linked
      .filter((l) => l.skill.enabled)
      .map((l) => ({ name: l.skill.name, body: l.skill.body }));

    // Built ONCE, shared across every installation in this call.
    const { contents: runnerBundleContents } = await this.container.runnerBundler.build();
    const gh = await this.container.github();
    const manifestAgent = toManifestAgentInput(agent);

    const queue = new PQueue({ concurrency: BULK_UPDATE_CONCURRENCY });
    const results = await Promise.all(
      active.map((inst) =>
        // `throwOnTimeout: true` selects p-queue's non-`void` `.add()` overload
        // (irrelevant to actual behavior here — no per-task timeout is set,
        // so it never triggers) purely so each task's real return type
        // (`CiBulkUpdateOutcome`, never `void`) is preserved.
        queue.add(async (): Promise<CiBulkUpdateOutcome> => {
          try {
            const files = composeCiFiles({
              slug: inst.slug,
              agent: manifestAgent,
              skills,
              triggers: inst.triggers,
              postAs: inst.postAs,
              // Reuse verbatim — bulk-update never regenerates the workflow.
              workflowOverride: inst.workflowContents,
              runnerBundleContents,
            });
            const repoRef = parseRepoFullName(inst.repo);
            // Each installation is a DIFFERENT repo (one agent, many
            // installations) — the real default branch must be resolved
            // PER installation, never assumed/shared across the batch.
            const base = await gh.getDefaultBranch(repoRef);
            await gh.commitFiles(repoRef, {
              branch: CI_BRANCH,
              base,
              message: `chore: update DevDigest CI config (${agent.name})`,
              files: files.map((f) => ({ path: f.path, contents: f.contents })),
            });
            // Make the regenerated config actually LAND: reuse the still-open
            // export PR if one exists, otherwise open a fresh one. AC-40's
            // literal "never open a new PR" assumed the original export PR stays
            // open — but the real flow merges it, and after that a commit to
            // `devdigest/ci` alone strands the update on a branch with nothing to
            // merge (the running workflow keeps the OLD config while the UI still
            // reports "updated"). This is a deliberate, user-approved deviation
            // from AC-40 that mirrors single-export's find-or-open behaviour
            // (AC-9/AC-10), so repeated bulk updates reuse ONE PR instead of
            // stacking duplicates.
            const openPr = await gh.findOpenPr(repoRef, CI_BRANCH);
            const prUrl = openPr
              ? openPr.url
              : (
                  await gh.openPullRequest(repoRef, {
                    title: `Update DevDigest CI config (${agent.name})`,
                    head: CI_BRANCH,
                    base,
                    body: exportPrBody(agent.name),
                  })
                ).url;
            await this.installationsRepo.upsertPublished(workspaceId, inst.id, {
              agentId,
              repo: inst.repo,
              targetType: inst.targetType,
              slug: inst.slug,
              triggers: inst.triggers,
              postAs: inst.postAs,
              workflowContents: inst.workflowContents,
            });
            return { installation_id: inst.id, ok: true, pr_url: prUrl, error: null };
          } catch (err) {
            // Isolated per-installation — one failure never aborts the rest
            // (AC-41), and a failed installation's row is left untouched.
            return {
              installation_id: inst.id,
              ok: false,
              pr_url: null,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }, { throwOnTimeout: true }),
      ),
    );

    return { results };
  }

  /** No GitHub/file-system side effect whatsoever (AC-14). */
  async disconnect(workspaceId: string, installationId: string): Promise<CiDisconnectResult> {
    const row = await this.installationsRepo.disconnect(workspaceId, installationId);
    if (!row) throw new NotFoundError('Installation not found');
    return { installation: toCiInstallationDto(row, null) };
  }

  /**
   * Agent-level CI surface: every installation (including disconnected —
   * `active_count` counts only non-disconnected, AC-47) + a 7-day rollup +
   * each installation's `latest_run_status`. The rollup (`last_7_days`) and
   * `latest_run_status` are deliberately computed from TWO SEPARATE
   * `runsRepo.list` queries — one windowed, one not (see below) — never a
   * per-installation round trip.
   */
  async getAgentCiSurface(workspaceId: string, agentId: string): Promise<CiAgentSurface> {
    const installations = await this.installationsRepo.listByAgent(workspaceId, agentId);
    const activeCount = installations.filter((inst) => inst.disconnectedAt === null).length;

    const runs = await this.runsRepo.list(workspaceId, {
      agentId,
      sinceDays: CI_SURFACE_WINDOW_DAYS,
    });

    const totalFindings = runs.reduce((sum, r) => sum + (r.findingsCount ?? 0), 0);
    const costs = runs.map((r) => r.costUsd).filter((c): c is number => c != null);
    const totalCost = costs.length > 0 ? costs.reduce((a, b) => a + b, 0) : null;

    // `latest_run_status` must reflect the TRUE latest run per installation
    // regardless of age (the `CiInstallation.latest_run_status` contract's own
    // doc comment: "computed from the latest ingested ci_runs row" — no
    // window qualifier). An installation whose most recent run is older than
    // the 7-day window must NOT show `null` (indistinguishable from "never
    // run"). This is a SECOND, UNWINDOWED query — the windowed `runs` above
    // is untouched and still drives ONLY the `last_7_days` rollup numbers.
    const allRuns = await this.runsRepo.list(workspaceId, { agentId });

    // Latest run per installation: group by ci_installation_id, keep the max ran_at.
    const latestByInstallation = new Map<string, CiRunRow>();
    for (const run of allRuns) {
      if (!run.ciInstallationId) continue;
      const current = latestByInstallation.get(run.ciInstallationId);
      if (!current || (run.ranAt && (!current.ranAt || run.ranAt > current.ranAt))) {
        latestByInstallation.set(run.ciInstallationId, run);
      }
    }

    return {
      installations: installations.map((inst) => {
        const latest = latestByInstallation.get(inst.id);
        const status = latest?.status ? (latest.status as CiRunStatus) : null;
        const latestRunAt = latest?.ranAt ? latest.ranAt.toISOString() : null;
        return toCiInstallationDto(inst, status, latestRunAt);
      }),
      active_count: activeCount,
      last_7_days: {
        runs: runs.length,
        findings: totalFindings,
        cost_usd: totalCost,
      },
    };
  }
}
