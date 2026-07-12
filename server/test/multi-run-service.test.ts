/**
 * Hermetic tests for `MultiRunService.estimatesForPr` (service-level averaging)
 * and `run.repo.ts`'s `lastSuccessfulRuns` (repository-level query shape) —
 * Multi-Agent Review, plan Step 4. No Postgres, no Docker.
 *
 * `MultiRunService` constructs its own `ReviewRepository` internally (mirrors
 * `ReviewService`'s constructor) — rather than fake `container.db` through the
 * full innerJoin/where/orderBy/limit chain for the SERVICE-level tests, spy on
 * `ReviewRepository.prototype.{getPull,lastSuccessfulRuns}` directly (same
 * established pattern as `vi.spyOn(ContextDocsService.prototype, ...)` in
 * `test/run-executor-context-docs.test.ts`). The repository-level query SHAPE
 * (workspace/agent/repo/status scoping + limit) is verified separately below
 * against a hand-rolled fake `Db`, mirroring `test/multi-run-repo.test.ts`'s
 * `extractEqPairs` convention.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Column } from 'drizzle-orm';
import type { SQL, SQLChunk } from 'drizzle-orm';
import { MultiRunService } from '../src/modules/reviews/multi-run.service.js';
import { ReviewRepository, type PullRow } from '../src/modules/reviews/repository.js';
import { lastSuccessfulRuns } from '../src/modules/reviews/repository/run.repo.js';
import { MULTI_AGENT_CONCURRENCY_CAP } from '../src/modules/reviews/constants.js';
import type { Db } from '../src/db/client.js';
import type { Container } from '../src/platform/container.js';
import type { AgentRow } from '../src/db/rows.js';

const WS_ID = '11111111-1111-1111-1111-111111111111';
const PR_ID = '22222222-2222-2222-2222-222222222222';
const REPO_ID = '33333333-3333-3333-3333-333333333333';

function makeAgent(id: string, name: string): AgentRow {
  return { id, workspaceId: WS_ID, name, enabled: true } as unknown as AgentRow;
}

function makeContainer(agents: AgentRow[]): Container {
  return {
    db: {} as Db,
    agentsRepo: { listEnabled: vi.fn().mockResolvedValue(agents), getById: vi.fn() },
  } as unknown as Container;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// MultiRunService.estimatesForPr — service-level averaging
// ---------------------------------------------------------------------------

describe('MultiRunService.estimatesForPr', () => {
  it('(a) averages duration over exactly the rows lastSuccessfulRuns(limit:3) returns, and averages cost only over rows with a known cost_usd', async () => {
    const agent = makeAgent('agent-1', 'Agent One');
    vi.spyOn(ReviewRepository.prototype, 'getPull').mockResolvedValue({
      id: PR_ID,
      repoId: REPO_ID,
    } as PullRow);
    const spy = vi.spyOn(ReviewRepository.prototype, 'lastSuccessfulRuns').mockResolvedValue([
      { durationMs: 1000, costUsd: 0.01 },
      { durationMs: 2000, costUsd: 0.02 },
      // A 3rd row with unknown cost — excluded from the COST average only,
      // still counted in duration average and sample_size.
      { durationMs: 3000, costUsd: null },
    ]);

    const service = new MultiRunService(makeContainer([agent]));
    const estimates = await service.estimatesForPr(WS_ID, PR_ID);

    expect(estimates).toEqual([
      { agent_id: 'agent-1', avg_duration_ms: 2000, avg_cost_usd: 0.015, sample_size: 3 },
    ]);
    // limit:3 was requested from the repository — the "4th-oldest excluded"
    // half of AC-7 is the repository query's job (verified below); the
    // service must simply pass limit:3 through untouched.
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS_ID, agentId: 'agent-1', repoId: REPO_ID, limit: 3 }),
    );
  });

  it('(b) an agent with zero successful runs returns null averages and sample_size 0', async () => {
    const agent = makeAgent('agent-2', 'Agent Two');
    vi.spyOn(ReviewRepository.prototype, 'getPull').mockResolvedValue({
      id: PR_ID,
      repoId: REPO_ID,
    } as PullRow);
    vi.spyOn(ReviewRepository.prototype, 'lastSuccessfulRuns').mockResolvedValue([]);

    const service = new MultiRunService(makeContainer([agent]));
    const estimates = await service.estimatesForPr(WS_ID, PR_ID);

    expect(estimates).toEqual([
      { agent_id: 'agent-2', avg_duration_ms: null, avg_cost_usd: null, sample_size: 0 },
    ]);
  });

  it('(c) one all-null agent never conflates with another agent’s real numbers in the same call', async () => {
    const zeroHistoryAgent = makeAgent('agent-zero', 'Zero History');
    const realHistoryAgent = makeAgent('agent-real', 'Real History');
    vi.spyOn(ReviewRepository.prototype, 'getPull').mockResolvedValue({
      id: PR_ID,
      repoId: REPO_ID,
    } as PullRow);
    vi.spyOn(ReviewRepository.prototype, 'lastSuccessfulRuns').mockImplementation(
      async (params: { agentId: string }) =>
        params.agentId === 'agent-zero' ? [] : [{ durationMs: 5000, costUsd: 0.05 }],
    );

    const service = new MultiRunService(makeContainer([zeroHistoryAgent, realHistoryAgent]));
    const estimates = await service.estimatesForPr(WS_ID, PR_ID);

    expect(estimates).toEqual([
      { agent_id: 'agent-zero', avg_duration_ms: null, avg_cost_usd: null, sample_size: 0 },
      { agent_id: 'agent-real', avg_duration_ms: 5000, avg_cost_usd: 0.05, sample_size: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// MultiRunService.getComposedRun — AC-17 (error) / AC-33 (tokens) additive
// contract extension. A hand-rolled sequenced fake `Db` drives the THREE
// `multi-run.repo.ts` functions `getComposedRun` calls in order
// (getGroupScoped → listAgentRunsForGroup → findingsAndReviewsForRuns, the
// latter itself issuing up to 2 more `select()` calls) — mirrors
// `test/multi-run-repo.test.ts`'s `makeSequencedSelectDb` convention exactly
// (duplicated locally per this test suite's own established pattern, not
// imported cross-file).
// ---------------------------------------------------------------------------

const GROUP_ID = '77777777-7777-7777-7777-777777777777';
const RUN_DONE_ID = '88888888-8888-8888-8888-888888888888';
const RUN_FAILED_ID = '99999999-9999-9999-9999-999999999999';
const AGENT_DONE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const AGENT_FAILED_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const REVIEW_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

interface SeqChainCalls {
  where: unknown[];
  leftJoin: unknown[];
  orderBy: unknown[];
}

function seqSelectChain(rows: unknown[]) {
  const calls: SeqChainCalls = { where: [], leftJoin: [], orderBy: [] };
  const chain: Record<string, unknown> = {
    from: () => chain,
    leftJoin: (...args: unknown[]) => {
      calls.leftJoin.push(args);
      return chain;
    },
    where: (...args: unknown[]) => {
      calls.where.push(args);
      return chain;
    },
    orderBy: (...args: unknown[]) => {
      calls.orderBy.push(args);
      return chain;
    },
    then: (onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(onF, onR),
  };
  return chain;
}

/** Each successive `db.select()` call resolves to the NEXT row set, in call
 *  order: [group], [agent_runs], [reviews], [findings]. */
function makeSequencedSelectDb(rowSets: unknown[][]): Db {
  let callIndex = 0;
  return {
    select: (_cols?: Record<string, unknown>) => {
      const rows = rowSets[callIndex] ?? [];
      callIndex++;
      return seqSelectChain(rows);
    },
  } as unknown as Db;
}

function makeComposedRunContainer(rowSets: unknown[][]): Container {
  return {
    db: makeSequencedSelectDb(rowSets),
    agentsRepo: {
      listEnabled: vi.fn(),
      getById: vi.fn(async (_ws: string, id: string) =>
        id === AGENT_DONE_ID
          ? makeAgent(AGENT_DONE_ID, 'Done Agent')
          : id === AGENT_FAILED_ID
            ? makeAgent(AGENT_FAILED_ID, 'Failed Agent')
            : undefined,
      ),
    },
  } as unknown as Container;
}

describe('MultiRunService.getComposedRun', () => {
  it('(a) a failed column carries agent_runs.error through to AgentColumn.error (AC-17), and a done column has error: null', async () => {
    const groupRow = { id: GROUP_ID, prId: PR_ID, ranAt: new Date('2026-07-10T00:00:00Z'), prNumber: 42 };
    const runRows = [
      {
        id: RUN_DONE_ID,
        agentId: AGENT_DONE_ID,
        provider: 'openai',
        model: 'gpt-5',
        status: 'done',
        error: null,
        durationMs: 5000,
        costUsd: 0.01,
        tokensIn: 12000,
        tokensOut: 1500,
        ranAt: new Date('2026-07-10T00:00:00Z'),
      },
      {
        id: RUN_FAILED_ID,
        agentId: AGENT_FAILED_ID,
        provider: 'openai',
        model: 'gpt-5',
        status: 'failed',
        error: 'Provider timeout after 60s',
        durationMs: 1200,
        costUsd: null,
        tokensIn: null,
        tokensOut: null,
        ranAt: new Date('2026-07-10T00:00:05Z'),
      },
    ];
    const reviewRows = [{ id: REVIEW_ID, runId: RUN_DONE_ID, verdict: 'approve', summary: 'ok', score: 90 }];
    const findingRows: unknown[] = [];

    const service = new MultiRunService(
      makeComposedRunContainer([[groupRow], runRows, reviewRows, findingRows]),
    );
    const composed = await service.getComposedRun(WS_ID, GROUP_ID);

    const doneCol = composed?.columns.find((c) => c.run_id === RUN_DONE_ID);
    const failedCol = composed?.columns.find((c) => c.run_id === RUN_FAILED_ID);

    expect(doneCol?.error).toBeNull();
    expect(failedCol?.error).toBe('Provider timeout after 60s');
  });

  it('(b) tokens_in/tokens_out are surfaced per column, straight from agent_runs', async () => {
    const groupRow = { id: GROUP_ID, prId: PR_ID, ranAt: new Date('2026-07-10T00:00:00Z'), prNumber: 42 };
    const runRows = [
      {
        id: RUN_DONE_ID,
        agentId: AGENT_DONE_ID,
        provider: 'openai',
        model: 'gpt-5',
        status: 'done',
        error: null,
        durationMs: 5000,
        costUsd: 0.01,
        tokensIn: 12000,
        tokensOut: 1500,
        ranAt: new Date('2026-07-10T00:00:00Z'),
      },
    ];
    const reviewRows = [{ id: REVIEW_ID, runId: RUN_DONE_ID, verdict: 'approve', summary: 'ok', score: 90 }];

    const service = new MultiRunService(makeComposedRunContainer([[groupRow], runRows, reviewRows, []]));
    const composed = await service.getComposedRun(WS_ID, GROUP_ID);

    expect(composed?.columns[0]).toMatchObject({ tokens_in: 12000, tokens_out: 1500 });
  });

  it('(c) total_tokens_in/total_tokens_out are null when ANY column is unknown, else the sum (mirrors total_cost_usd)', async () => {
    const groupRow = { id: GROUP_ID, prId: PR_ID, ranAt: new Date('2026-07-10T00:00:00Z'), prNumber: 42 };
    const runRowsWithUnknown = [
      {
        id: RUN_DONE_ID,
        agentId: AGENT_DONE_ID,
        provider: 'openai',
        model: 'gpt-5',
        status: 'done',
        error: null,
        durationMs: 5000,
        costUsd: 0.01,
        tokensIn: 12000,
        tokensOut: 1500,
        ranAt: new Date('2026-07-10T00:00:00Z'),
      },
      {
        id: RUN_FAILED_ID,
        agentId: AGENT_FAILED_ID,
        provider: 'openai',
        model: 'gpt-5',
        status: 'failed',
        error: 'boom',
        durationMs: 1200,
        costUsd: null,
        tokensIn: null,
        tokensOut: null,
        ranAt: new Date('2026-07-10T00:00:05Z'),
      },
    ];

    const serviceWithUnknown = new MultiRunService(
      makeComposedRunContainer([
        [groupRow],
        runRowsWithUnknown,
        [{ id: REVIEW_ID, runId: RUN_DONE_ID, verdict: 'approve', summary: 'ok', score: 90 }],
        [],
      ]),
    );
    const composedWithUnknown = await serviceWithUnknown.getComposedRun(WS_ID, GROUP_ID);
    expect(composedWithUnknown?.total_tokens_in).toBeNull();
    expect(composedWithUnknown?.total_tokens_out).toBeNull();

    // Every run has a known token count → sum, not null.
    const runRowsAllKnown = [
      runRowsWithUnknown[0]!,
      { ...runRowsWithUnknown[1]!, tokensIn: 3000, tokensOut: 400 },
    ];
    const serviceAllKnown = new MultiRunService(
      makeComposedRunContainer([
        [groupRow],
        runRowsAllKnown,
        [{ id: REVIEW_ID, runId: RUN_DONE_ID, verdict: 'approve', summary: 'ok', score: 90 }],
        [],
      ]),
    );
    const composedAllKnown = await serviceAllKnown.getComposedRun(WS_ID, GROUP_ID);
    expect(composedAllKnown?.total_tokens_in).toBe(15000);
    expect(composedAllKnown?.total_tokens_out).toBe(1900);
  });

  it('(d) a foreign-workspace group short-circuits BEFORE listAgentRunsForGroup/findingsAndReviewsForRuns run', async () => {
    // `listAgentRunsForGroup`/`findingsAndReviewsForRuns` carry NO workspace
    // filter of their own (see multi-run.repo.ts) — they are safe to call only
    // because `getComposedRun` always gates through `getGroupScoped` first and
    // returns early when it finds nothing for this workspace. This test proves
    // that early return actually happens: only ONE `db.select()` call (the
    // `getGroupScoped` query itself) is made — the two unscoped functions are
    // never reached for a group that doesn't belong to this workspace.
    let selectCallCount = 0;
    const db = {
      select: (_cols?: Record<string, unknown>) => {
        selectCallCount++;
        return seqSelectChain([]); // getGroupScoped finds no row for this workspace
      },
    } as unknown as Db;
    const container = {
      db,
      agentsRepo: { listEnabled: vi.fn(), getById: vi.fn() },
    } as unknown as Container;

    const service = new MultiRunService(container);
    const composed = await service.getComposedRun(WS_ID, GROUP_ID);

    expect(composed).toBeUndefined();
    expect(selectCallCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// MultiRunService.getComposedRun — total_duration_ms two-phase rule (§4
// "Additional constraints": while any column is 'running', elapsed wall-clock
// since the group started; once every column has settled,
// max(run.ran_at + run.duration_ms) - group.ran_at — NOT "elapsed since start
// to now", which would keep growing forever after completion.
// ---------------------------------------------------------------------------

describe('MultiRunService.getComposedRun — total_duration_ms two-phase rule', () => {
  it('while any column is still running, total_duration_ms is elapsed wall-clock since the group started (not the done column(s) own duration)', async () => {
    const groupRanAt = new Date(Date.now() - 5000); // group started 5s ago
    const groupRow = { id: GROUP_ID, prId: PR_ID, ranAt: groupRanAt, prNumber: 42 };
    const runRows = [
      {
        id: RUN_DONE_ID,
        agentId: AGENT_DONE_ID,
        provider: 'openai',
        model: 'gpt-5',
        status: 'done',
        error: null,
        durationMs: 500,
        costUsd: 0.01,
        tokensIn: 100,
        tokensOut: 50,
        ranAt: groupRanAt,
      },
      {
        id: RUN_FAILED_ID,
        agentId: AGENT_FAILED_ID,
        provider: 'openai',
        model: 'gpt-5',
        status: 'running',
        error: null,
        durationMs: null,
        costUsd: null,
        tokensIn: null,
        tokensOut: null,
        ranAt: groupRanAt,
      },
    ];
    const reviewRows = [{ id: REVIEW_ID, runId: RUN_DONE_ID, verdict: 'approve', summary: 'ok', score: 90 }];

    const service = new MultiRunService(makeComposedRunContainer([[groupRow], runRows, reviewRows, []]));
    const composed = await service.getComposedRun(WS_ID, GROUP_ID);

    // The 'settled' formula would give max(ran_at + duration_ms) - group.ran_at
    // = 500ms (the one done run) — since a column is still 'running', the rule
    // must instead reflect elapsed wall-clock since the group started (~5000ms).
    expect(composed!.total_duration_ms).toBeGreaterThanOrEqual(5000);
    expect(composed!.total_duration_ms).not.toBe(500);
  });

  it('once every column has settled, total_duration_ms is max(run.ran_at + run.duration_ms) - group.ran_at — NOT elapsed-since-start-to-now', async () => {
    // A group that "started" long before this test runs — real wall-clock
    // elapsed since then is huge. If the implementation used
    // `Date.now() - group.ran_at` unconditionally (the growing-forever bug
    // this rule guards against), the assertion below would fail by orders of
    // magnitude instead of matching the fixed expected value.
    const groupRanAt = new Date('2026-01-01T00:00:00.000Z');
    const groupRow = { id: GROUP_ID, prId: PR_ID, ranAt: groupRanAt, prNumber: 42 };
    const runRows = [
      {
        id: RUN_DONE_ID,
        agentId: AGENT_DONE_ID,
        provider: 'openai',
        model: 'gpt-5',
        status: 'done',
        error: null,
        durationMs: 3000,
        costUsd: 0.01,
        tokensIn: 100,
        tokensOut: 50,
        ranAt: groupRanAt,
      },
      {
        id: RUN_FAILED_ID,
        agentId: AGENT_FAILED_ID,
        provider: 'openai',
        model: 'gpt-5',
        status: 'done',
        error: null,
        durationMs: 7000, // the later-finishing run determines the group total
        costUsd: 0.02,
        tokensIn: 200,
        tokensOut: 80,
        ranAt: groupRanAt,
      },
    ];
    const reviewRows = [
      { id: REVIEW_ID, runId: RUN_DONE_ID, verdict: 'approve', summary: 'ok', score: 90 },
      { id: 'review-2', runId: RUN_FAILED_ID, verdict: 'approve', summary: 'ok', score: 88 },
    ];

    const service = new MultiRunService(makeComposedRunContainer([[groupRow], runRows, reviewRows, []]));
    const composed = await service.getComposedRun(WS_ID, GROUP_ID);

    expect(composed!.total_duration_ms).toBe(7000);
  });

  it('once every column has settled AND the agent count exceeds MULTI_AGENT_CONCURRENCY_CAP, total_duration_ms accounts for queueing delay via list-scheduling simulation — NOT naive max(ran_at + duration_ms), which undercounts', async () => {
    // `MULTI_AGENT_CONCURRENCY_CAP` runs each take 5000ms and start
    // immediately (t=0, one per worker, all sharing the SAME ran_at since
    // every agent_runs row is created up front in `startRun`'s loop before
    // the worker pool ever dequeues anything). ONE more run is queued behind
    // the cap: it only starts once a worker frees at t=5000, and its own
    // ACTIVE execution is just 100ms — real finish = 5100. A naive
    // max(ran_at + duration_ms) - group.ran_at would compute 5000 here (the
    // cap runs' own duration, since the queued run's ran_at+duration_ms =
    // 0+100 = 100 loses) — the exact undercounting bug this test guards
    // against.
    const groupRanAt = new Date('2026-01-01T00:00:00.000Z');
    const groupRow = { id: GROUP_ID, prId: PR_ID, ranAt: groupRanAt, prNumber: 42 };

    const fullWorkerRuns = Array.from({ length: MULTI_AGENT_CONCURRENCY_CAP }, (_, i) => ({
      id: `full-worker-run-${i}`,
      agentId: AGENT_DONE_ID,
      provider: 'openai',
      model: 'gpt-5',
      status: 'done',
      error: null,
      durationMs: 5000,
      costUsd: 0.01,
      tokensIn: 100,
      tokensOut: 50,
      ranAt: groupRanAt,
    }));
    const queuedRun = {
      id: 'queued-run',
      agentId: AGENT_DONE_ID,
      provider: 'openai',
      model: 'gpt-5',
      status: 'done',
      error: null,
      durationMs: 100,
      costUsd: 0.001,
      tokensIn: 20,
      tokensOut: 5,
      ranAt: groupRanAt,
    };
    const runRows = [...fullWorkerRuns, queuedRun];
    const reviewRows = runRows.map((r, i) => ({
      id: `review-${i}`,
      runId: r.id,
      verdict: 'approve',
      summary: 'ok',
      score: 90,
    }));

    const service = new MultiRunService(makeComposedRunContainer([[groupRow], runRows, reviewRows, []]));
    const composed = await service.getComposedRun(WS_ID, GROUP_ID);

    expect(composed!.total_duration_ms).toBe(5100);
    expect(composed!.total_duration_ms).not.toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// run.repo.ts's lastSuccessfulRuns — repository query shape
// ---------------------------------------------------------------------------

/** Walks a real drizzle-orm `eq()`/`and()` SQL condition tree and extracts
 *  {columnName: boundValue} pairs — mirrors `test/multi-run-repo.test.ts`'s
 *  `extractEqPairs` convention verbatim. */
function extractEqPairs(node: unknown): Record<string, unknown> {
  const pairs: Record<string, unknown> = {};

  function walk(chunks: SQLChunk[]): void {
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (chunk instanceof Column) {
        const maybeValueChunk = chunks[i + 2] as unknown;
        const value = extractBoundValue(maybeValueChunk);
        if (value !== undefined) pairs[chunk.name] = value;
      } else if (isSqlLike(chunk)) {
        walk((chunk as SQL).queryChunks);
      }
    }
  }
  function isSqlLike(x: unknown): x is SQL {
    return !!x && typeof x === 'object' && Array.isArray((x as SQL).queryChunks);
  }
  function extractBoundValue(x: unknown): unknown {
    if (x && typeof x === 'object' && 'value' in (x as Record<string, unknown>)) {
      return (x as { value: unknown }).value;
    }
    return x;
  }
  if (isSqlLike(node)) walk((node as SQL).queryChunks);
  return pairs;
}

interface ChainCalls {
  where: unknown[][];
  innerJoin: unknown[][];
  orderBy: unknown[][];
  limit: number[];
}

function makeChainDb(rows: unknown[]): { db: Db; calls: ChainCalls } {
  const calls: ChainCalls = { where: [], innerJoin: [], orderBy: [], limit: [] };
  const chain: Record<string, unknown> = {
    from: () => chain,
    innerJoin: (...args: unknown[]) => {
      calls.innerJoin.push(args);
      return chain;
    },
    where: (...args: unknown[]) => {
      calls.where.push(args);
      return chain;
    },
    orderBy: (...args: unknown[]) => {
      calls.orderBy.push(args);
      return chain;
    },
    limit: (n: number) => {
      calls.limit.push(n);
      return Promise.resolve(rows);
    },
  };
  const db = { select: (_cols?: Record<string, unknown>) => chain } as unknown as Db;
  return { db, calls };
}

describe('lastSuccessfulRuns (repository query shape)', () => {
  it('scopes by workspace_id/agent_id/repo_id, filters status=done, and passes limit through', async () => {
    const { db, calls } = makeChainDb([{ durationMs: 111, costUsd: 0.5 }]);

    const result = await lastSuccessfulRuns(db, {
      workspaceId: WS_ID,
      agentId: 'agent-1',
      repoId: REPO_ID,
      limit: 3,
    });

    expect(result).toEqual([{ durationMs: 111, costUsd: 0.5 }]);
    expect(calls.limit).toEqual([3]);
    expect(calls.where).toHaveLength(1);
    const pairs = extractEqPairs(calls.where[0]![0]);
    expect(pairs.workspace_id).toBe(WS_ID);
    expect(pairs.agent_id).toBe('agent-1');
    expect(pairs.repo_id).toBe(REPO_ID);
    expect(pairs.status).toBe('done');
  });

  it('maps a null duration_ms to 0 and passes a null cost_usd through unchanged', async () => {
    const { db } = makeChainDb([{ durationMs: null, costUsd: null }]);

    const result = await lastSuccessfulRuns(db, {
      workspaceId: WS_ID,
      agentId: 'agent-1',
      repoId: REPO_ID,
      limit: 3,
    });

    expect(result).toEqual([{ durationMs: 0, costUsd: null }]);
  });
});
