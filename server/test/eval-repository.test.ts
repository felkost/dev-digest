/**
 * Hermetic tests for `EvalRepository` (L06) — every method must be
 * workspace-scoped, either directly (eval_batches has its own workspace_id
 * column) or transitively (eval_runs has none of its own — scope flows via
 * eval_cases.workspace_id or eval_batches.workspace_id).
 *
 * A hand-rolled fake `Db` satisfies the exact Drizzle chain shapes
 * `EvalRepository` calls, following the "sniff by requested column keys" /
 * chain-shape convention documented in `server/insights.md` and used by
 * `test/onboarding-repository.test.ts`. No Postgres, no Docker.
 */
import { describe, it, expect, vi } from 'vitest';
import { Column } from 'drizzle-orm';
import type { SQL, SQLChunk } from 'drizzle-orm';
import { EvalRepository } from '../src/modules/eval/repository.js';
import type { Db } from '../src/db/client.js';

const WS_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_WS_ID = '99999999-9999-9999-9999-999999999999';
const AGENT_ID = '22222222-2222-2222-2222-222222222222';
const CASE_ID = '33333333-3333-3333-3333-333333333333';
const BATCH_ID = '44444444-4444-4444-4444-444444444444';

const CASE_ROW = {
  id: CASE_ID,
  workspaceId: WS_ID,
  ownerKind: 'agent' as const,
  ownerId: AGENT_ID,
  name: 'case one',
  inputDiff: 'diff --git a/x b/x',
  inputFiles: null,
  inputMeta: null,
  expectedOutput: [],
  notes: null,
};

const BATCH_ROW = {
  id: BATCH_ID,
  workspaceId: WS_ID,
  agentId: AGENT_ID,
  kind: 'full' as const,
  status: 'clean' as const,
  agentSnapshot: {},
  recall: 1,
  precision: 1,
  citationAccuracy: 1,
  costUsd: 0.01,
  ranAt: new Date('2026-07-04T00:00:00Z'),
};

const RUN_ROW = {
  id: '55555555-5555-5555-5555-555555555555',
  caseId: CASE_ID,
  ranAt: new Date('2026-07-04T00:00:00Z'),
  actualOutput: {},
  pass: true,
  recall: 1,
  precision: 1,
  citationAccuracy: 1,
  durationMs: 100,
  costUsd: 0.01,
  batchId: BATCH_ID,
};

/**
 * Generic chainable select() spy. `resolve` supplies the terminal row array;
 * `where`/`orderBy`/`limit`/`innerJoin` are recorded on `calls` so tests can
 * assert the WHERE clause included a workspace filter without needing a real
 * SQL parser (mirrors `blast-routes.test.ts` / `onboarding-repository.test.ts`
 * conventions — a plain object literal with recording spies).
 */
function selectChain(rows: unknown[], calls: { where: unknown[]; innerJoin: unknown[] }) {
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
    orderBy: () => chain,
    limit: (_n: number) => Promise.resolve(rows),
    then: (onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(onF, onR),
  };
  return chain;
}

function makeSelectOnlyDb(rows: unknown[]): { db: Db; calls: { where: unknown[]; innerJoin: unknown[] } } {
  const calls = { where: [] as unknown[], innerJoin: [] as unknown[] };
  const db = {
    select: (_cols?: Record<string, unknown>) => selectChain(rows, calls),
  } as unknown as Db;
  return { db, calls };
}

describe('EvalRepository.listCases', () => {
  it('scopes by workspace_id + owner_kind=agent + owner_id', async () => {
    const { db, calls } = makeSelectOnlyDb([CASE_ROW]);
    const repo = new EvalRepository(db);
    const rows = await repo.listCases(WS_ID, AGENT_ID);
    expect(rows).toEqual([CASE_ROW]);
    expect(calls.where.length).toBe(1);
  });

  it('returns empty array when no cases match', async () => {
    const { db } = makeSelectOnlyDb([]);
    const repo = new EvalRepository(db);
    const rows = await repo.listCases(OTHER_WS_ID, AGENT_ID);
    expect(rows).toEqual([]);
  });
});

describe('EvalRepository.countSkillOwnedCases', () => {
  it('counts skill-owned rows in the workspace', async () => {
    // count() aggregation (N+1 cleanup) — the fake db returns the aggregate
    // row shape { cnt } directly, not one row per matched case.
    const { db } = makeSelectOnlyDb([{ cnt: 2 }]);
    const repo = new EvalRepository(db);
    const count = await repo.countSkillOwnedCases(WS_ID);
    expect(count).toBe(2);
  });

  it('returns 0 when there are none', async () => {
    const { db } = makeSelectOnlyDb([{ cnt: 0 }]);
    const repo = new EvalRepository(db);
    expect(await repo.countSkillOwnedCases(WS_ID)).toBe(0);
  });
});

describe('EvalRepository.getCase', () => {
  it('returns the row when it exists in the workspace', async () => {
    const { db, calls } = makeSelectOnlyDb([CASE_ROW]);
    const repo = new EvalRepository(db);
    const row = await repo.getCase(WS_ID, CASE_ID);
    expect(row).toEqual(CASE_ROW);
    expect(calls.where.length).toBe(1);
  });

  it('returns null for a cross-workspace / nonexistent case', async () => {
    const { db } = makeSelectOnlyDb([]);
    const repo = new EvalRepository(db);
    const row = await repo.getCase(OTHER_WS_ID, CASE_ID);
    expect(row).toBeNull();
  });
});

describe('EvalRepository.insertCase', () => {
  it('returns the inserted row', async () => {
    const values = vi.fn();
    const db = {
      insert: (_table: unknown) => ({
        values: (v: unknown) => {
          values(v);
          return { returning: () => Promise.resolve([CASE_ROW]) };
        },
      }),
    } as unknown as Db;
    const repo = new EvalRepository(db);
    const row = await repo.insertCase({
      workspaceId: WS_ID,
      ownerKind: 'agent',
      ownerId: AGENT_ID,
      name: 'case one',
    });
    expect(row).toEqual(CASE_ROW);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS_ID, ownerId: AGENT_ID }),
    );
  });

  it('throws when the insert returns no row', async () => {
    const db = {
      insert: () => ({ values: () => ({ returning: () => Promise.resolve([]) }) }),
    } as unknown as Db;
    const repo = new EvalRepository(db);
    await expect(
      repo.insertCase({ workspaceId: WS_ID, ownerKind: 'agent', ownerId: AGENT_ID, name: 'x' }),
    ).rejects.toThrow();
  });
});

describe('EvalRepository.updateCase', () => {
  it('returns the updated row, scoped by workspace', async () => {
    const setSpy = vi.fn();
    const whereSpy = vi.fn();
    const updatedRow = { ...CASE_ROW, name: 'renamed', inputDiff: 'diff --git a/y b/y' };
    const db = {
      update: () => ({
        set: (vals: unknown) => {
          setSpy(vals);
          return {
            where: (...args: unknown[]) => {
              whereSpy(...args);
              return { returning: () => Promise.resolve([updatedRow]) };
            },
          };
        },
      }),
    } as unknown as Db;
    const repo = new EvalRepository(db);
    const row = await repo.updateCase(WS_ID, CASE_ID, {
      name: 'renamed',
      inputDiff: 'diff --git a/y b/y',
      expectedOutput: [],
      notes: null,
    });
    expect(row).toEqual(updatedRow);
    expect(setSpy).toHaveBeenCalledWith({
      name: 'renamed',
      inputDiff: 'diff --git a/y b/y',
      expectedOutput: [],
      notes: null,
    });
    expect(whereSpy).toHaveBeenCalledTimes(1);
  });

  it('returns null for a cross-workspace / nonexistent case', async () => {
    const db = {
      update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) }),
    } as unknown as Db;
    const repo = new EvalRepository(db);
    const row = await repo.updateCase(OTHER_WS_ID, CASE_ID, {
      name: 'x',
      inputDiff: 'diff',
      expectedOutput: [],
      notes: null,
    });
    expect(row).toBeNull();
  });
});

describe('EvalRepository.deleteCase', () => {
  it('returns true when a row was deleted, scoped by workspace', async () => {
    const calls: unknown[] = [];
    const db = {
      delete: () => ({
        where: (...args: unknown[]) => {
          calls.push(args);
          return { returning: () => Promise.resolve([{ id: CASE_ID }]) };
        },
      }),
    } as unknown as Db;
    const repo = new EvalRepository(db);
    const deleted = await repo.deleteCase(WS_ID, CASE_ID);
    expect(deleted).toBe(true);
    expect(calls.length).toBe(1);
  });

  it('returns false when nothing matched (wrong workspace)', async () => {
    const db = {
      delete: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }),
    } as unknown as Db;
    const repo = new EvalRepository(db);
    expect(await repo.deleteCase(OTHER_WS_ID, CASE_ID)).toBe(false);
  });
});

describe('EvalRepository.latestRunForCase', () => {
  it('returns the most recent run row', async () => {
    const { db } = makeSelectOnlyDb([RUN_ROW]);
    const repo = new EvalRepository(db);
    const row = await repo.latestRunForCase(CASE_ID);
    expect(row).toEqual(RUN_ROW);
  });

  it('returns null when the case has never run', async () => {
    const { db } = makeSelectOnlyDb([]);
    const repo = new EvalRepository(db);
    expect(await repo.latestRunForCase(CASE_ID)).toBeNull();
  });
});

describe('EvalRepository.lastThreeFullBatchOutcomesForCase', () => {
  it('maps pass=true/false/null to passed/failed/error, joined to full-kind batches only', async () => {
    const calls = { where: [] as unknown[], innerJoin: [] as unknown[] };
    const db = {
      select: () => selectChain([{ pass: true }, { pass: false }, { pass: null }], calls),
    } as unknown as Db;
    const repo = new EvalRepository(db);
    const outcomes = await repo.lastThreeFullBatchOutcomesForCase(CASE_ID, AGENT_ID);
    expect(outcomes).toEqual(['passed', 'failed', 'error']);
    expect(calls.innerJoin.length).toBe(1); // joined to eval_batches
    expect(calls.where.length).toBe(1);
  });

  it('returns an empty array when there is no full-batch history', async () => {
    const { db } = makeSelectOnlyDb([]);
    const repo = new EvalRepository(db);
    expect(await repo.lastThreeFullBatchOutcomesForCase(CASE_ID, AGENT_ID)).toEqual([]);
  });
});

describe('EvalRepository.insertRun', () => {
  it('returns the inserted row including batch_id', async () => {
    const values = vi.fn();
    const db = {
      insert: () => ({
        values: (v: unknown) => {
          values(v);
          return { returning: () => Promise.resolve([RUN_ROW]) };
        },
      }),
    } as unknown as Db;
    const repo = new EvalRepository(db);
    const row = await repo.insertRun({ caseId: CASE_ID, batchId: BATCH_ID, pass: true });
    expect(row).toEqual(RUN_ROW);
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ batchId: BATCH_ID }));
  });

  it('throws when the insert returns no row', async () => {
    const db = {
      insert: () => ({ values: () => ({ returning: () => Promise.resolve([]) }) }),
    } as unknown as Db;
    const repo = new EvalRepository(db);
    await expect(repo.insertRun({ caseId: CASE_ID, batchId: null })).rejects.toThrow();
  });

  it('passes an errored run\'s error_message through untouched', async () => {
    const values = vi.fn();
    const erroredRow = { ...RUN_ROW, pass: null, errorMessage: 'provider timeout (status 504)' };
    const db = {
      insert: () => ({
        values: (v: unknown) => {
          values(v);
          return { returning: () => Promise.resolve([erroredRow]) };
        },
      }),
    } as unknown as Db;
    const repo = new EvalRepository(db);
    const row = await repo.insertRun({
      caseId: CASE_ID,
      batchId: BATCH_ID,
      pass: null,
      errorMessage: 'provider timeout (status 504)',
    });
    expect(row.errorMessage).toBe('provider timeout (status 504)');
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ errorMessage: 'provider timeout (status 504)' }));
  });

  it('omits error_message (defaults to null) for a deterministic passed/failed run', async () => {
    const values = vi.fn();
    const db = {
      insert: () => ({
        values: (v: unknown) => {
          values(v);
          return { returning: () => Promise.resolve([RUN_ROW]) };
        },
      }),
    } as unknown as Db;
    const repo = new EvalRepository(db);
    await repo.insertRun({ caseId: CASE_ID, batchId: BATCH_ID, pass: true });
    expect(values).toHaveBeenCalledWith(expect.not.objectContaining({ errorMessage: expect.anything() }));
  });
});

describe('EvalRepository.runsForBatch', () => {
  it('returns all runs for the batch', async () => {
    const { db } = makeSelectOnlyDb([RUN_ROW]);
    const repo = new EvalRepository(db);
    expect(await repo.runsForBatch(BATCH_ID)).toEqual([RUN_ROW]);
  });
});

describe('EvalRepository.insertBatch', () => {
  it('returns the inserted batch row', async () => {
    const db = {
      insert: () => ({ values: () => ({ returning: () => Promise.resolve([BATCH_ROW]) }) }),
    } as unknown as Db;
    const repo = new EvalRepository(db);
    const row = await repo.insertBatch({
      workspaceId: WS_ID,
      agentId: AGENT_ID,
      kind: 'full',
      agentSnapshot: {},
    });
    expect(row).toEqual(BATCH_ROW);
  });

  it('throws when the insert returns no row', async () => {
    const db = {
      insert: () => ({ values: () => ({ returning: () => Promise.resolve([]) }) }),
    } as unknown as Db;
    const repo = new EvalRepository(db);
    await expect(
      repo.insertBatch({ workspaceId: WS_ID, agentId: AGENT_ID, kind: 'full', agentSnapshot: {} }),
    ).rejects.toThrow();
  });
});

describe('EvalRepository.updateBatchAggregate', () => {
  it('writes recall/precision/citationAccuracy/costUsd/status by batch id', async () => {
    const setSpy = vi.fn();
    const whereSpy = vi.fn();
    const db = {
      update: () => ({
        set: (vals: unknown) => {
          setSpy(vals);
          return {
            where: (...args: unknown[]) => {
              whereSpy(...args);
              return Promise.resolve();
            },
          };
        },
      }),
    } as unknown as Db;
    const repo = new EvalRepository(db);
    await repo.updateBatchAggregate(BATCH_ID, {
      recall: 0.9,
      precision: 0.8,
      citationAccuracy: 1,
      costUsd: 0.02,
      status: 'clean',
    });
    expect(setSpy).toHaveBeenCalledWith({
      recall: 0.9,
      precision: 0.8,
      citationAccuracy: 1,
      costUsd: 0.02,
      status: 'clean',
    });
    expect(whereSpy).toHaveBeenCalledTimes(1);
  });
});

describe('EvalRepository.listBatchHistory', () => {
  it('scopes by workspace_id + agent_id', async () => {
    const { db, calls } = makeSelectOnlyDb([BATCH_ROW]);
    const repo = new EvalRepository(db);
    const rows = await repo.listBatchHistory(WS_ID, AGENT_ID);
    expect(rows).toEqual([BATCH_ROW]);
    expect(calls.where.length).toBe(1);
  });
});

describe('EvalRepository.listTrendBatches', () => {
  it('scopes by workspace_id + agent_id + kind=full', async () => {
    const { db, calls } = makeSelectOnlyDb([BATCH_ROW]);
    const repo = new EvalRepository(db);
    const rows = await repo.listTrendBatches(WS_ID, AGENT_ID);
    expect(rows).toEqual([BATCH_ROW]);
    expect(calls.where.length).toBe(1);
  });

  it('returns empty when there are no full batches yet', async () => {
    const { db } = makeSelectOnlyDb([]);
    const repo = new EvalRepository(db);
    expect(await repo.listTrendBatches(WS_ID, AGENT_ID)).toEqual([]);
  });
});

describe('EvalRepository.getBatch', () => {
  it('returns the row when it belongs to the workspace', async () => {
    const { db } = makeSelectOnlyDb([BATCH_ROW]);
    const repo = new EvalRepository(db);
    expect(await repo.getBatch(WS_ID, BATCH_ID)).toEqual(BATCH_ROW);
  });

  it('returns null for a cross-workspace batch id', async () => {
    const { db } = makeSelectOnlyDb([]);
    const repo = new EvalRepository(db);
    expect(await repo.getBatch(OTHER_WS_ID, BATCH_ID)).toBeNull();
  });
});

describe('EvalRepository.previousFullBatch', () => {
  it('returns the most recent full batch strictly before the given ran_at', async () => {
    const { db, calls } = makeSelectOnlyDb([BATCH_ROW]);
    const repo = new EvalRepository(db);
    const row = await repo.previousFullBatch(WS_ID, AGENT_ID, new Date('2026-07-05T00:00:00Z'));
    expect(row).toEqual(BATCH_ROW);
    expect(calls.where.length).toBe(1);
  });

  it('returns null when there is no earlier full batch', async () => {
    const { db } = makeSelectOnlyDb([]);
    const repo = new EvalRepository(db);
    expect(
      await repo.previousFullBatch(WS_ID, AGENT_ID, new Date('2026-07-01T00:00:00Z')),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// EvalRepository.clearHistory — genuinely stateful in-memory fake (not a
// call-recording spy chain): this method's correctness hinges on ACTUAL
// filtering (which rows survive vs. get deleted, and isolation from a
// different agent/workspace's rows), which a spy-only chain can't assert.
// `eq(...)`/`and(...)` produce real drizzle-orm `SQL` objects whose
// `queryChunks` embed the target `Column` + bound value pairs; `extractEqPairs`
// walks those chunks to recover `{columnName: value}` so the fake can filter
// an in-memory row set exactly like a real WHERE clause would.
// ---------------------------------------------------------------------------

/** Recursively collect `{columnName: value}` pairs out of a real drizzle `eq`/`and` SQL tree. */
function extractEqPairs(node: unknown): Record<string, unknown> {
  const pairs: Record<string, unknown> = {};

  function walk(chunks: SQLChunk[]): void {
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (chunk instanceof Column) {
        // eq() emits: sql`${column} = ${value}` → queryChunks are
        // [RawSql(''), column, RawSql(' = '), value-wrapper, RawSql('')].
        // The bound value is wrapped; drizzle exposes it as a Param-like
        // object with a `.value` field, OR (for simple JS primitives passed
        // through bindIfParam) as the SQL chunk immediately following.
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

interface FakeRow {
  [key: string]: unknown;
}

/**
 * A genuinely stateful fake `Db` for `clearHistory`: holds in-memory
 * `evalCases`/`evalRuns`/`evalBatches` arrays and implements just the
 * `transaction/select/delete/where/returning` surface the method calls,
 * filtering by the REAL eq-pairs extracted from the condition passed to
 * `where()` (not a hardcoded resolve — genuine predicate evaluation).
 */
function makeStatefulEvalDb(seed: { cases: FakeRow[]; runs: FakeRow[]; batches: FakeRow[] }) {
  const state = {
    cases: [...seed.cases],
    runs: [...seed.runs],
    batches: [...seed.batches],
  };

  /** `extractEqPairs` keys are the real DB column names (snake_case, e.g.
   *  `workspace_id`); the in-memory fixture rows use the Drizzle JS field
   *  names (camelCase, e.g. `workspaceId`) — convert before comparing. */
  function snakeToCamel(s: string): string {
    return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  }

  function matches(row: FakeRow, pairs: Record<string, unknown>): boolean {
    return Object.entries(pairs).every(([k, v]) => row[snakeToCamel(k)] === v);
  }

  function makeTx() {
    // `clearHistory` issues its two `delete()` calls in a FIXED order —
    // eval_runs first (via the eval_cases subquery), then eval_batches — so a
    // simple call-order counter distinguishes them without needing to compare
    // table object identity (this fake never imports the real schema module).
    let deleteCallCount = 0;

    return {
      select: (_cols: { id: unknown }) => ({
        from: (table: { [k: string]: unknown }) => {
          // Only ever called against evalCases in clearHistory.
          void table;
          return {
            where: (cond: unknown) => {
              const pairs = extractEqPairs(cond);
              const rows = state.cases.filter((r) => matches(r, pairs));
              // Returned value is used as an `inArray` subquery arg (awaited
              // indirectly by the fake `delete().where()` below) AND must
              // itself be thenable, mirroring a real Drizzle query builder.
              const result = rows.map((r) => ({ id: r.id }));
              return Object.assign(Promise.resolve(result), {
                then: (onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
                  Promise.resolve(result).then(onF, onR),
              });
            },
          };
        },
      }),
      delete: (_table: unknown) => {
        const isRuns = deleteCallCount === 0;
        deleteCallCount++;
        return {
          where: (cond: unknown) => ({
            returning: async (_sel: unknown) => {
              if (isRuns) {
                // The condition here is `inArray(evalRuns.caseId, <subquery promise>)`.
                // Resolve the embedded subquery promise to get the allowed case ids.
                const caseIds = await resolveInArraySubquery(cond);
                const toDelete = state.runs.filter((r) => caseIds.includes(r.caseId as string));
                state.runs = state.runs.filter((r) => !caseIds.includes(r.caseId as string));
                return toDelete.map((r) => ({ id: r.id }));
              }
              const pairs = extractEqPairs(cond);
              const toDelete = state.batches.filter((r) => matches(r, pairs));
              state.batches = state.batches.filter((r) => !matches(r, pairs));
              return toDelete.map((r) => ({ id: r.id }));
            },
          }),
        };
      },
    };
  }

  async function resolveInArraySubquery(cond: unknown): Promise<string[]> {
    // inArray(column, subqueryPromise) wraps the subquery in a `Param` chunk
    // (`{value: <the promise>}`), not a directly-thenable queryChunk — probed
    // via a real `inArray()` call against a fake thenable subquery.
    const sqlCond = cond as SQL;
    for (const chunk of sqlCond.queryChunks) {
      const candidate = chunk && typeof chunk === 'object' && 'value' in (chunk as Record<string, unknown>)
        ? (chunk as { value: unknown }).value
        : chunk;
      if (candidate && typeof (candidate as Promise<unknown>).then === 'function') {
        const rows = (await (candidate as Promise<{ id: string }[]>)) ?? [];
        return rows.map((r) => r.id);
      }
    }
    return [];
  }

  const db = {
    transaction: async (fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) => fn(makeTx()),
  } as unknown as Db;

  return { db, state };
}

describe('EvalRepository.clearHistory', () => {
  const CASE_A_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
  const CASE_B_ID = 'aaaaaaaa-0000-0000-0000-000000000002';
  const OTHER_AGENT_CASE_ID = 'bbbbbbbb-0000-0000-0000-000000000001';
  const OTHER_WS_CASE_ID = 'cccccccc-0000-0000-0000-000000000001';

  const OTHER_AGENT_ID = 'dddddddd-0000-0000-0000-000000000001';

  function seedData() {
    return {
      cases: [
        { id: CASE_A_ID, workspaceId: WS_ID, ownerKind: 'agent', ownerId: AGENT_ID, name: 'a' },
        { id: CASE_B_ID, workspaceId: WS_ID, ownerKind: 'agent', ownerId: AGENT_ID, name: 'b' },
        // Different agent, SAME workspace — must survive + its runs/batches untouched.
        { id: OTHER_AGENT_CASE_ID, workspaceId: WS_ID, ownerKind: 'agent', ownerId: OTHER_AGENT_ID, name: 'c' },
        // Different workspace entirely.
        { id: OTHER_WS_CASE_ID, workspaceId: OTHER_WS_ID, ownerKind: 'agent', ownerId: AGENT_ID, name: 'd' },
      ],
      runs: [
        { id: 'run-1', caseId: CASE_A_ID, batchId: BATCH_ID, pass: true },
        { id: 'run-2', caseId: CASE_B_ID, batchId: BATCH_ID, pass: false },
        { id: 'run-3', caseId: OTHER_AGENT_CASE_ID, batchId: 'batch-other-agent', pass: true },
        { id: 'run-4', caseId: OTHER_WS_CASE_ID, batchId: 'batch-other-ws', pass: true },
      ],
      batches: [
        { id: BATCH_ID, workspaceId: WS_ID, agentId: AGENT_ID, kind: 'full' },
        { id: 'batch-other-agent', workspaceId: WS_ID, agentId: OTHER_AGENT_ID, kind: 'full' },
        { id: 'batch-other-ws', workspaceId: OTHER_WS_ID, agentId: AGENT_ID, kind: 'full' },
      ],
    };
  }

  it('deletes all batches + runs for the agent, returning accurate counts', async () => {
    const { db, state } = makeStatefulEvalDb(seedData());
    const repo = new EvalRepository(db);

    const result = await repo.clearHistory(WS_ID, AGENT_ID);

    expect(result).toEqual({ deletedBatches: 1, deletedRuns: 2 });
    expect(state.batches.some((b) => b.agentId === AGENT_ID && b.workspaceId === WS_ID)).toBe(false);
    expect(state.runs.some((r) => r.caseId === CASE_A_ID || r.caseId === CASE_B_ID)).toBe(false);
  });

  it('preserves the eval_cases rows themselves — case definitions survive', async () => {
    const { db, state } = makeStatefulEvalDb(seedData());
    const repo = new EvalRepository(db);

    await repo.clearHistory(WS_ID, AGENT_ID);

    // clearHistory never deletes from `cases` — all 4 seeded cases remain,
    // including the target agent's own two.
    expect(state.cases).toHaveLength(4);
    expect(state.cases.some((c) => c.id === CASE_A_ID)).toBe(true);
    expect(state.cases.some((c) => c.id === CASE_B_ID)).toBe(true);
  });

  it('does not touch a different agent\'s batches/runs in the SAME workspace (isolation)', async () => {
    const { db, state } = makeStatefulEvalDb(seedData());
    const repo = new EvalRepository(db);

    await repo.clearHistory(WS_ID, AGENT_ID);

    expect(state.batches.some((b) => b.id === 'batch-other-agent')).toBe(true);
    expect(state.runs.some((r) => r.id === 'run-3')).toBe(true);
  });

  it('does not touch a different workspace\'s batches/runs for the SAME agent id (isolation)', async () => {
    const { db, state } = makeStatefulEvalDb(seedData());
    const repo = new EvalRepository(db);

    await repo.clearHistory(WS_ID, AGENT_ID);

    expect(state.batches.some((b) => b.id === 'batch-other-ws')).toBe(true);
    expect(state.runs.some((r) => r.id === 'run-4')).toBe(true);
  });

  it('returns zero counts when the agent has no history yet', async () => {
    const { db } = makeStatefulEvalDb({ cases: [], runs: [], batches: [] });
    const repo = new EvalRepository(db);

    const result = await repo.clearHistory(WS_ID, AGENT_ID);
    expect(result).toEqual({ deletedBatches: 0, deletedRuns: 0 });
  });
});
