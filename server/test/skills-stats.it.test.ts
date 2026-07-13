import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import { MockGitClient, MockGitHubClient, MockAuthProvider } from '../src/adapters/mocks.js';
import type { SkillStats } from '@devdigest/shared';
import type { FastifyInstance } from 'fastify';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  // eslint-disable-next-line no-console
  console.warn('[skills-stats] Docker not available — skipping integration tests.');
}

/**
 * GET /skills/:id/stats — real accept-rate + even-split dollar
 * `findings_by_category` (L08 Spec B). Covers: the real accept-rate over the
 * trailing-30d/agent-linked finding set (AC-22), even-split dollar arithmetic
 * (`totalKnownCost * count/totalFindings`, AC-20), `estimated_cost_usd: null`
 * for every category when every contributing run's cost is unknown (AC-28),
 * an unchanged empty `[]` when there are zero findings in the trailing-30d
 * window even though the skill IS agent-linked (AC-23), and CI-run exclusion
 * from the cost/accept-rate aggregate (AC-26).
 *
 * IMPORTANT wiring note: `SkillsRepository.stats()`'s `recentFindings` query
 * inner-joins `agent_runs` via `reviews.run_id = agent_runs.id` (not
 * `reviews.agent_id`) — every review inserted below sets `runId` to its
 * driving run's id, or the join silently returns zero rows.
 *
 * Uses ISOLATED workspaces per scenario (not `seed()`'s "default" one) — see
 * `agent-performance.it.test.ts` for why.
 */
d('GET /skills/:id/stats', () => {
  let pg: PgFixture;
  let testUserId: string;

  beforeAll(async () => {
    pg = await startPg();
    await seed(pg.handle.db);
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
      .values({ workspaceId, owner: 'acme', name: `skill-${suffix}`, fullName: `acme/skill-${suffix}` })
      .returning();
    const [pr] = await pg.handle.db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId: repo!.id,
        number: 1,
        title: 'Skill-stats fixture PR',
        author: 'fixture',
        branch: 'feat/x',
        base: 'main',
        headSha: 'deadbeef',
        status: 'needs_review',
      })
      .returning();
    return pr!.id as string;
  }

  async function createAgent(app: FastifyInstance, name: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: { name, provider: 'openai', model: 'gpt-4.1', system_prompt: 'p' },
    });
    return res.json().id as string;
  }

  async function createSkill(app: FastifyInstance, name: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/skills',
      payload: { name, type: 'rubric', body: 'x' },
    });
    return res.json().id as string;
  }

  async function linkSkill(app: FastifyInstance, agentId: string, skillId: string) {
    await app.inject({
      method: 'POST',
      url: `/agents/${agentId}/skills`,
      payload: { skill_ids: [skillId] },
    });
  }

  const days = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

  /** Inserts an agent_run AND a review whose `runId` points at it (the join the
   *  skills-stats query relies on), returning both ids. */
  async function insertRunWithReview(opts: {
    workspaceId: string;
    agentId: string;
    prId: string;
    ranAt: Date;
    costUsd: number | null;
    source?: 'local' | 'ci';
  }): Promise<{ runId: string; reviewId: string }> {
    const [run] = await pg.handle.db
      .insert(t.agentRuns)
      .values({
        workspaceId: opts.workspaceId,
        agentId: opts.agentId,
        prId: opts.prId,
        ranAt: opts.ranAt,
        costUsd: opts.costUsd,
        model: 'gpt-4.1',
        provider: 'openai',
        status: 'done',
        source: opts.source ?? 'local',
      })
      .returning();
    const [review] = await pg.handle.db
      .insert(t.reviews)
      .values({
        workspaceId: opts.workspaceId,
        prId: opts.prId,
        agentId: opts.agentId,
        runId: run!.id,
        kind: 'review',
      })
      .returning();
    return { runId: run!.id as string, reviewId: review!.id as string };
  }

  async function insertFinding(
    reviewId: string,
    opts: { category: string; decision: 'accepted' | 'dismissed' },
  ) {
    await pg.handle.db.insert(t.findings).values({
      reviewId,
      file: 'src/x.ts',
      startLine: 1,
      endLine: 1,
      severity: 'WARNING',
      category: opts.category,
      title: 't',
      rationale: 'r',
      confidence: 0.9,
      ...(opts.decision === 'accepted' ? { acceptedAt: new Date() } : { dismissedAt: new Date() }),
    });
  }

  it(
    'computes real accept-rate + even-split dollar findings_by_category over the trailing-30d, ' +
      "agent-linked finding set (AC-20/22), excluding CI runs from both the cost pool AND the " +
      'accept-rate aggregate (AC-26)',
    async () => {
      const workspaceId = await makeWorkspace('skills-main-ws');
      const app = await appFor(workspaceId);
      const prId = await makeRepoAndPr(workspaceId, 'main');
      const agentId = await createAgent(app, 'Skilled Agent');
      const skillId = await createSkill(app, 'Security Rubric');
      await linkSkill(app, agentId, skillId);

      // run1 ($10 known cost): 2 security findings accepted, 1 security dismissed.
      const { reviewId: review1 } = await insertRunWithReview({
        workspaceId,
        agentId,
        prId,
        ranAt: days(5),
        costUsd: 10.0,
      });
      await insertFinding(review1, { category: 'security', decision: 'accepted' });
      await insertFinding(review1, { category: 'security', decision: 'accepted' });
      await insertFinding(review1, { category: 'security', decision: 'dismissed' });

      // run2 (unknown cost): 1 style finding accepted.
      const { reviewId: review2 } = await insertRunWithReview({
        workspaceId,
        agentId,
        prId,
        ranAt: days(10),
        costUsd: null,
      });
      await insertFinding(review2, { category: 'style', decision: 'accepted' });

      // run_old (outside the 30d window): contributes to the ALL-TIME run total
      // (pull_frequency_pct's denominator) but not to findings_30d/category_counts.
      await insertRunWithReview({ workspaceId, agentId, prId, ranAt: days(40), costUsd: 5.0 });

      // CI run (AC-26): a big-cost, big-finding-count run that must be invisible
      // to every metric below — proves the source='local' filter is applied.
      const { reviewId: reviewCi } = await insertRunWithReview({
        workspaceId,
        agentId,
        prId,
        ranAt: days(2),
        costUsd: 999.0,
        source: 'ci',
      });
      await insertFinding(reviewCi, { category: 'performance', decision: 'accepted' });

      const res = await app.inject({ method: 'GET', url: `/skills/${skillId}/stats` });
      expect(res.statusCode).toBe(200);
      const stats = res.json() as SkillStats;

      expect(stats.used_by).toBe(1);
      expect(stats.agents).toEqual([{ id: agentId, name: 'Skilled Agent' }]);
      // 2 local runs in the 30d window / 3 local runs all-time = 67%.
      expect(stats.pull_frequency_pct).toBe(67);
      expect(stats.findings_30d).toBe(4); // 3 security + 1 style; the CI finding is excluded
      // 3 accepted / (3 accepted + 1 dismissed) = 75% — the CI finding (accepted) does NOT
      // enter this ratio at all (AC-26).
      expect(stats.accept_rate_pct).toBe(75);

      // Even split: totalKnownCost = $10 (only run1 known; run2 null, CI excluded entirely).
      // security: 10 * 3/4 = 7.5 · style: 10 * 1/4 = 2.5.
      const byCategory = new Map(stats.findings_by_category.map((c) => [c.category, c.estimated_cost_usd]));
      expect(byCategory.get('security')).toBeCloseTo(7.5, 5);
      expect(byCategory.get('style')).toBeCloseTo(2.5, 5);
      expect(byCategory.has('performance')).toBe(false); // CI-sourced category never appears

      await app.close();
    },
  );

  it('returns estimated_cost_usd: null for every category when every contributing run has unknown cost (AC-28)', async () => {
    const workspaceId = await makeWorkspace('skills-null-cost-ws');
    const app = await appFor(workspaceId);
    const prId = await makeRepoAndPr(workspaceId, 'null-cost');
    const agentId = await createAgent(app, 'Unknown Cost Agent');
    const skillId = await createSkill(app, 'Correctness Rubric');
    await linkSkill(app, agentId, skillId);

    const { reviewId: review1 } = await insertRunWithReview({
      workspaceId,
      agentId,
      prId,
      ranAt: days(3),
      costUsd: null,
    });
    await insertFinding(review1, { category: 'correctness', decision: 'accepted' });
    const { reviewId: review2 } = await insertRunWithReview({
      workspaceId,
      agentId,
      prId,
      ranAt: days(6),
      costUsd: null,
    });
    await insertFinding(review2, { category: 'docs', decision: 'dismissed' });

    const res = await app.inject({ method: 'GET', url: `/skills/${skillId}/stats` });
    expect(res.statusCode).toBe(200);
    const stats = res.json() as SkillStats;

    expect(stats.findings_30d).toBe(2);
    expect(stats.findings_by_category).toEqual(
      expect.arrayContaining([
        { category: 'correctness', estimated_cost_usd: null },
        { category: 'docs', estimated_cost_usd: null },
      ]),
    );
    expect(stats.findings_by_category).toHaveLength(2);

    await app.close();
  });

  it(
    'returns an empty findings_by_category (unchanged from the count-based shape) when the linked agent ' +
      'has zero findings inside the trailing-30d window, even though it has run before (AC-23)',
    async () => {
      const workspaceId = await makeWorkspace('skills-stale-ws');
      const app = await appFor(workspaceId);
      const prId = await makeRepoAndPr(workspaceId, 'stale');
      const agentId = await createAgent(app, 'Stale Agent');
      const skillId = await createSkill(app, 'Docs Rubric');
      await linkSkill(app, agentId, skillId);

      // A run + finding that both exist, but 40 days ago — outside the 30d window.
      const { reviewId } = await insertRunWithReview({
        workspaceId,
        agentId,
        prId,
        ranAt: days(40),
        costUsd: 8.0,
      });
      await insertFinding(reviewId, { category: 'docs', decision: 'accepted' });

      const res = await app.inject({ method: 'GET', url: `/skills/${skillId}/stats` });
      expect(res.statusCode).toBe(200);
      const stats = res.json() as SkillStats;

      expect(stats.used_by).toBe(1); // the agent IS linked — this isn't the "no agents" empty branch
      expect(stats.findings_30d).toBe(0);
      expect(stats.findings_by_category).toEqual([]);
      expect(stats.pull_frequency_pct).toBe(0); // 0 recent runs / 1 all-time run

      await app.close();
    },
  );
});
