/**
 * Hermetic tests for `SkillEvalRepository` — the skill-eval pipeline's
 * run/batch/history queries (sibling to L06's `EvalRepository`, see
 * docs/plans/2026-07-06-skill-eval-pipeline.md Step 4). Every method must be
 * workspace-scoped, either directly (`skill_eval_batches` has its own
 * `workspace_id` column) or transitively (`eval_runs`/case reads have no
 * `workspace_id` of their own — scope flows via a `skillId`/`batchId` the
 * caller already resolved).
 *
 * A hand-rolled fake `Db` satisfies the exact Drizzle chain shapes
 * `SkillEvalRepository` calls, following the "sniff by requested column
 * keys" / call-recording chain-shape convention documented in
 * `server/insights.md` and used by `test/eval-repository.test.ts`. No
 * Postgres, no Docker.
 */
import { describe, it, expect, vi } from 'vitest';
import { SkillEvalRepository } from '../src/modules/skills/eval-repository.js';
import type { Db } from '../src/db/client.js';

const WS_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_WS_ID = '99999999-9999-9999-9999-999999999999';
const SKILL_ID = '22222222-2222-2222-2222-222222222222';
const HOST_AGENT_ID = '66666666-6666-6666-6666-666666666666';
const CASE_ID = '33333333-3333-3333-3333-333333333333';
const BATCH_ID = '44444444-4444-4444-4444-444444444444';

const CASE_ROW = {
  id: CASE_ID,
  workspaceId: WS_ID,
  ownerKind: 'skill' as const,
  ownerId: SKILL_ID,
  name: 'case one',
  inputDiff: 'diff --git a/x b/x',
  inputFiles: null,
  inputMeta: null,
  expectedOutput: { practices: ['does X'], grounding: ['term'], threshold: 0.6 },
  notes: null,
};

const BATCH_ROW = {
  id: BATCH_ID,
  workspaceId: WS_ID,
  skillId: SKILL_ID,
  hostAgentId: HOST_AGENT_ID,
  kind: 'full' as const,
  status: 'clean' as const,
  snapshotIdentity: {},
  model: 'claude-haiku-4-5',
  judgeScore: 0.9,
  groundingPassRate: 1,
  casesPassing: 1,
  casesTotal: 1,
  costUsd: 0.01,
  ranAt: new Date('2026-07-06T00:00:00Z'),
};

const RUN_ROW = {
  id: '55555555-5555-5555-5555-555555555555',
  caseId: CASE_ID,
  ranAt: new Date('2026-07-06T00:00:00Z'),
  actualOutput: {},
  pass: true,
  recall: null,
  precision: null,
  citationAccuracy: null,
  durationMs: 100,
  costUsd: 0.01,
  batchId: null,
  skillBatchId: BATCH_ID,
  matchedCount: null,
  expectedCount: null,
  errorMessage: null,
};

/**
 * Generic chainable select() spy. `resolve` supplies the terminal row array;
 * `where`/`orderBy`/`limit` are recorded on `calls` so tests can assert the
 * WHERE clause was invoked without needing a real SQL parser (mirrors
 * `eval-repository.test.ts`'s `selectChain`/`makeSelectOnlyDb` convention).
 */
function selectChain(rows: unknown[], calls: { where: unknown[] }) {
  const chain: Record<string, unknown> = {
    from: () => chain,
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

function makeSelectOnlyDb(rows: unknown[]): { db: Db; calls: { where: unknown[] } } {
  const calls = { where: [] as unknown[] };
  const db = {
    select: (_cols?: Record<string, unknown>) => selectChain(rows, calls),
  } as unknown as Db;
  return { db, calls };
}

describe('SkillEvalRepository.listCases', () => {
  it('scopes by workspace_id + owner_kind=skill + owner_id', async () => {
    const { db, calls } = makeSelectOnlyDb([CASE_ROW]);
    const repo = new SkillEvalRepository(db);
    const rows = await repo.listCases(WS_ID, SKILL_ID);
    expect(rows).toEqual([CASE_ROW]);
    expect(calls.where.length).toBe(1);
  });

  it('returns empty array when no cases match', async () => {
    const { db } = makeSelectOnlyDb([]);
    const repo = new SkillEvalRepository(db);
    const rows = await repo.listCases(OTHER_WS_ID, SKILL_ID);
    expect(rows).toEqual([]);
  });
});

describe('SkillEvalRepository.getCase', () => {
  it('returns the row when it exists in the workspace with owner_kind=skill', async () => {
    const { db, calls } = makeSelectOnlyDb([CASE_ROW]);
    const repo = new SkillEvalRepository(db);
    const row = await repo.getCase(WS_ID, CASE_ID);
    expect(row).toEqual(CASE_ROW);
    expect(calls.where.length).toBe(1);
  });

  it('returns null for a cross-workspace / nonexistent case', async () => {
    const { db } = makeSelectOnlyDb([]);
    const repo = new SkillEvalRepository(db);
    const row = await repo.getCase(OTHER_WS_ID, CASE_ID);
    expect(row).toBeNull();
  });
});

describe('SkillEvalRepository.latestRunForCase', () => {
  it('returns the most recent skill-eval run row for the case', async () => {
    const { db } = makeSelectOnlyDb([RUN_ROW]);
    const repo = new SkillEvalRepository(db);
    const row = await repo.latestRunForCase(CASE_ID);
    expect(row).toEqual(RUN_ROW);
  });

  it('returns null when the case has never run under a skill-eval batch', async () => {
    const { db } = makeSelectOnlyDb([]);
    const repo = new SkillEvalRepository(db);
    expect(await repo.latestRunForCase(CASE_ID)).toBeNull();
  });
});

describe('SkillEvalRepository.insertRun', () => {
  it('returns the inserted row including skill_batch_id, with batch_id left null', async () => {
    const values = vi.fn();
    const db = {
      insert: () => ({
        values: (v: unknown) => {
          values(v);
          return { returning: () => Promise.resolve([RUN_ROW]) };
        },
      }),
    } as unknown as Db;
    const repo = new SkillEvalRepository(db);
    const row = await repo.insertRun({ caseId: CASE_ID, skillBatchId: BATCH_ID, batchId: null, pass: true });
    expect(row).toEqual(RUN_ROW);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ skillBatchId: BATCH_ID, batchId: null }),
    );
  });

  it('throws when the insert returns no row', async () => {
    const db = {
      insert: () => ({ values: () => ({ returning: () => Promise.resolve([]) }) }),
    } as unknown as Db;
    const repo = new SkillEvalRepository(db);
    await expect(repo.insertRun({ caseId: CASE_ID, skillBatchId: BATCH_ID })).rejects.toThrow();
  });
});

describe('SkillEvalRepository.runsForBatch', () => {
  it('returns all runs scoped by skill_batch_id', async () => {
    const { db, calls } = makeSelectOnlyDb([RUN_ROW]);
    const repo = new SkillEvalRepository(db);
    expect(await repo.runsForBatch(BATCH_ID)).toEqual([RUN_ROW]);
    expect(calls.where.length).toBe(1);
  });
});

describe('SkillEvalRepository.insertBatch', () => {
  it('returns the inserted batch row', async () => {
    const db = {
      insert: () => ({ values: () => ({ returning: () => Promise.resolve([BATCH_ROW]) }) }),
    } as unknown as Db;
    const repo = new SkillEvalRepository(db);
    const row = await repo.insertBatch({
      workspaceId: WS_ID,
      skillId: SKILL_ID,
      hostAgentId: HOST_AGENT_ID,
      kind: 'full',
      snapshotIdentity: {},
      model: 'claude-haiku-4-5',
    });
    expect(row).toEqual(BATCH_ROW);
  });

  it('throws when the insert returns no row', async () => {
    const db = {
      insert: () => ({ values: () => ({ returning: () => Promise.resolve([]) }) }),
    } as unknown as Db;
    const repo = new SkillEvalRepository(db);
    await expect(
      repo.insertBatch({
        workspaceId: WS_ID,
        skillId: SKILL_ID,
        hostAgentId: HOST_AGENT_ID,
        kind: 'full',
        snapshotIdentity: {},
        model: 'claude-haiku-4-5',
      }),
    ).rejects.toThrow();
  });
});

describe('SkillEvalRepository.updateBatchAggregate', () => {
  it('writes judgeScore/groundingPassRate/casesPassing/casesTotal/costUsd/status by batch id', async () => {
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
    const repo = new SkillEvalRepository(db);
    await repo.updateBatchAggregate(BATCH_ID, {
      judgeScore: 0.9,
      groundingPassRate: 1,
      casesPassing: 1,
      casesTotal: 1,
      costUsd: 0.02,
      status: 'clean',
    });
    expect(setSpy).toHaveBeenCalledWith({
      judgeScore: 0.9,
      groundingPassRate: 1,
      casesPassing: 1,
      casesTotal: 1,
      costUsd: 0.02,
      status: 'clean',
    });
    expect(whereSpy).toHaveBeenCalledTimes(1);
  });
});

describe('SkillEvalRepository.listBatchHistory', () => {
  it('scopes by workspace_id + skill_id', async () => {
    const { db, calls } = makeSelectOnlyDb([BATCH_ROW]);
    const repo = new SkillEvalRepository(db);
    const rows = await repo.listBatchHistory(WS_ID, SKILL_ID);
    expect(rows).toEqual([BATCH_ROW]);
    expect(calls.where.length).toBe(1);
  });

  it('returns empty array when the skill has no batch history yet', async () => {
    const { db } = makeSelectOnlyDb([]);
    const repo = new SkillEvalRepository(db);
    expect(await repo.listBatchHistory(OTHER_WS_ID, SKILL_ID)).toEqual([]);
  });
});

describe('SkillEvalRepository.getBatch', () => {
  it('returns the row when it belongs to the workspace', async () => {
    const { db } = makeSelectOnlyDb([BATCH_ROW]);
    const repo = new SkillEvalRepository(db);
    expect(await repo.getBatch(WS_ID, BATCH_ID)).toEqual(BATCH_ROW);
  });

  it('returns null for a cross-workspace batch id', async () => {
    const { db } = makeSelectOnlyDb([]);
    const repo = new SkillEvalRepository(db);
    expect(await repo.getBatch(OTHER_WS_ID, BATCH_ID)).toBeNull();
  });
});
