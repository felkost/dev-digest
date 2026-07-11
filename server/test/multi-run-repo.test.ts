/**
 * Hermetic tests for `multi-run.repo.ts` (Multi-Agent Review, plan Step 2).
 *
 * A hand-rolled fake `Db` mirrors the codebase's established "sniff by
 * requested column keys" / call-recording convention (see
 * `test/pull.repo.test.ts`, `test/eval-repository.test.ts`). No Postgres,
 * no Docker.
 */
import { describe, it, expect } from 'vitest';
import { Column } from 'drizzle-orm';
import type { SQL, SQLChunk } from 'drizzle-orm';
import {
  createGroup,
  getGroupScoped,
  listAgentRunsForGroup,
  findingsAndReviewsForRuns,
} from '../src/modules/reviews/repository/multi-run.repo.js';
import type { Db } from '../src/db/client.js';

const WS_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_WS_ID = '22222222-2222-2222-2222-222222222222';
const PR_ID = '33333333-3333-3333-3333-333333333333';
const GROUP_ID = '44444444-4444-4444-4444-444444444444';
const RUN_ID_1 = '55555555-5555-5555-5555-555555555555';
const RUN_ID_2 = '66666666-6666-6666-6666-666666666666';

// ---- shared fake-db chain helpers (mirrors test/eval-repository.test.ts) --

interface ChainCalls {
  where: unknown[];
  leftJoin: unknown[];
  orderBy: unknown[];
}

function selectChain(rows: unknown[], calls: ChainCalls) {
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

function makeSelectOnlyDb(rows: unknown[]): { db: Db; calls: ChainCalls } {
  const calls: ChainCalls = { where: [], leftJoin: [], orderBy: [] };
  const db = {
    select: (_cols?: Record<string, unknown>) => selectChain(rows, calls),
  } as unknown as Db;
  return { db, calls };
}

/** Sequenced select fake: each successive `db.select()` call resolves to the
 *  NEXT row set in `rowSets`, in call order — needed for
 *  `findingsAndReviewsForRuns`'s two chained `select()` calls (reviews, then
 *  findings), which the single-response `makeSelectOnlyDb` cannot express. */
function makeSequencedSelectDb(rowSets: unknown[][]): { db: Db } {
  let callIndex = 0;
  const db = {
    select: (_cols?: Record<string, unknown>) => {
      const rows = rowSets[callIndex] ?? [];
      callIndex++;
      return selectChain(rows, { where: [], leftJoin: [], orderBy: [] });
    },
  } as unknown as Db;
  return { db };
}

/** Walks a real drizzle-orm `eq()`/`and()` SQL condition tree and extracts
 *  {columnName: boundValue} pairs — proves the WHERE clause actually filters
 *  on the expected column/value, not just that `.where()` was called once.
 *  Mirrors `test/eval-repository.test.ts`'s `extractEqPairs` convention. */
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

// ---- createGroup ------------------------------------------------------

describe('createGroup', () => {
  it('inserts a multi_agent_runs row and returns its id', async () => {
    let insertedValues: unknown;
    const db = {
      insert: (_table: unknown) => ({
        values: (v: unknown) => {
          insertedValues = v;
          return { returning: (_cols: unknown) => Promise.resolve([{ id: GROUP_ID }]) };
        },
      }),
    } as unknown as Db;

    const id = await createGroup(db, { workspaceId: WS_ID, prId: PR_ID });

    expect(id).toBe(GROUP_ID);
    expect(insertedValues).toEqual({ workspaceId: WS_ID, prId: PR_ID });
  });

  // No "insert returns no row" guard test here (architecture review Low
  // finding): `createGroup` now matches its sibling `createAgentRun`
  // (`repository/run.repo.ts`) — a bare `row!.id` non-null assertion, with no
  // defensive test for this impossible-in-practice `INSERT ... RETURNING`
  // case, exactly like `createAgentRun` itself.
});

// ---- getGroupScoped -----------------------------------------------------

describe('getGroupScoped', () => {
  it('returns the group row (with pr_number from the left join) for a matching workspace', async () => {
    const { db } = makeSelectOnlyDb([
      { id: GROUP_ID, prId: PR_ID, ranAt: new Date('2026-07-10T00:00:00Z'), prNumber: 42 },
    ]);

    const group = await getGroupScoped(db, WS_ID, GROUP_ID);

    expect(group).toEqual({
      id: GROUP_ID,
      prId: PR_ID,
      prNumber: 42,
      ranAt: new Date('2026-07-10T00:00:00Z'),
    });
  });

  it('returns undefined for a foreign workspaceId', async () => {
    const { db } = makeSelectOnlyDb([]);

    const group = await getGroupScoped(db, OTHER_WS_ID, GROUP_ID);

    expect(group).toBeUndefined();
  });

  it('defaults pr_number to null when the PR row is missing (left join, no match)', async () => {
    const { db } = makeSelectOnlyDb([
      { id: GROUP_ID, prId: PR_ID, ranAt: new Date('2026-07-10T00:00:00Z'), prNumber: null },
    ]);

    const group = await getGroupScoped(db, WS_ID, GROUP_ID);

    expect(group?.prNumber).toBeNull();
  });
});

// ---- listAgentRunsForGroup ------------------------------------------------

describe('listAgentRunsForGroup', () => {
  it("returns the group's agent_runs rows", async () => {
    const rows = [
      { id: RUN_ID_1, multiAgentRunId: GROUP_ID },
      { id: RUN_ID_2, multiAgentRunId: GROUP_ID },
    ];
    const { db } = makeSelectOnlyDb(rows);

    const result = await listAgentRunsForGroup(db, GROUP_ID);

    expect(result).toEqual(rows);
  });

  it('filters on multi_agent_run_id = groupId (not just that .where() was called)', async () => {
    const { db, calls } = makeSelectOnlyDb([]);

    await listAgentRunsForGroup(db, GROUP_ID);

    expect(calls.where.length).toBe(1);
    const pairs = extractEqPairs(calls.where[0]![0]);
    expect(pairs.multi_agent_run_id).toBe(GROUP_ID);
  });
});

// ---- findingsAndReviewsForRuns --------------------------------------------

describe('findingsAndReviewsForRuns', () => {
  it('returns an empty map without querying the db when runIds is empty', async () => {
    const db = {
      select: () => {
        throw new Error('select should not be called for an empty runIds array');
      },
    } as unknown as Db;

    const result = await findingsAndReviewsForRuns(db, []);

    expect(result.size).toBe(0);
  });

  it('keys reviews+findings by run_id, grouping findings per review', async () => {
    const review1 = { id: 'review-1', runId: RUN_ID_1, prId: PR_ID };
    const review2 = { id: 'review-2', runId: RUN_ID_2, prId: PR_ID };
    const findingA = { id: 'f-a', reviewId: 'review-1', severity: 'CRITICAL' };
    const findingB = { id: 'f-b', reviewId: 'review-1', severity: 'WARNING' };
    const findingC = { id: 'f-c', reviewId: 'review-2', severity: 'SUGGESTION' };

    const { db } = makeSequencedSelectDb([[review1, review2], [findingA, findingB, findingC]]);

    const result = await findingsAndReviewsForRuns(db, [RUN_ID_1, RUN_ID_2]);

    expect(result.size).toBe(2);
    expect(result.get(RUN_ID_1)).toEqual({ review: review1, findings: [findingA, findingB] });
    expect(result.get(RUN_ID_2)).toEqual({ review: review2, findings: [findingC] });
  });

  it('skips a review row with a null run_id (orphaned row safety)', async () => {
    const reviewNoRun = { id: 'review-x', runId: null, prId: PR_ID };
    const { db } = makeSequencedSelectDb([[reviewNoRun], []]);

    const result = await findingsAndReviewsForRuns(db, [RUN_ID_1]);

    expect(result.size).toBe(0);
  });

  it('returns an empty map when no reviews match (and does not query findings)', async () => {
    let findingsQueried = false;
    let callIndex = 0;
    const db = {
      select: () => {
        if (callIndex === 0) {
          callIndex++;
          return selectChain([], { where: [], leftJoin: [], orderBy: [] });
        }
        findingsQueried = true;
        return selectChain([], { where: [], leftJoin: [], orderBy: [] });
      },
    } as unknown as Db;

    const result = await findingsAndReviewsForRuns(db, [RUN_ID_1]);

    expect(result.size).toBe(0);
    expect(findingsQueried).toBe(false);
  });
});
