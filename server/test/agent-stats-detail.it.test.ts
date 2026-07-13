import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import { MockGitClient, MockGitHubClient, MockAuthProvider } from '../src/adapters/mocks.js';
import type { AgentStatsDetail } from '@devdigest/shared';
import type { FastifyInstance } from 'fastify';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

if (!hasDocker) {
  // eslint-disable-next-line no-console
  console.warn('[agent-stats-detail] Docker not available — skipping integration tests.');
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Mirrors `zeroFillWeeklySeverity`'s own Monday-aligned UTC week math (agents/service.ts)
 *  so the test can pick review.createdAt values that land in a KNOWN bucket deterministically,
 *  without freezing system time (an integration test runs against real Postgres `now()`). */
function expectedWeekStarts(now: Date): string[] {
  const diffToMonday = (now.getUTCDay() + 6) % 7;
  const thisWeekStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - diffToMonday);
  const keys: string[] = [];
  for (let i = 7; i >= 0; i--) keys.push(new Date(thisWeekStart - i * WEEK_MS).toISOString().slice(0, 10));
  return keys;
}

/**
 * GET /agents/:id/stats — per-agent L08 Spec B stats detail. Covers: base
 * AgentStats KPIs + cost delta (AC-10/11), weekly_findings_by_severity
 * zero-filled to exactly 8 ordered points (AC-12), most_used_skills
 * order-ranked (+ empty when unlinked, AC-13), memory_pulled_summary always
 * `[]` (AC-14), run_history studio-only / CI excluded (AC-15/26), and 404 on
 * a cross-workspace agent id (AC-24).
 *
 * Uses ISOLATED workspaces (not `seed()`'s "default" one) — see
 * `agent-performance.it.test.ts` for why (seed() writes its own agent_runs).
 */
d('GET /agents/:id/stats', () => {
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
      .values({ workspaceId, owner: 'acme', name: `detail-${suffix}`, fullName: `acme/detail-${suffix}` })
      .returning();
    const [pr] = await pg.handle.db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId: repo!.id,
        number: 1,
        title: 'Detail fixture PR',
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

  const days = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

  async function insertRun(opts: {
    workspaceId: string;
    agentId: string;
    prId: string;
    ranAt: Date;
    costUsd: number | null;
    source?: 'local' | 'ci';
  }) {
    await pg.handle.db.insert(t.agentRuns).values({
      workspaceId: opts.workspaceId,
      agentId: opts.agentId,
      prId: opts.prId,
      ranAt: opts.ranAt,
      costUsd: opts.costUsd,
      model: 'gpt-4.1',
      provider: 'openai',
      status: 'done',
      source: opts.source ?? 'local',
    });
  }

  it(
    'composes base KPIs + cost delta (AC-10/11), zero-fills weekly_findings_by_severity to exactly 8 ' +
      'ordered points (AC-12), ranks most_used_skills by link order (AC-13), always returns an empty ' +
      'memory_pulled_summary (AC-14), and limits run_history to studio (source=local) runs only, excluding ' +
      'CI (AC-15/26)',
    async () => {
      const workspaceId = await makeWorkspace('detail-fleet-ws');
      const app = await appFor(workspaceId);
      const prId = await makeRepoAndPr(workspaceId, 'main');
      const agentId = await createAgent(app, 'Agent Detail');

      // ---- runs: 3 in the current 30d window + 1 in the 30-60d prior window,
      // all source='local', + 1 CI run that must be excluded everywhere below.
      await insertRun({ workspaceId, agentId, prId, ranAt: days(5), costUsd: 2.0 }); // r1
      await insertRun({ workspaceId, agentId, prId, ranAt: days(7), costUsd: 1.5 }); // r3
      await insertRun({ workspaceId, agentId, prId, ranAt: days(10), costUsd: 3.0 }); // r2
      await insertRun({ workspaceId, agentId, prId, ranAt: days(45), costUsd: 4.0 }); // r4 (prior window)
      await insertRun({ workspaceId, agentId, prId, ranAt: days(3), costUsd: 999.0, source: 'ci' }); // excluded

      // ---- findings across 2 distinct ISO weeks (drives weekly_findings_by_severity +
      // the all-time accept-rate KPIs). Week bucketing mirrors production's own Monday-
      // aligned UTC math so we know exactly which of the 8 slots each review lands in.
      const now = new Date();
      const weekStarts = expectedWeekStarts(now);
      const threeWeeksAgoNoon = new Date(new Date(weekStarts[4] + 'T00:00:00Z').getTime() + 12 * 60 * 60 * 1000);

      const [reviewOld] = await pg.handle.db
        .insert(t.reviews)
        .values({ workspaceId, prId, agentId, kind: 'review', createdAt: threeWeeksAgoNoon })
        .returning();
      const [reviewNew] = await pg.handle.db
        .insert(t.reviews)
        .values({ workspaceId, prId, agentId, kind: 'review' }) // defaults createdAt to now() → current week
        .returning();

      const base = {
        file: 'src/x.ts',
        startLine: 1,
        endLine: 1,
        category: 'correctness',
        title: 't',
        rationale: 'r',
        confidence: 0.9,
      };
      await pg.handle.db.insert(t.findings).values([
        { ...base, reviewId: reviewOld!.id, severity: 'CRITICAL', acceptedAt: new Date() },
        { ...base, reviewId: reviewOld!.id, severity: 'CRITICAL', acceptedAt: new Date() },
        { ...base, reviewId: reviewNew!.id, severity: 'WARNING', acceptedAt: new Date() },
        { ...base, reviewId: reviewNew!.id, severity: 'SUGGESTION', dismissedAt: new Date() },
      ]);

      // ---- 2 linked skills, in order — most_used_skills ranks by this order.
      const skill1 = (
        await app.inject({
          method: 'POST',
          url: '/skills',
          payload: { name: 'Skill One', type: 'rubric', body: 'x' },
        })
      ).json().id as string;
      const skill2 = (
        await app.inject({
          method: 'POST',
          url: '/skills',
          payload: { name: 'Skill Two', type: 'convention', body: 'x' },
        })
      ).json().id as string;
      await app.inject({
        method: 'POST',
        url: `/agents/${agentId}/skills`,
        payload: { skill_ids: [skill1, skill2] },
      });

      const res = await app.inject({ method: 'GET', url: `/agents/${agentId}/stats` });
      expect(res.statusCode).toBe(200);
      const body = res.json() as AgentStatsDetail;

      // ---- AC-10/11: base KPIs + cost delta -----------------------------------
      expect(body).toMatchObject({
        agent_id: agentId,
        agent_name: 'Agent Detail',
        runs: 4, // r1,r2,r3,r4 — CI run excluded
        findings_total: 4,
        accepted: 3,
        dismissed: 1,
        pending: 0,
        accept_rate: 0.75,
        dismiss_rate: 0.25,
        findings_by_severity: { CRITICAL: 2, WARNING: 1, SUGGESTION: 1 },
      });
      expect(body.total_cost_usd).toBeCloseTo(2.0 + 1.5 + 3.0 + 4.0, 5); // CI's 999 excluded
      // cost_delta_usd_30d = current-30d (2+1.5+3=6.5) − prior-30-60d (4.0) = 2.5.
      expect(body.cost_delta_usd_30d).toBeCloseTo(2.5, 5);

      // ---- AC-12: weekly_findings_by_severity — exactly 8 ordered points ------
      expect(body.weekly_findings_by_severity).toHaveLength(8);
      expect(body.weekly_findings_by_severity.map((w) => w.week_start)).toEqual(weekStarts);
      expect(body.weekly_findings_by_severity[4]).toEqual({
        week_start: weekStarts[4],
        CRITICAL: 2,
        WARNING: 0,
        SUGGESTION: 0,
      });
      expect(body.weekly_findings_by_severity[7]).toEqual({
        week_start: weekStarts[7],
        CRITICAL: 0,
        WARNING: 1,
        SUGGESTION: 1,
      });
      // Every other week had zero findings of every severity — zero-filled, not omitted.
      const otherIndices = [0, 1, 2, 3, 5, 6];
      for (const i of otherIndices) {
        expect(body.weekly_findings_by_severity[i]).toEqual({
          week_start: weekStarts[i],
          CRITICAL: 0,
          WARNING: 0,
          SUGGESTION: 0,
        });
      }

      // ---- AC-13: most_used_skills — ranked by link order, flat usage_estimate ---
      expect(body.most_used_skills).toEqual([
        { id: skill1, name: 'Skill One', usage_estimate: 4 },
        { id: skill2, name: 'Skill Two', usage_estimate: 4 },
      ]);

      // ---- AC-14: memory_pulled_summary is always an honest empty read -----------
      expect(body.memory_pulled_summary).toEqual([]);

      // ---- AC-15/26: run_history is studio-only (source='local'), newest-first ---
      expect(body.run_history.map((r) => r.cost_usd)).toEqual([2.0, 1.5, 3.0, 4.0]);
      expect(body.run_history.every((r) => r.cost_usd !== 999.0)).toBe(true);

      await app.close();
    },
  );

  it('most_used_skills is empty when the agent has no linked skills (AC-13)', async () => {
    const workspaceId = await makeWorkspace('detail-noskills-ws');
    const app = await appFor(workspaceId);
    const agentId = await createAgent(app, 'Agent No Skills');

    const res = await app.inject({ method: 'GET', url: `/agents/${agentId}/stats` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as AgentStatsDetail;
    expect(body.most_used_skills).toEqual([]);
    expect(body.memory_pulled_summary).toEqual([]);
    expect(body.run_history).toEqual([]);

    await app.close();
  });

  it('returns 404 for a cross-workspace / unknown agent id — never another workspace\'s data (AC-24)', async () => {
    const wsA = await makeWorkspace('detail-scope-a');
    const wsB = await makeWorkspace('detail-scope-b');
    const appA = await appFor(wsA);
    const appB = await appFor(wsB);

    const agentInB = await createAgent(appB, 'Tenant B Agent');

    // Requested through tenant A's context — the agent genuinely exists, just not here.
    const res = await appA.inject({ method: 'GET', url: `/agents/${agentInB}/stats` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } });

    const ghost = '00000000-0000-0000-0000-000000000000';
    const res2 = await appA.inject({ method: 'GET', url: `/agents/${ghost}/stats` });
    expect(res2.statusCode).toBe(404);

    await appA.close();
    await appB.close();
  });
});
