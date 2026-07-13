import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import { MockGitClient, MockGitHubClient, MockAuthProvider } from '../src/adapters/mocks.js';
import type { AgentPerf } from '@devdigest/shared';
import type { FastifyInstance } from 'fastify';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  // eslint-disable-next-line no-console
  console.warn('[agent-performance] Docker not available — skipping integration tests.');
}

/**
 * GET /agents/performance — the fleet-wide L08 Spec B "Agent Performance"
 * read. Covers AC-1 (fleet KPI summary), AC-3 (zero-run agent row),
 * AC-24 (workspace scoping), AC-26 (CI runs excluded), AC-27 (zero prior
 * window → delta = current), AC-28 (null cost segment when every
 * contributing run's cost is unknown), AC-29 (a deleted agent's run counts
 * toward the workspace total but never a per-agent/per-cost-by-agent row).
 *
 * Uses an ISOLATED workspace (not `seed()`'s "default" one) so the fleet
 * totals asserted below are exact — `seed()` itself writes agent_runs for
 * the built-in reviewer agents into the default workspace (see
 * `src/db/seed.ts`), which would otherwise pollute every summary number.
 */
d('GET /agents/performance', () => {
  let pg: PgFixture;
  let testUserId: string;

  beforeAll(async () => {
    pg = await startPg();
    await seed(pg.handle.db); // convention: every .it.test.ts seeds (see server/AGENTS.md); our assertions use a separate workspace so this data never contaminates them.
    // A REAL `users` row — `agents.created_by` is a uuid FK to `users.id`, so a
    // syntactically-fake id (e.g. 'u1') 500s on the first POST /agents (invalid
    // input syntax for type uuid), and a well-formed-but-nonexistent uuid would
    // 500 on the FK constraint instead. `MockAuthProvider` below must return an
    // id that genuinely exists in `users`.
    const [testUser] = await pg.handle.db
      .insert(t.users)
      .values({ email: 'it-test-user@local', name: 'IT Test User' })
      .returning();
    testUserId = testUser!.id;
  });
  afterAll(async () => {
    await pg?.stop();
  });

  function appFor(workspaceId: string): Promise<FastifyInstance> {
    const config = loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);
    const mockAuth = new MockAuthProvider(
      { id: testUserId, email: 'it-test-user@local', name: 'IT Test User' },
      { id: workspaceId, name: `ws-${workspaceId.slice(0, 8)}` },
    );
    return buildApp({
      config,
      db: pg.handle.db,
      overrides: { git: new MockGitClient(), github: new MockGitHubClient(), auth: mockAuth },
    });
  }

  async function makeWorkspace(name: string): Promise<string> {
    const [ws] = await pg.handle.db.insert(t.workspaces).values({ name }).returning();
    return ws!.id;
  }

  async function makeRepoAndPr(workspaceId: string, suffix: string) {
    const [repo] = await pg.handle.db
      .insert(t.repos)
      .values({ workspaceId, owner: 'acme', name: `perf-${suffix}`, fullName: `acme/perf-${suffix}` })
      .returning();
    const [pr] = await pg.handle.db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId: repo!.id,
        number: 1,
        title: 'Perf fixture PR',
        author: 'fixture',
        branch: 'feat/x',
        base: 'main',
        headSha: 'deadbeef',
        status: 'needs_review',
      })
      .returning();
    return pr!.id as string;
  }

  async function createAgent(
    app: FastifyInstance,
    name: string,
    provider: 'openai' | 'anthropic',
    model: string,
  ): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: { name, provider, model, system_prompt: 'p' },
    });
    return res.json().id as string;
  }

  const days = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

  async function insertRun(opts: {
    workspaceId: string;
    agentId: string;
    prId: string;
    ranAt: Date;
    costUsd: number | null;
    model: string;
    source?: 'local' | 'ci';
  }) {
    await pg.handle.db.insert(t.agentRuns).values({
      workspaceId: opts.workspaceId,
      agentId: opts.agentId,
      prId: opts.prId,
      ranAt: opts.ranAt,
      costUsd: opts.costUsd,
      model: opts.model,
      provider: 'openai',
      status: 'done',
      source: opts.source ?? 'local',
    });
  }

  it(
    'computes fleet KPIs + per-agent rows + cost breakdowns: excludes CI runs (AC-26), zero prior window ' +
      "→ delta = current (AC-27), null segment when a group's cost is fully unknown (AC-28), a zero-run agent " +
      'shows 0/null not omitted (AC-3), and a deleted agent\'s run counts toward the workspace total but not ' +
      'any per-agent breakdown (AC-29)',
    async () => {
      const workspaceId = await makeWorkspace('perf-fleet-ws');
      const app = await appFor(workspaceId);
      const prId = await makeRepoAndPr(workspaceId, 'fleet');

      const agentAlpha = await createAgent(app, 'Agent Alpha', 'openai', 'gpt-4.1');
      const agentBeta = await createAgent(app, 'Agent Beta', 'anthropic', 'claude-3-opus');
      const agentGamma = await createAgent(app, 'Agent Gamma', 'openai', 'gpt-4.1'); // never runs (AC-3)
      const agentDeleted = await createAgent(app, 'Agent Deleted', 'openai', 'gpt-4.1');

      // Agent Alpha: 3 known-cost local runs inside the 30d window (2.00 + 3.00 + 1.50 = 6.50)
      // + 1 CI run with a deliberately large cost that must be excluded everywhere (AC-26).
      await insertRun({ workspaceId, agentId: agentAlpha, prId, ranAt: days(5), costUsd: 2.0, model: 'gpt-4.1' });
      await insertRun({ workspaceId, agentId: agentAlpha, prId, ranAt: days(10), costUsd: 3.0, model: 'gpt-4.1' });
      await insertRun({ workspaceId, agentId: agentAlpha, prId, ranAt: days(7), costUsd: 1.5, model: 'gpt-4.1' });
      await insertRun({
        workspaceId,
        agentId: agentAlpha,
        prId,
        ranAt: days(3),
        costUsd: 100.0,
        model: 'gpt-4.1',
        source: 'ci',
      });

      // Agent Beta: 2 local runs in the 30d window, BOTH with unknown cost → the whole
      // group's cost is unknown (AC-28), not $0.
      await insertRun({ workspaceId, agentId: agentBeta, prId, ranAt: days(2), costUsd: null, model: 'claude-3-opus' });
      await insertRun({ workspaceId, agentId: agentBeta, prId, ranAt: days(15), costUsd: null, model: 'claude-3-opus' });

      // Agent Deleted: 1 local run, then the agent itself is deleted — agent_runs.agent_id
      // is set NULL (FK onDelete:'set null'), so this run survives as an orphan.
      await insertRun({ workspaceId, agentId: agentDeleted, prId, ranAt: days(1), costUsd: 5.0, model: 'gpt-4.1' });
      await pg.handle.db.delete(t.agents).where(eq(t.agents.id, agentDeleted));

      // Agent Alpha's findings (drives accept_rate + avg_accept_rate_pct_30d):
      // 2 CRITICAL + 1 WARNING accepted, 1 SUGGESTION dismissed → 3 accepted / 1 dismissed = 75%.
      const [review] = await pg.handle.db
        .insert(t.reviews)
        .values({ workspaceId, prId, agentId: agentAlpha, kind: 'review' })
        .returning();
      const findingBase = {
        reviewId: review!.id,
        file: 'src/x.ts',
        startLine: 1,
        endLine: 1,
        category: 'correctness',
        title: 't',
        rationale: 'r',
        confidence: 0.9,
      };
      await pg.handle.db.insert(t.findings).values([
        { ...findingBase, severity: 'CRITICAL', acceptedAt: new Date() },
        { ...findingBase, severity: 'CRITICAL', acceptedAt: new Date() },
        { ...findingBase, severity: 'WARNING', acceptedAt: new Date() },
        { ...findingBase, severity: 'SUGGESTION', dismissedAt: new Date() },
      ]);

      const res = await app.inject({ method: 'GET', url: '/agents/performance' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as AgentPerf;

      // ---- AC-1: fleet summary ----------------------------------------------
      // 3 (Alpha local) + 2 (Beta local) + 1 (orphaned Deleted) = 6 local runs;
      // the CI run is excluded from the count entirely.
      expect(body.summary.total_runs_all_time).toBe(6);
      // cost30d = 2 + 3 + 1.5 + null + null + 5 = 11.5 (SUM ignores NULLs; CI's 100 excluded).
      expect(body.summary.total_cost_usd_30d).toBeCloseTo(11.5, 5);
      // AC-27: nothing ran 30-60 days ago in this fresh workspace → prior window is a
      // legitimate $0 baseline (not null), so the delta equals the current total exactly.
      expect(body.summary.cost_delta_usd_30d).toBeCloseTo(11.5, 5);
      expect(body.summary.avg_accept_rate_pct_30d).toBe(75);
      // AC-29: the orphaned run has no agent_id → excluded from the most-active ranking
      // (which inner-joins agents), so Alpha (3 in-window local runs) wins over Beta (2).
      expect(body.summary.most_active_agent).toMatchObject({ agent_id: agentAlpha, runs_30d: 3 });

      // ---- per-agent rows -----------------------------------------------------
      const rowFor = (id: string) => body.agents.find((a) => a.agent_id === id);

      const alphaRow = rowFor(agentAlpha)!;
      expect(alphaRow).toMatchObject({
        runs: 3,
        findings_total: 4,
        accepted: 3,
        dismissed: 1,
        accept_rate: 0.75,
        dismiss_rate: 0.25,
        total_cost_usd: 6.5,
        findings_by_severity: { CRITICAL: 2, WARNING: 1, SUGGESTION: 1 },
      });
      expect(alphaRow.avg_findings_per_run).toBeCloseTo(4 / 3, 5);
      expect(alphaRow.avg_cost_usd).toBeCloseTo(6.5 / 3, 5);

      const betaRow = rowFor(agentBeta)!;
      expect(betaRow).toMatchObject({
        runs: 2,
        findings_total: 0,
        accepted: 0,
        dismissed: 0,
        accept_rate: null,
        total_cost_usd: null, // every Beta run has unknown cost
        avg_cost_usd: null,
      });
      expect(betaRow.avg_findings_per_run).toBe(0); // runs > 0, findings = 0 → 0, not null

      // AC-3: a NEVER-RUN agent still appears, with zero/null (never omitted).
      const gammaRow = rowFor(agentGamma)!;
      expect(gammaRow).toMatchObject({
        runs: 0,
        findings_total: 0,
        accepted: 0,
        dismissed: 0,
        accept_rate: null,
        total_cost_usd: 0, // zero-run agent displays cost as 0, not "—"
        avg_cost_usd: null,
        avg_findings_per_run: null,
        last_run_at: null,
      });

      // AC-29: the deleted agent's run is nowhere in the per-agent array (it can't be —
      // the agent no longer exists — and its cost is NOT folded into any surviving agent).
      expect(body.agents).toHaveLength(3);
      expect(body.agents.map((a) => a.agent_id)).not.toContain(agentDeleted);

      // ---- cost_by_agent / cost_by_model breakdowns ----------------------------
      const byAgent = new Map(body.cost_by_agent.map((s) => [s.label, s.value]));
      expect(byAgent.get('Agent Alpha')).toBeCloseTo(6.5, 5);
      expect(byAgent.get('Agent Beta')).toBeNull(); // AC-28: whole group unknown → null, not 0
      // AC-29: the deleted agent's $5 never appears as its own cost_by_agent segment —
      // the join to `agents` drops it, so the sum of every surviving segment (6.5 + null)
      // is strictly less than the fleet total (11.5), by exactly the orphaned run's cost.
      expect(body.cost_by_agent).toHaveLength(2);

      const byModel = new Map(body.cost_by_model.map((s) => [s.label, s.value]));
      expect(byModel.get('claude-3-opus')).toBeNull(); // AC-28, model view
      // Note (nuance, not a bug): cost_by_model has NO agent join/filter — it groups by
      // the run's own `model` column — so the orphaned agent's $5 run (model: 'gpt-4.1',
      // same as Alpha) IS folded into the 'gpt-4.1' bucket alongside Alpha's $6.50:
      // 6.5 (Alpha) + 5 (orphaned) = 11.5. This is a genuine behavioral difference from
      // cost_by_agent (which drops the orphaned run entirely) — see report.
      expect(byModel.get('gpt-4.1')).toBeCloseTo(11.5, 5);

      await app.close();
    },
  );

  it("never leaks another workspace's agents or run/cost data into the fleet performance read (AC-24)", async () => {
    const wsA = await makeWorkspace('perf-scope-a');
    const wsB = await makeWorkspace('perf-scope-b');
    const appA = await appFor(wsA);
    const appB = await appFor(wsB);
    const prA = await makeRepoAndPr(wsA, 'scope-a');
    const prB = await makeRepoAndPr(wsB, 'scope-b');

    const agentA = await createAgent(appA, 'Tenant A Agent', 'openai', 'gpt-4.1');
    const agentB = await createAgent(appB, 'Tenant B Agent', 'openai', 'gpt-4.1');

    await insertRun({ workspaceId: wsA, agentId: agentA, prId: prA, ranAt: days(1), costUsd: 1.0, model: 'gpt-4.1' });
    await insertRun({ workspaceId: wsB, agentId: agentB, prId: prB, ranAt: days(1), costUsd: 999.0, model: 'gpt-4.1' });

    const resA = (await appA.inject({ method: 'GET', url: '/agents/performance' })).json() as AgentPerf;
    const resB = (await appB.inject({ method: 'GET', url: '/agents/performance' })).json() as AgentPerf;

    expect(resA.agents.map((a) => a.agent_id)).toEqual([agentA]);
    expect(resA.summary.total_runs_all_time).toBe(1);
    expect(resA.summary.total_cost_usd_30d).toBeCloseTo(1.0, 5);

    expect(resB.agents.map((a) => a.agent_id)).toEqual([agentB]);
    expect(resB.summary.total_runs_all_time).toBe(1);
    expect(resB.summary.total_cost_usd_30d).toBeCloseTo(999.0, 5);

    await appA.close();
    await appB.close();
  });
});
