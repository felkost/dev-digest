import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import JSZip from 'jszip';
import type { FastifyInstance } from 'fastify';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import {
  MockGitClient,
  MockGitHubClient,
  MockRunnerBundler,
  MockSecretsProvider,
  type MockWorkflowRun,
} from '../src/adapters/mocks.js';
import { AgentsRepository } from '../src/modules/agents/repository.js';
import type { ContainerOverrides } from '../src/platform/container.js';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  // eslint-disable-next-line no-console
  console.warn('[ci-routes] Docker not available — skipping integration tests.');
}

/**
 * Integration tests for the `ci` module's HTTP surface (Export-to-CI plan,
 * Step 11) — the module's actual routing, workspace scoping, rate limits,
 * and the AC-27 stalled-mock/AC-19-20 dedup/AC-21 discard/AC-13 conflict
 * scenarios that need a real DB round trip to be convincing (per the plan's
 * §8 Testing Plan). Real Postgres via Testcontainers; no mocks for the DB
 * layer — only GitHub/Git/RunnerBundler/Secrets adapters are mocked.
 */
d('ci module routes (Export-to-CI, Step 11)', () => {
  let pg: PgFixture;

  beforeAll(async () => {
    pg = await startPg();
    await seed(pg.handle.db);
  });
  afterAll(async () => {
    await pg?.stop();
  });

  /**
   * Standard app builder — `NODE_ENV: 'test'` (this codebase's usual
   * `.it.test.ts` boilerplate, see `agents-versions.it.test.ts`).
   * `@fastify/rate-limit` is NOT registered under this config (`app.ts` gates
   * its registration on `nodeEnv !== 'test'`, specifically so integration
   * suites can hammer endpoints via `inject()`), so per-route rate limits are
   * inert here — use `makeRateLimitedApp` below for the dedicated 429
   * assertions.
   */
  function makeApp(overrides: ContainerOverrides = {}) {
    const config = loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    return buildApp({
      config,
      db: pg.handle.db,
      overrides: {
        git: new MockGitClient(),
        github: new MockGitHubClient(),
        runnerBundler: new MockRunnerBundler(),
        secrets: new MockSecretsProvider({ OPENROUTER_API_KEY: 'sk-or-test-key' }),
        ...overrides,
      },
    });
  }

  /**
   * Rate-limit-testing app builder. `app.ts` only registers
   * `@fastify/rate-limit` (and therefore only honors any route's
   * `config.rateLimit`) when `nodeEnv !== 'test'`. To genuinely exercise the
   * 2/min per-workspace limits this step adds (rather than asserting only a
   * static config shape), build the app with `NODE_ENV: 'development'`
   * instead — the only other switches gated on that flag are the periodic
   * stale-run-reap cron (harmless: unref'd, 15-minute cadence, never fires
   * during a test) and the default log level (pinned to `'silent'` here
   * explicitly, avoiding the `pino-pretty` dev transport). See
   * server/insights.md for the full audit of `nodeEnv==='test'` branches.
   */
  function makeRateLimitedApp(overrides: ContainerOverrides = {}) {
    const config = loadConfig({
      ...process.env,
      NODE_ENV: 'development',
      LOG_LEVEL: 'silent',
    } as NodeJS.ProcessEnv);
    return buildApp({
      config,
      db: pg.handle.db,
      overrides: {
        git: new MockGitClient(),
        github: new MockGitHubClient(),
        runnerBundler: new MockRunnerBundler(),
        secrets: new MockSecretsProvider({ OPENROUTER_API_KEY: 'sk-or-test-key' }),
        ...overrides,
      },
    });
  }

  async function createRepo(
    app: FastifyInstance,
    fullName: string,
  ): Promise<{ id: string; full_name: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/repos',
      payload: { url: `https://github.com/${fullName}` },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  async function createAgent(app: FastifyInstance, name: string): Promise<{ id: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name,
        provider: 'openai',
        model: 'gpt-4o-mini',
        system_prompt: 'Review the diff for security issues.',
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  // -------------------------------------------------------------------------
  // Full export flow: preview → export-ci (open_pr) → rename → export-ci again
  // -------------------------------------------------------------------------
  it('preview then export-ci: workflow_version increments, id/slug frozen across an agent rename, generated file path unchanged (AC-1, AC-4, AC-5, AC-9, AC-10, AC-11, AC-45)', async () => {
    const github = new MockGitHubClient();
    const app = await makeApp({ github });
    const repo = await createRepo(app, 'acme/widgets-a');
    const agent = await createAgent(app, 'Security Reviewer');

    const preview = await app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/agents/${agent.id}/ci/preview`,
      payload: {},
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().files.length).toBeGreaterThan(0);

    const exportBody = { repo: repo.full_name, action: 'open_pr' };

    const first = await app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/agents/${agent.id}/export-ci`,
      payload: exportBody,
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody.installation.workflow_version).toBe(1);
    expect(firstBody.secret_value).toBe('sk-or-test-key');
    expect(firstBody.pr_url).not.toBeNull();
    const firstManifestPath = firstBody.files.find((f: { path: string }) =>
      f.path.startsWith('.devdigest/agents/'),
    ).path;
    expect(firstManifestPath).toBe(`.devdigest/agents/${firstBody.installation.slug}.yaml`);
    const firstManifestContents = firstBody.files.find(
      (f: { path: string }) => f.path === firstManifestPath,
    ).contents as string;
    expect(firstManifestContents).toContain('Security Reviewer');

    // AC-9: no open PR existed yet, so the first export opens exactly one.
    expect(github.openedPrs).toHaveLength(1);
    expect(github.committed).toHaveLength(1);

    const [row1] = await pg.handle.db
      .select()
      .from(t.ciInstallations)
      .where(eq(t.ciInstallations.id, firstBody.installation.id));
    expect(row1?.workflowVersion).toBe(1);

    // Rename the agent between the two exports — the file path must not shift.
    const rename = await app.inject({
      method: 'PUT',
      url: `/agents/${agent.id}`,
      payload: { name: 'Renamed Reviewer' },
    });
    expect(rename.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/agents/${agent.id}/export-ci`,
      payload: exportBody,
    });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json();
    expect(secondBody.installation.id).toBe(firstBody.installation.id);
    expect(secondBody.installation.slug).toBe(firstBody.installation.slug);
    expect(secondBody.installation.workflow_version).toBe(2);
    const secondManifestPath = secondBody.files.find((f: { path: string }) =>
      f.path.startsWith('.devdigest/agents/'),
    ).path;
    expect(secondManifestPath).toBe(firstManifestPath);
    // The rename IS actually exercised: the regenerated manifest content
    // reflects the new name even though its file path (identity) is frozen —
    // AC-4/AC-5 freeze the path, never the content.
    const secondManifestContents = secondBody.files.find(
      (f: { path: string }) => f.path === secondManifestPath,
    ).contents as string;
    expect(secondManifestContents).toContain('Renamed Reviewer');
    expect(secondManifestContents).not.toContain('Security Reviewer');

    // AC-10: an installation with an already-open export PR adds to that
    // SAME PR on re-export rather than opening a second one; AC-11: the PR
    // location is surfaced again on this successful export too.
    expect(secondBody.pr_url).toBe(firstBody.pr_url);
    expect(github.openedPrs).toHaveLength(1);
    expect(github.committed).toHaveLength(2);

    const [row2] = await pg.handle.db
      .select()
      .from(t.ciInstallations)
      .where(eq(t.ciInstallations.id, firstBody.installation.id));
    expect(row2?.workflowVersion).toBe(2);

    // AC-5: re-export overwrites the SAME row — never a second one for this
    // (workspace, repo) pair.
    const allRowsForRepo = await pg.handle.db
      .select()
      .from(t.ciInstallations)
      .where(eq(t.ciInstallations.repo, repo.full_name));
    expect(allRowsForRepo).toHaveLength(1);

    await app.close();
  });

  // -------------------------------------------------------------------------
  // One-agent-per-repo conflict (AC-13, re-scoped)
  // -------------------------------------------------------------------------
  it('exporting a different agent to an already-installed repo returns 409 and leaves the existing installation untouched (AC-13)', async () => {
    const app = await makeApp();
    const repo = await createRepo(app, 'acme/widgets-b');
    const agentA = await createAgent(app, 'Security Reviewer B');
    const agentB = await createAgent(app, 'Style Reviewer B');

    const exportA = await app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/agents/${agentA.id}/export-ci`,
      payload: { repo: repo.full_name, action: 'files' },
    });
    expect(exportA.statusCode).toBe(200);
    const installationId = exportA.json().installation.id as string;

    const [beforeRow] = await pg.handle.db
      .select()
      .from(t.ciInstallations)
      .where(eq(t.ciInstallations.id, installationId));

    const exportB = await app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/agents/${agentB.id}/export-ci`,
      payload: { repo: repo.full_name, action: 'files' },
    });
    expect(exportB.statusCode).toBe(409);
    expect(exportB.json().error.code).toBe('repo_already_installed');

    const [row] = await pg.handle.db
      .select()
      .from(t.ciInstallations)
      .where(eq(t.ciInstallations.id, installationId));
    expect(row?.agentId).toBe(agentA.id);
    expect(row?.workflowVersion).toBe(1);
    // Byte-identical row before/after the rejected conflict — not just the
    // two fields above; every column (slug, triggers, post_as,
    // workflow_contents, installed_at, disconnected_at, ...) is untouched.
    expect(row).toEqual(beforeRow);

    // No second row was created for this repo either.
    const allRowsForRepo = await pg.handle.db
      .select()
      .from(t.ciInstallations)
      .where(eq(t.ciInstallations.repo, repo.full_name));
    expect(allRowsForRepo).toHaveLength(1);

    await app.close();
  });

  // -------------------------------------------------------------------------
  // Cross-workspace 404s (AC-28, AC-32)
  // -------------------------------------------------------------------------
  it("GET /agents/:id/ci and POST /ci/installations/:id/disconnect 404 for another workspace's agent/installation (AC-28, AC-32)", async () => {
    const app = await makeApp();
    const { db } = pg.handle;

    const [otherWs] = await db
      .insert(t.workspaces)
      .values({ name: 'ci-routes-other-ws' })
      .returning();
    const agentsRepo = new AgentsRepository(db);
    const foreignAgent = await agentsRepo.insert({
      workspaceId: otherWs!.id,
      name: 'Foreign Agent',
      provider: 'openai',
      model: 'gpt-4o-mini',
      systemPrompt: 'x',
    });

    const [foreignInstallation] = await db
      .insert(t.ciInstallations)
      .values({
        workspaceId: otherWs!.id,
        agentId: foreignAgent.id,
        repo: 'other-org/other-repo',
        targetType: 'gha',
        slug: 'foreign-agent',
      })
      .returning();

    const ciRes = await app.inject({ method: 'GET', url: `/agents/${foreignAgent.id}/ci` });
    expect(ciRes.statusCode).toBe(404);
    expect(ciRes.json().error.code).toBe('not_found');

    const disconnectRes = await app.inject({
      method: 'POST',
      url: `/ci/installations/${foreignInstallation!.id}/disconnect`,
    });
    expect(disconnectRes.statusCode).toBe(404);
    expect(disconnectRes.json().error.code).toBe('not_found');

    // The rejected disconnect attempt (workspace-scoped WHERE clause,
    // AC-28) never touched the foreign row — not just "some 404 came back".
    const [stillConnected] = await db
      .select()
      .from(t.ciInstallations)
      .where(eq(t.ciInstallations.id, foreignInstallation!.id));
    expect(stillConnected?.disconnectedAt).toBeNull();

    await app.close();
  });

  // -------------------------------------------------------------------------
  // Rate limits — 2/min per workspace (AC-15, AC-26, AC-48)
  // -------------------------------------------------------------------------
  it('a 3rd export-ci request within 60s from the same workspace is rejected with 429 (AC-15)', async () => {
    const app = await makeRateLimitedApp();
    const repo = await createRepo(app, 'acme/widgets-rl-export');
    const agent = await createAgent(app, 'Rate Limit Export Reviewer');
    const body = { repo: repo.full_name, action: 'files' };

    const first = await app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/agents/${agent.id}/export-ci`,
      payload: body,
    });
    const second = await app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/agents/${agent.id}/export-ci`,
      payload: body,
    });
    const third = await app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/agents/${agent.id}/export-ci`,
      payload: body,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);

    await app.close();
  });

  it('a 3rd bulk-update request within 60s is rejected with 429 (AC-48)', async () => {
    const app = await makeRateLimitedApp();
    const agent = await createAgent(app, 'Rate Limit Bulk Reviewer');

    const first = await app.inject({ method: 'POST', url: `/agents/${agent.id}/ci/bulk-update` });
    const second = await app.inject({ method: 'POST', url: `/agents/${agent.id}/ci/bulk-update` });
    const third = await app.inject({ method: 'POST', url: `/agents/${agent.id}/ci/bulk-update` });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);

    await app.close();
  });

  it('a 3rd /ci/check request within 60s is rejected with 429 (AC-26)', async () => {
    const app = await makeRateLimitedApp();

    const first = await app.inject({ method: 'POST', url: '/ci/check' });
    const second = await app.inject({ method: 'POST', url: '/ci/check' });
    const third = await app.inject({ method: 'POST', url: '/ci/check' });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);

    await app.close();
  });

  // -------------------------------------------------------------------------
  // Stalled GitHub client → 30s server-side timeout, clean error body (AC-27)
  // -------------------------------------------------------------------------
  it(
    'POST /ci/check against a stalled GitHub client fails within the 30s server-side timeout, with a clean error body (AC-27)',
    async () => {
      const stalledGithub = new MockGitHubClient();
      // Never resolves — simulates a hung GitHub API call.
      stalledGithub.listWorkflowRuns = () => new Promise(() => {});
      const app = await makeApp({ github: stalledGithub });

      const repo = await createRepo(app, 'acme/widgets-stall');
      const agent = await createAgent(app, 'Stall Reviewer');
      const exported = await app.inject({
        method: 'POST',
        url: `/repos/${repo.id}/agents/${agent.id}/export-ci`,
        payload: { repo: repo.full_name, action: 'files' },
      });
      expect(exported.statusCode).toBe(200);

      const res = await app.inject({ method: 'POST', url: '/ci/check' });
      expect(res.statusCode).toBe(502);
      const body = res.json();
      expect(body.error.code).toBe('external_service_error');
      expect(body.error.message).toMatch(/timed out/i);

      await app.close();
    },
    40_000,
  );

  // -------------------------------------------------------------------------
  // Fork-originating run → skipped_fork (AC-18, AC-21, AC-24)
  // -------------------------------------------------------------------------
  it('a workflow run with conclusion "skipped" (fork PR) surfaces as skipped_fork in GET /ci/runs (AC-7, AC-24)', async () => {
    const workflowRuns: MockWorkflowRun[] = [
      {
        id: 9202,
        status: 'completed',
        conclusion: 'skipped',
        html_url: 'https://github.com/acme/widgets-fork/actions/runs/9202',
        created_at: '2026-07-02T00:00:00Z',
      },
    ];
    const github = new MockGitHubClient({ workflowRuns });
    const app = await makeApp({ github });

    const repo = await createRepo(app, 'acme/widgets-fork');
    const agent = await createAgent(app, 'Fork Reviewer');
    await app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/agents/${agent.id}/export-ci`,
      payload: { repo: repo.full_name, action: 'files' },
    });

    const checkRes = await app.inject({ method: 'POST', url: '/ci/check' });
    expect(checkRes.statusCode).toBe(200);
    // The check's own response already carries the fork-skip mapping — not
    // just a subsequent re-read via GET /ci/runs.
    const checkedRun = checkRes
      .json()
      .runs_updated.find((r: { github_url: string | null }) => r.github_url?.includes('9202'));
    expect(checkedRun?.status).toBe('skipped_fork');

    const runsRes = await app.inject({
      method: 'GET',
      url: `/ci/runs?repo=${encodeURIComponent(repo.full_name)}`,
    });
    expect(runsRes.statusCode).toBe(200);
    const { runs } = runsRes.json();
    const run = runs.find((r: { github_url: string | null }) => r.github_url?.includes('9202'));
    expect(run?.status).toBe('skipped_fork');
    // A skipped (fork) run never carries findings/cost metrics — keeps it
    // distinct from a genuinely reviewed run that happens to find nothing.
    expect(run?.findings_count).toBeNull();
    expect(run?.cost_usd).toBeNull();

    await app.close();
  });

  // -------------------------------------------------------------------------
  // Duplicate run id across two checks → exactly one row (AC-19, AC-20)
  // -------------------------------------------------------------------------
  it('a duplicate GitHub run id observed across two /ci/check calls upserts exactly one ci_runs row (AC-19, AC-20)', async () => {
    const workflowRuns: MockWorkflowRun[] = [
      {
        id: 9101,
        status: 'completed',
        conclusion: 'success',
        html_url: 'https://github.com/acme/widgets-dup/actions/runs/9101',
        created_at: '2026-07-01T00:00:00Z',
      },
    ];
    const github = new MockGitHubClient({ workflowRuns, artifacts: [] });
    const app = await makeApp({ github });

    const repo = await createRepo(app, 'acme/widgets-dup');
    const agent = await createAgent(app, 'Dup Reviewer');
    await app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/agents/${agent.id}/export-ci`,
      payload: { repo: repo.full_name, action: 'files' },
    });

    const check1 = await app.inject({ method: 'POST', url: '/ci/check' });
    expect(check1.statusCode).toBe(200);
    const check2 = await app.inject({ method: 'POST', url: '/ci/check' });
    expect(check2.statusCode).toBe(200);

    const runs = await pg.handle.db
      .select()
      .from(t.ciRuns)
      .where(eq(t.ciRuns.githubRunId, '9101'));
    expect(runs).toHaveLength(1);

    // AC-19 specifically: a run that was PREVIOUSLY IN PROGRESS and later
    // FINISHES updates that SAME entry to its finished status — the dedup
    // check above (AC-20) only proves an unchanged, already-finished fixture
    // observed twice doesn't duplicate; this proves a genuine value
    // transition is written in place too, not just re-observed unchanged.
    const inProgressRun: MockWorkflowRun = {
      id: 9102,
      status: 'in_progress',
      conclusion: null,
      html_url: 'https://github.com/acme/widgets-dup/actions/runs/9102',
      created_at: '2026-07-01T00:05:00Z',
    };
    github.listWorkflowRuns = async (repoRef) =>
      `${repoRef.owner}/${repoRef.name}` === repo.full_name ? [inProgressRun] : [];

    const check3 = await app.inject({ method: 'POST', url: '/ci/check' });
    expect(check3.statusCode).toBe(200);
    const [runningRow] = await pg.handle.db
      .select()
      .from(t.ciRuns)
      .where(eq(t.ciRuns.githubRunId, '9102'));
    expect(runningRow?.status).toBe('running');
    expect(runningRow?.findingsCount).toBeNull();

    const finishedRun: MockWorkflowRun = {
      ...inProgressRun,
      status: 'completed',
      conclusion: 'success',
    };
    github.listWorkflowRuns = async (repoRef) =>
      `${repoRef.owner}/${repoRef.name}` === repo.full_name ? [finishedRun] : [];

    const check4 = await app.inject({ method: 'POST', url: '/ci/check' });
    expect(check4.statusCode).toBe(200);
    const finishedRows = await pg.handle.db
      .select()
      .from(t.ciRuns)
      .where(eq(t.ciRuns.githubRunId, '9102'));
    // Still exactly one row (AC-20) — updated IN PLACE to its finished
    // status (AC-19), never a stale 'running' row plus a separate finished one.
    expect(finishedRows).toHaveLength(1);
    expect(finishedRows[0]?.status).toBe('no_findings');

    await app.close();
  });

  // -------------------------------------------------------------------------
  // Malformed artifact → fallback to GitHub's own conclusion, never a crash (AC-21)
  // -------------------------------------------------------------------------
  it("an artifact that fails CiResultArtifact.safeParse falls back to GitHub's own conclusion, never crashes (AC-21)", async () => {
    const zip = new JSZip();
    // Missing the required `findings_count` field — fails CiResultArtifact.safeParse.
    zip.file('devdigest-result.json', JSON.stringify({ agent: 'Bad Artifact Reviewer', cost_usd: 0.01 }));
    const badArtifactBuffer = await zip.generateAsync({ type: 'nodebuffer' });

    const workflowRuns: MockWorkflowRun[] = [
      {
        id: 9303,
        status: 'completed',
        conclusion: 'failure',
        html_url: 'https://github.com/acme/widgets-badart/actions/runs/9303',
        created_at: '2026-07-03T00:00:00Z',
      },
      // Same malformed artifact, but a GitHub-reported SUCCESS this time —
      // the fallback must track GitHub's own conclusion either way, never
      // collapse every discard to 'failed' regardless of the real outcome.
      {
        id: 9304,
        status: 'completed',
        conclusion: 'success',
        html_url: 'https://github.com/acme/widgets-badart/actions/runs/9304',
        created_at: '2026-07-03T00:05:00Z',
      },
    ];
    const github = new MockGitHubClient({
      workflowRuns,
      artifacts: [{ id: 3001, name: 'devdigest-result', expired: false }],
      artifactContents: badArtifactBuffer,
    });
    const app = await makeApp({ github });

    const repo = await createRepo(app, 'acme/widgets-badart');
    const agent = await createAgent(app, 'Bad Artifact Reviewer');
    await app.inject({
      method: 'POST',
      url: `/repos/${repo.id}/agents/${agent.id}/export-ci`,
      payload: { repo: repo.full_name, action: 'files' },
    });

    const checkRes = await app.inject({ method: 'POST', url: '/ci/check' });
    expect(checkRes.statusCode).toBe(200);
    const { runs_updated } = checkRes.json();
    const checkedFailed = runs_updated.find((r: { github_url: string | null }) =>
      r.github_url?.includes('9303'),
    );
    const checkedNoFindings = runs_updated.find((r: { github_url: string | null }) =>
      r.github_url?.includes('9304'),
    );
    expect(checkedFailed?.status).toBe('failed');
    expect(checkedNoFindings?.status).toBe('no_findings');

    const runsRes = await app.inject({
      method: 'GET',
      url: `/ci/runs?repo=${encodeURIComponent(repo.full_name)}`,
    });
    const { runs } = runsRes.json();
    const run = runs.find((r: { github_url: string | null }) => r.github_url?.includes('9303'));
    // conclusion 'failure' + no trustworthy artifact → fallback status 'failed'.
    expect(run?.status).toBe('failed');
    expect(run?.findings_count).toBeNull();

    // conclusion 'success' + the SAME untrustworthy artifact → fallback
    // status 'no_findings', never a crash and never conflated with 'failed'.
    const run2 = runs.find((r: { github_url: string | null }) => r.github_url?.includes('9304'));
    expect(run2?.status).toBe('no_findings');
    expect(run2?.findings_count).toBeNull();

    await app.close();
  });
});
