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
