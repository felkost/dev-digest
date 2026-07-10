import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { waitForPrRuns } from './helpers/runs.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import { MockLLMProvider, MockGitClient } from '../src/adapters/mocks.js';
import * as t from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import type { Review } from '@devdigest/shared';
import type {
  LLMProvider,
  ModelInfo,
  CompletionRequest,
  CompletionResult,
  StructuredRequest,
  StructuredResult,
} from '@devdigest/shared';

/**
 * Full end-to-end integration test for Multi-Agent Review (Development Plan
 * `docs/plans/2026-07-09-multi-agent-review.md`, Step 4). Real Testcontainers
 * Postgres, mocked LLM/git only — per `server/AGENTS.md`'s `.it.test.ts`
 * convention ("never mock the database").
 */

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const config = () => loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

/** A unified diff touching src/config.ts (line 11 added) — matches reviews.it.test.ts. */
const DIFF = `diff --git a/src/config.ts b/src/config.ts
--- a/src/config.ts
+++ b/src/config.ts
@@ -10,3 +10,4 @@
   port: 3000,
+  stripeKey: "sk_live_xxx",
   redisUrl: x,`;

/** One agent flags a real (grounded) CRITICAL finding on line 11. */
const FLAG_REVIEW: Review = {
  verdict: 'request_changes',
  summary: 'Hardcoded Stripe secret introduced.',
  score: 42,
  findings: [
    {
      id: 'f-flag',
      severity: 'CRITICAL',
      category: 'security',
      title: 'Hardcoded Stripe secret key',
      file: 'src/config.ts',
      start_line: 11,
      end_line: 11,
      rationale: 'A live Stripe key is committed in source.',
      confidence: 0.95,
      kind: 'finding',
    },
  ],
};

/** The other agent reviews the same PR and flags nothing — sets up a
 *  cross-agent conflict at (src/config.ts, line 11). */
const CLEAN_REVIEW: Review = {
  verdict: 'approve',
  summary: 'Looks fine.',
  score: 95,
  findings: [],
};

/** A test-file-only delayed LLM wrapper — adds a fixed delay before
 *  `completeStructured` delegates, so AC-44's wall-clock assertion can prove
 *  the fan-out actually runs agents CONCURRENTLY (total time ≈ one delay, not
 *  N × delay), without a tight/flaky ratio. */
class DelayedLLMProvider implements LLMProvider {
  readonly id: 'openai' | 'anthropic' | 'openrouter';
  constructor(
    private inner: LLMProvider,
    private delayMs: number,
  ) {
    this.id = inner.id;
  }
  listModels(): Promise<ModelInfo[]> {
    return this.inner.listModels();
  }
  complete(req: CompletionRequest): Promise<CompletionResult> {
    return this.inner.complete(req);
  }
  async completeStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    await new Promise((r) => setTimeout(r, this.delayMs));
    return this.inner.completeStructured(req);
  }
  embed(texts: string[]): Promise<number[][]> {
    return this.inner.embed(texts);
  }
}

let repoSeq = 0;
async function setupRepoAndPr(db: PgFixture['handle']['db'], workspaceId: string) {
  const name = `multi-run-repo-${repoSeq++}`;
  const [repo] = await db
    .insert(t.repos)
    .values({ workspaceId, owner: 'acme', name, fullName: `acme/${name}` })
    .returning();
  const [pr] = await db
    .insert(t.pullRequests)
    .values({
      workspaceId,
      repoId: repo!.id,
      number: 900 + repoSeq,
      title: 'Add rate limiting',
      author: 'marisa.koch',
      branch: 'feat/rl',
      base: 'main',
      headSha: 'a1b2c3d4',
      additions: 1,
      deletions: 0,
      filesCount: 1,
      status: 'needs_review',
      body: 'Add rate limiting.',
    })
    .returning();
  await db.insert(t.prFiles).values({
    prId: pr!.id,
    path: 'src/config.ts',
    additions: 1,
    deletions: 0,
    patch: '@@ -10,3 +10,4 @@\n   port: 3000,\n+  stripeKey: "sk_live_xxx",\n   redisUrl: x,',
  });
  return { repo: repo!, pr: pr! };
}

d('Multi-Agent Review (Testcontainers pg, Development Plan Step 4)', () => {
  let pg: PgFixture;
  let workspaceId: string;

  beforeAll(async () => {
    pg = await startPg();
    await seed(pg.handle.db);
    const [ws] = await pg.handle.db.select().from(t.workspaces);
    workspaceId = ws!.id;
  });
  afterAll(async () => {
    await pg?.stop();
  });

  function appWith(llmByProvider: Record<'openai' | 'anthropic', LLMProvider>) {
    return buildApp({
      config: config(),
      db: pg.handle.db,
      overrides: {
        git: new MockGitClient({ diff: DIFF }),
        llm: llmByProvider,
      },
    });
  }

  it('(a) creates one multi_agent_runs group + N linked agent_runs rows for 2+ agentIds', async () => {
    const app = await appWith({
      openai: new MockLLMProvider('openai', { structured: FLAG_REVIEW }),
      anthropic: new MockLLMProvider('anthropic', { structured: CLEAN_REVIEW }),
    });
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);

    const agentA = (
      await app.inject({
        method: 'POST',
        url: '/agents',
        payload: { name: 'Flagger', provider: 'openai', model: 'gpt-4.1', system_prompt: 'p' },
      })
    ).json();
    const agentB = (
      await app.inject({
        method: 'POST',
        url: '/agents',
        payload: { name: 'Cleaner', provider: 'anthropic', model: 'claude-x', system_prompt: 'p' },
      })
    ).json();

    const res = await app.inject({
      method: 'POST',
      url: `/pulls/${pr.id}/multi-agent-run`,
      payload: { agentIds: [agentA.id, agentB.id] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.pr_id).toBe(pr.id);
    expect(body.runs).toHaveLength(2);
    expect(body.multi_agent_run_id).toBeTruthy();

    const [group] = await pg.handle.db
      .select()
      .from(t.multiAgentRuns)
      .where(eq(t.multiAgentRuns.id, body.multi_agent_run_id));
    expect(group).toBeDefined();
    expect(group!.prId).toBe(pr.id);

    const linkedRuns = await pg.handle.db
      .select()
      .from(t.agentRuns)
      .where(eq(t.agentRuns.multiAgentRunId, body.multi_agent_run_id));
    expect(linkedRuns).toHaveLength(2);

    // Empty agentIds → validation error, not a silent no-op group.
    const emptyRes = await app.inject({
      method: 'POST',
      url: `/pulls/${pr.id}/multi-agent-run`,
      payload: { agentIds: [] },
    });
    expect(emptyRes.statusCode).toBe(400);

    await app.close();
  });

  it('(c) GET /multi-agent-runs/:id returns the composed shape with correct conflicts once all done', async () => {
    const app = await appWith({
      openai: new MockLLMProvider('openai', { structured: FLAG_REVIEW }),
      anthropic: new MockLLMProvider('anthropic', { structured: CLEAN_REVIEW }),
    });
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);

    const agentA = (
      await app.inject({
        method: 'POST',
        url: '/agents',
        payload: { name: 'Flagger 2', provider: 'openai', model: 'gpt-4.1', system_prompt: 'p' },
      })
    ).json();
    const agentB = (
      await app.inject({
        method: 'POST',
        url: '/agents',
        payload: { name: 'Cleaner 2', provider: 'anthropic', model: 'claude-x', system_prompt: 'p' },
      })
    ).json();

    const started = (
      await app.inject({
        method: 'POST',
        url: `/pulls/${pr.id}/multi-agent-run`,
        payload: { agentIds: [agentA.id, agentB.id] },
      })
    ).json();

    await waitForPrRuns(pg.handle.db, pr.id, { expected: 2 });

    const composedRes = await app.inject({
      method: 'GET',
      url: `/multi-agent-runs/${started.multi_agent_run_id}`,
    });
    expect(composedRes.statusCode).toBe(200);
    const composed = composedRes.json();

    expect(composed.pr_id).toBe(pr.id);
    expect(composed.agent_count).toBe(2);
    expect(composed.columns).toHaveLength(2);
    const flaggerCol = composed.columns.find((c: { agent_id: string }) => c.agent_id === agentA.id);
    const cleanerCol = composed.columns.find((c: { agent_id: string }) => c.agent_id === agentB.id);
    expect(flaggerCol.status).toBe('done');
    expect(cleanerCol.status).toBe('done');
    expect(flaggerCol.findings).toHaveLength(1);
    expect(cleanerCol.findings).toHaveLength(0);

    // Cross-agent conflict at (src/config.ts, line 11): Flagger takes CRITICAL,
    // Cleaner takes 'ignored'.
    expect(composed.conflicts).toHaveLength(1);
    const conflict = composed.conflicts[0];
    expect(conflict.file).toBe('src/config.ts');
    expect(conflict.line).toBe(11);
    expect(conflict.takes).toHaveLength(2);
    const flaggerTake = conflict.takes.find((tk: { agent_id: string }) => tk.agent_id === agentA.id);
    const cleanerTake = conflict.takes.find((tk: { agent_id: string }) => tk.agent_id === agentB.id);
    expect(flaggerTake.verdict).toBe('CRITICAL');
    expect(cleanerTake.verdict).toBe('ignored');

    // Both settled → total_duration_ms is a finite, non-growing number (not the
    // "still running" elapsed-since-start branch).
    expect(typeof composed.total_duration_ms).toBe('number');
    expect(composed.total_duration_ms).toBeGreaterThanOrEqual(0);
    // Every run's cost is known (MockLLMProvider always returns 0.001) → summed.
    expect(composed.total_cost_usd).toBeCloseTo(0.002, 5);

    await app.close();
  });

  it('(d) GET /multi-agent-runs/:id 404s for a group belonging to a different workspace', async () => {
    const app = await appWith({
      openai: new MockLLMProvider('openai', { structured: CLEAN_REVIEW }),
      anthropic: new MockLLMProvider('anthropic', { structured: CLEAN_REVIEW }),
    });

    // A second, foreign workspace + its own repo/PR, so the group row has a
    // valid (but foreign) prId FK.
    const [otherWs] = await pg.handle.db
      .insert(t.workspaces)
      .values({ name: `other-ws-${repoSeq++}` })
      .returning();
    const { pr: otherPr } = await setupRepoAndPr(pg.handle.db, otherWs!.id);
    const [foreignGroup] = await pg.handle.db
      .insert(t.multiAgentRuns)
      .values({ workspaceId: otherWs!.id, prId: otherPr.id })
      .returning();

    const res = await app.inject({ method: 'GET', url: `/multi-agent-runs/${foreignGroup!.id}` });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  describe('(e) rate limiting', () => {
    it('the route is registered with MULTI_AGENT_RUN_RATE_LIMIT (max: 10, 1 minute)', async () => {
      // NOTE (environment-gated limitation, same as
      // `brief-generator.it.test.ts`'s AC-16 block): this harness builds its
      // app via `loadConfig({ NODE_ENV: 'test' })`, the SAME `nodeEnv==='test'`
      // gate `src/app.ts` uses to skip registering `@fastify/rate-limit`
      // globally. A real 11th-rapid-call 429 therefore CANNOT fire in this
      // suite — asserting the STATIC route config (the single source of truth
      // both `multi-run.routes.ts` and this test import) is the honest,
      // non-brittle substitute.
      const { MULTI_AGENT_RUN_RATE_LIMIT } = await import('../src/modules/reviews/constants.js');
      expect(MULTI_AGENT_RUN_RATE_LIMIT).toEqual({ max: 10, timeWindow: '1 minute' });

      const app = await appWith({
        openai: new MockLLMProvider('openai', { structured: CLEAN_REVIEW }),
        anthropic: new MockLLMProvider('anthropic', { structured: CLEAN_REVIEW }),
      });
      const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);
      const agent = (
        await app.inject({
          method: 'POST',
          url: '/agents',
          payload: { name: 'Burst', provider: 'openai', model: 'gpt-4.1', system_prompt: 'p' },
        })
      ).json();

      // Confirm no live 429 fires under test env even after > max rapid calls —
      // documents the env-gate rather than asserting a false 429 never possible
      // in this harness.
      const results = await Promise.all(
        Array.from({ length: 12 }, () =>
          app.inject({
            method: 'POST',
            url: `/pulls/${pr.id}/multi-agent-run`,
            payload: { agentIds: [agent.id] },
          }),
        ),
      );
      expect(results.every((r) => r.statusCode !== 429)).toBe(true);

      await app.close();
    });
  });

  it('(b) AC-44: 3 concurrently-run agents finish well under 3x (generous <2x) a single delayed agent duration', async () => {
    const DELAY_MS = 300;

    // ---- Baseline: ONE agent, delayed, on its own PR. ----------------------
    const singleApp = await appWith({
      openai: new DelayedLLMProvider(new MockLLMProvider('openai', { structured: CLEAN_REVIEW }), DELAY_MS),
      anthropic: new MockLLMProvider('anthropic', { structured: CLEAN_REVIEW }),
    });
    const { pr: singlePr } = await setupRepoAndPr(pg.handle.db, workspaceId);
    const singleAgent = (
      await singleApp.inject({
        method: 'POST',
        url: '/agents',
        payload: { name: 'Baseline', provider: 'openai', model: 'gpt-4.1', system_prompt: 'p' },
      })
    ).json();
    const singleStart = Date.now();
    await singleApp.inject({
      method: 'POST',
      url: `/pulls/${singlePr.id}/review`,
      payload: { agentId: singleAgent.id },
    });
    await waitForPrRuns(pg.handle.db, singlePr.id, { expected: 1, timeoutMs: 15_000 });
    const singleDurationMs = Date.now() - singleStart;
    await singleApp.close();

    // ---- 3 agents, all delayed the SAME amount, run as one fan-out group. --
    const multiApp = await appWith({
      openai: new DelayedLLMProvider(new MockLLMProvider('openai', { structured: CLEAN_REVIEW }), DELAY_MS),
      anthropic: new MockLLMProvider('anthropic', { structured: CLEAN_REVIEW }),
    });
    const { pr: multiPr } = await setupRepoAndPr(pg.handle.db, workspaceId);
    const agentIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const a = (
        await multiApp.inject({
          method: 'POST',
          url: '/agents',
          payload: { name: `Concurrent ${i}`, provider: 'openai', model: 'gpt-4.1', system_prompt: 'p' },
        })
      ).json();
      agentIds.push(a.id);
    }

    const groupStart = Date.now();
    const startRes = await multiApp.inject({
      method: 'POST',
      url: `/pulls/${multiPr.id}/multi-agent-run`,
      payload: { agentIds },
    });
    expect(startRes.statusCode).toBe(200);
    await waitForPrRuns(pg.handle.db, multiPr.id, { expected: 3, timeoutMs: 15_000 });
    const groupDurationMs = Date.now() - groupStart;
    await multiApp.close();

    // Generous bound (per plan instructions: avoid a tight/flaky ratio) — proves
    // the 3 agents ran CONCURRENTLY (bounded by ~1 delay), not sequentially
    // (which would be ~3x a single agent's duration).
    expect(groupDurationMs).toBeLessThan(singleDurationMs * 2);
  }, 30_000);

  it('(f) GET /pulls/:id/agent-estimates reflects real seeded run history', async () => {
    const app = await appWith({
      openai: new MockLLMProvider('openai', { structured: CLEAN_REVIEW }),
      anthropic: new MockLLMProvider('anthropic', { structured: CLEAN_REVIEW }),
    });
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);

    const historyAgent = (
      await app.inject({
        method: 'POST',
        url: '/agents',
        payload: { name: 'History', provider: 'openai', model: 'gpt-4.1', system_prompt: 'p' },
      })
    ).json();
    const freshAgent = (
      await app.inject({
        method: 'POST',
        url: '/agents',
        payload: { name: 'Fresh', provider: 'openai', model: 'gpt-4.1', system_prompt: 'p' },
      })
    ).json();

    // Two successful runs, both against the SAME repo (agent-estimates scopes
    // by repoId), for historyAgent — run 1 on `pr` itself, run 2 on a second PR
    // created directly on `pr`'s repo (setupRepoAndPr always makes a fresh repo,
    // so a 2nd same-repo PR is inserted directly here instead).
    await app.inject({ method: 'POST', url: `/pulls/${pr.id}/review`, payload: { agentId: historyAgent.id } });
    await waitForPrRuns(pg.handle.db, pr.id, { expected: 1 });
    const [prRow] = await pg.handle.db.select().from(t.pullRequests).where(eq(t.pullRequests.id, pr.id));
    const [secondPr] = await pg.handle.db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId: prRow!.repoId,
        number: prRow!.number + 1,
        title: 'Second PR, same repo',
        author: 'marisa.koch',
        branch: 'feat/rl-2',
        base: 'main',
        headSha: 'b2c3d4e5',
        additions: 1,
        deletions: 0,
        filesCount: 1,
        status: 'needs_review',
        body: null,
      })
      .returning();
    await pg.handle.db.insert(t.prFiles).values({
      prId: secondPr!.id,
      path: 'src/config.ts',
      additions: 1,
      deletions: 0,
      patch: '@@ -10,3 +10,4 @@\n   port: 3000,\n+  stripeKey: "sk_live_xxx",\n   redisUrl: x,',
    });
    await app.inject({
      method: 'POST',
      url: `/pulls/${secondPr!.id}/review`,
      payload: { agentId: historyAgent.id },
    });
    await waitForPrRuns(pg.handle.db, secondPr!.id, { expected: 1 });

    const estimatesRes = await app.inject({ method: 'GET', url: `/pulls/${pr.id}/agent-estimates` });
    expect(estimatesRes.statusCode).toBe(200);
    const estimates = estimatesRes.json() as {
      agent_id: string;
      avg_duration_ms: number | null;
      avg_cost_usd: number | null;
      sample_size: number;
    }[];

    const historyEstimate = estimates.find((e) => e.agent_id === historyAgent.id);
    expect(historyEstimate).toBeDefined();
    expect(historyEstimate!.sample_size).toBe(2);
    expect(historyEstimate!.avg_cost_usd).toBeCloseTo(0.001, 5);
    expect(historyEstimate!.avg_duration_ms).toBeGreaterThanOrEqual(0);

    const freshEstimate = estimates.find((e) => e.agent_id === freshAgent.id);
    expect(freshEstimate).toBeDefined();
    expect(freshEstimate).toEqual({
      agent_id: freshAgent.id,
      avg_duration_ms: null,
      avg_cost_usd: null,
      sample_size: 0,
    });

    await app.close();
  });

  it('(g) AC-17/AC-33: a failed column surfaces agent_runs.error and null tokens (never returned); total_tokens_* is null while any column is unknown', async () => {
    const app = await appWith({
      // Fixture doesn't match the Review schema → completeStructured throws,
      // producing a genuinely FAILED run with a real error message and no
      // token counts (the LLM never returned).
      openai: new MockLLMProvider('openai', { structured: { not_a_valid_review: true } }),
      anthropic: new MockLLMProvider('anthropic', { structured: CLEAN_REVIEW }),
    });
    const { pr } = await setupRepoAndPr(pg.handle.db, workspaceId);

    const brokenAgent = (
      await app.inject({
        method: 'POST',
        url: '/agents',
        payload: { name: 'Broken', provider: 'openai', model: 'gpt-4.1', system_prompt: 'p' },
      })
    ).json();
    const workingAgent = (
      await app.inject({
        method: 'POST',
        url: '/agents',
        payload: { name: 'Working', provider: 'anthropic', model: 'claude-x', system_prompt: 'p' },
      })
    ).json();

    const started = (
      await app.inject({
        method: 'POST',
        url: `/pulls/${pr.id}/multi-agent-run`,
        payload: { agentIds: [brokenAgent.id, workingAgent.id] },
      })
    ).json();

    await waitForPrRuns(pg.handle.db, pr.id, { expected: 2 });

    const composedRes = await app.inject({
      method: 'GET',
      url: `/multi-agent-runs/${started.multi_agent_run_id}`,
    });
    expect(composedRes.statusCode).toBe(200);
    const composed = composedRes.json();

    const brokenCol = composed.columns.find((c: { agent_id: string }) => c.agent_id === brokenAgent.id);
    const workingCol = composed.columns.find((c: { agent_id: string }) => c.agent_id === workingAgent.id);

    expect(brokenCol.status).toBe('failed');
    expect(typeof brokenCol.error).toBe('string');
    expect(brokenCol.error.length).toBeGreaterThan(0);
    // The LLM never returned for the broken agent — tokens are genuinely
    // unknown, never coerced to 0.
    expect(brokenCol.tokens_in).toBeNull();
    expect(brokenCol.tokens_out).toBeNull();

    expect(workingCol.status).toBe('done');
    expect(workingCol.error).toBeNull();
    // MockLLMProvider always reports tokensIn:100/tokensOut:50.
    expect(workingCol.tokens_in).toBe(100);
    expect(workingCol.tokens_out).toBe(50);

    // total_tokens_in/out follow the null-if-any-unknown rule (mirrors total_cost_usd).
    expect(composed.total_tokens_in).toBeNull();
    expect(composed.total_tokens_out).toBeNull();

    await app.close();
  });
});
