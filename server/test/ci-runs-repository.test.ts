/**
 * Hermetic tests for `ci/repository/runs.repo.ts`'s `RunsRepository`.
 *
 * A hand-rolled stateful fake `Db` models just enough of the Drizzle chain
 * shapes the repository calls (`insert().values().onConflictDoUpdate().returning()`,
 * `select().from().leftJoin().where().orderBy()`, `select().from().where().limit()`,
 * `update().set().where()`) — mirroring `test/pull.repo.test.ts`'s `makeFakeDb`
 * pattern. No Postgres, no Docker.
 *
 * Per `server-testing` skill guidance, Drizzle query-builder internals (exact
 * WHERE-clause SQL shape) are not introspected here — `list()`'s filter
 * *construction* is exercised at the happy-path level only.
 */
import { describe, it, expect } from 'vitest';
import { RunsRepository, type CiRunRow, type CiRunUpsertValues } from '../src/modules/ci/repository/runs.repo.js';
import { ConfigError } from '../src/platform/errors.js';
import type { Db } from '../src/db/client.js';
import * as t from '../src/db/schema.js';

const WS = '11111111-1111-1111-1111-111111111111';
const OTHER_WS = '33333333-3333-3333-3333-333333333333';
const INSTALLATION_ID = '22222222-2222-2222-2222-222222222222';

/**
 * Extracts the bound value of a single `eq(column, value)` condition out of a
 * real drizzle-orm SQL object's `queryChunks` (column chunk has `.name`; the
 * bound value sits two chunks later). Verified against the actual installed
 * drizzle-orm@0.38 runtime shape (not guessed) before writing this helper.
 */
function extractEqValue(cond: unknown, columnName: string): unknown {
  const chunks = (cond as { queryChunks?: unknown[] } | undefined)?.queryChunks;
  if (!Array.isArray(chunks)) return undefined;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i] as { name?: unknown } | undefined;
    if (c && typeof c === 'object' && c.name === columnName) {
      const valueChunk = chunks[i + 2] as { value?: unknown } | undefined;
      return valueChunk?.value;
    }
  }
  return undefined;
}

/**
 * Like `extractEqValue`, but RECURSES into nested `queryChunks`-bearing
 * conditions (needed for `statusesByGithubRunId`'s `and(eq(...), inArray(...))`
 * — `and()` wraps its operands in a nested `SQL` object, which a flat,
 * single-level scan like `extractEqValue` can't see into) and additionally
 * unwraps an `inArray()` match: its bound value sits at the same
 * chunks[i+2] position as `eq()`'s, but as an ARRAY of `Param`-like
 * `{value}` wrappers rather than a single one — verified against the
 * installed drizzle-orm@0.38 `inArray()`/`and()` source directly (not
 * guessed) before writing this helper.
 */
function findColumnValue(cond: unknown, columnName: string): unknown {
  const chunks = (cond as { queryChunks?: unknown[] } | undefined)?.queryChunks;
  if (!Array.isArray(chunks)) return undefined;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const named = chunk as { name?: unknown } | undefined;
    if (named && typeof named === 'object' && named.name === columnName) {
      const bound = chunks[i + 2];
      if (Array.isArray(bound)) {
        return bound.map((p) => (p as { value?: unknown } | undefined)?.value);
      }
      return (bound as { value?: unknown } | undefined)?.value;
    }
    const nested = findColumnValue(chunk, columnName);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function baseValues(overrides: Partial<CiRunUpsertValues> = {}): CiRunUpsertValues {
  return {
    prNumber: 42,
    ranAt: new Date('2026-07-09T00:00:00Z'),
    status: 'running',
    findingsCount: null,
    critical: null,
    warning: null,
    suggestion: null,
    costUsd: null,
    durationS: null,
    githubUrl: 'https://github.com/acme/api/actions/runs/123',
    repo: 'acme/api',
    agent: 'Security Reviewer',
    ...overrides,
  };
}

interface FakeCiRunInsertValues {
  workspaceId: string;
  ciInstallationId: string;
  githubRunId: string;
  [key: string]: unknown;
}

interface SettingsRow {
  id: string;
  workspaceId: string;
  userId: string | null;
  key: string;
  value: unknown;
}

/**
 * Builds a fake `Db` backed by real in-memory arrays for `ci_runs` and
 * `settings`. `insert(ciRuns).values(...).onConflictDoUpdate(...).returning()`
 * implements REAL upsert-by-`githubRunId` semantics (find-or-push, then apply
 * `set`) so the dedup assertion is genuine, not scripted.
 */
function makeFakeDb() {
  const ciRuns: CiRunRow[] = [];
  const settings: SettingsRow[] = [];
  let nextCiRunSeq = 1;
  let nextSettingsSeq = 1;

  const fakeDb = {
    insert: (table: unknown) => {
      if (table === t.ciRuns) {
        return {
          values: (values: FakeCiRunInsertValues) => ({
            onConflictDoUpdate: (conf: { set: Record<string, unknown>; setWhere?: unknown }) => ({
              returning: (): Promise<CiRunRow[]> => {
                const idx = ciRuns.findIndex((r) => r.githubRunId === values.githubRunId);
                if (idx >= 0) {
                  const existing = ciRuns[idx]!;
                  // Mirror real Postgres `ON CONFLICT ... DO UPDATE ... WHERE`
                  // semantics: when setWhere is present and evaluates false
                  // against the EXISTING row, no update happens and no row
                  // is returned (not an error at the DB level — the
                  // repository's own `if (!row) throw` turns that into one).
                  if (conf.setWhere) {
                    const requiredWorkspaceId = extractEqValue(conf.setWhere, 'workspace_id');
                    if (requiredWorkspaceId !== undefined && requiredWorkspaceId !== existing.workspaceId) {
                      return Promise.resolve([]);
                    }
                  }
                  const updated: CiRunRow = { ...existing, ...conf.set } as CiRunRow;
                  ciRuns[idx] = updated;
                  return Promise.resolve([updated]);
                }
                const row = {
                  id: `ci-run-${nextCiRunSeq++}`,
                  prNumber: null,
                  ranAt: null,
                  status: null,
                  findingsCount: null,
                  costUsd: null,
                  githubUrl: null,
                  source: null,
                  repo: null,
                  agent: null,
                  durationS: null,
                  critical: null,
                  warning: null,
                  suggestion: null,
                  ...values,
                } as CiRunRow;
                ciRuns.push(row);
                return Promise.resolve([row]);
              },
            }),
          }),
        };
      }
      if (table === t.settings) {
        return {
          values: (values: { workspaceId: string; userId: string | null; key: string; value: unknown }) => {
            settings.push({ id: `setting-${nextSettingsSeq++}`, ...values });
            return Promise.resolve(undefined);
          },
        };
      }
      throw new Error('unexpected insert table in fake db');
    },
    update: (table: unknown) => {
      if (table === t.settings) {
        return {
          set: (values: { value: unknown }) => ({
            where: () => {
              // Single-workspace/single-key scope in these tests — apply to
              // whichever settings row is present (mirrors pull.repo.test.ts's
              // level of fidelity: where() args are not re-evaluated).
              const row = settings[0];
              if (row) row.value = values.value;
              return Promise.resolve(undefined);
            },
          }),
        };
      }
      throw new Error('unexpected update table in fake db');
    },
    select: (_cols?: Record<string, unknown>) => ({
      from: (table: unknown) => {
        if (table === t.ciRuns) {
          return {
            leftJoin: () => ({
              where: () => ({
                orderBy: (): Promise<CiRunRow[]> => Promise.resolve(ciRuns),
              }),
            }),
            // statusesByGithubRunId: select({...}).from(ciRuns).where(cond) —
            // awaited directly, no leftJoin/orderBy (distinguishes this shape
            // from list()'s above). Genuinely filters by walking the real
            // drizzle-orm condition tree via findColumnValue, rather than
            // trusting the fixture to only contain relevant rows — this
            // method's whole job is workspace/id scoping, so the fake must
            // actually exercise that, not just record that `where` was called.
            where: (
              cond: unknown,
            ): Promise<{ githubRunId: string; status: string | null; findingsCount: number | null }[]> => {
              const wsId = findColumnValue(cond, 'workspace_id');
              const idsRaw = findColumnValue(cond, 'github_run_id');
              const ids = Array.isArray(idsRaw) ? new Set(idsRaw) : null;
              return Promise.resolve(
                ciRuns
                  .filter((r) => r.workspaceId === wsId && (!ids || ids.has(r.githubRunId)))
                  .map((r) => ({
                    githubRunId: r.githubRunId,
                    status: r.status,
                    findingsCount: r.findingsCount,
                  })),
              );
            },
          };
        }
        if (table === t.settings) {
          return {
            where: () => ({
              limit: (_n: number) => Promise.resolve(settings.map((r) => ({ id: r.id, value: r.value }))),
            }),
          };
        }
        throw new Error('unexpected select-from table in fake db');
      },
    }),
  };

  return { db: fakeDb as unknown as Db, ciRuns, settings };
}

describe('RunsRepository.upsertByGithubRunId', () => {
  it('inserts a new row on first observation of a github_run_id', async () => {
    const { db, ciRuns } = makeFakeDb();
    const repo = new RunsRepository(db);

    const row = await repo.upsertByGithubRunId(WS, INSTALLATION_ID, 'gh-run-1', baseValues());

    expect(ciRuns).toHaveLength(1);
    expect(row.githubRunId).toBe('gh-run-1');
    expect(row.workspaceId).toBe(WS);
    expect(row.ciInstallationId).toBe(INSTALLATION_ID);
    expect(row.status).toBe('running');
  });

  it('a second upsert with the same github_run_id updates the same row — no new row', async () => {
    const { db, ciRuns } = makeFakeDb();
    const repo = new RunsRepository(db);

    const first = await repo.upsertByGithubRunId(WS, INSTALLATION_ID, 'gh-run-1', baseValues({ status: 'running' }));
    const second = await repo.upsertByGithubRunId(
      WS,
      INSTALLATION_ID,
      'gh-run-1',
      baseValues({ status: 'succeeded', findingsCount: 3, critical: 1, warning: 2, suggestion: 0, costUsd: 0.02, durationS: 12 }),
    );

    expect(ciRuns).toHaveLength(1); // still exactly one row for this github_run_id
    expect(second.id).toBe(first.id); // same row, not a new one
    expect(second.status).toBe('succeeded');
    expect(second.findingsCount).toBe(3);
    expect(second.critical).toBe(1);
    expect(second.durationS).toBe(12);
  });

  it('agent and duration_s round-trip through both the initial insert and a later conflicting update', async () => {
    const { db, ciRuns } = makeFakeDb();
    const repo = new RunsRepository(db);

    const first = await repo.upsertByGithubRunId(
      WS,
      INSTALLATION_ID,
      'gh-run-1',
      baseValues({ agent: 'Security Reviewer', durationS: 30 }),
    );
    expect(first.agent).toBe('Security Reviewer');
    expect(first.durationS).toBe(30);

    // Re-observe the same GitHub run with different agent/duration_s values
    // (e.g. the agent was renamed between two ingest checks, and the run's
    // final duration is now known) — both fields must flow through the
    // ON CONFLICT DO UPDATE SET clause onto the SAME row, not merely be
    // retained from the original insert.
    const second = await repo.upsertByGithubRunId(
      WS,
      INSTALLATION_ID,
      'gh-run-1',
      baseValues({ agent: 'Renamed Security Reviewer', durationS: 47 }),
    );

    expect(ciRuns).toHaveLength(1);
    expect(second.id).toBe(first.id);
    expect(second.agent).toBe('Renamed Security Reviewer');
    expect(second.durationS).toBe(47);
  });

  it('different github_run_ids create distinct rows', async () => {
    const { db, ciRuns } = makeFakeDb();
    const repo = new RunsRepository(db);

    await repo.upsertByGithubRunId(WS, INSTALLATION_ID, 'gh-run-1', baseValues());
    await repo.upsertByGithubRunId(WS, INSTALLATION_ID, 'gh-run-2', baseValues());

    expect(ciRuns).toHaveLength(2);
  });

  it('a github_run_id collision across workspaces throws instead of overwriting the other workspace\'s row', async () => {
    // ci_runs.github_run_id is uniquely indexed WITHOUT a workspace_id scope
    // (schema/ci.ts) — two workspaces could (rarely) track the same external
    // repo string and observe the same real GitHub run id. The setWhere
    // guard must stop workspace WS from silently overwriting OTHER_WS's row.
    const { db, ciRuns } = makeFakeDb();
    const repo = new RunsRepository(db);

    await repo.upsertByGithubRunId(
      OTHER_WS,
      INSTALLATION_ID,
      'gh-run-shared',
      baseValues({ agent: 'Other Workspace Agent' }),
    );

    await expect(
      repo.upsertByGithubRunId(
        WS,
        INSTALLATION_ID,
        'gh-run-shared',
        baseValues({ agent: 'This Workspace Agent' }),
      ),
    ).rejects.toThrow(ConfigError);

    // The other workspace's row is untouched — no silent cross-tenant overwrite.
    expect(ciRuns).toHaveLength(1);
    expect(ciRuns[0]?.workspaceId).toBe(OTHER_WS);
    expect(ciRuns[0]?.agent).toBe('Other Workspace Agent');
  });
});

describe('RunsRepository.statusesByGithubRunId', () => {
  it('returns a map keyed by github_run_id for the requested ids, workspace-scoped', async () => {
    const { db, ciRuns } = makeFakeDb();
    const repo = new RunsRepository(db);
    await repo.upsertByGithubRunId(
      WS,
      INSTALLATION_ID,
      'gh-run-1',
      baseValues({ status: 'succeeded', findingsCount: 3 }),
    );
    await repo.upsertByGithubRunId(
      WS,
      INSTALLATION_ID,
      'gh-run-2',
      baseValues({ status: 'running', findingsCount: null }),
    );
    // A third run exists but is deliberately NOT in the requested id batch —
    // must not leak into the returned map.
    await repo.upsertByGithubRunId(WS, INSTALLATION_ID, 'gh-run-3', baseValues({ status: 'failed' }));
    expect(ciRuns).toHaveLength(3); // sanity: all three were actually persisted

    const result = await repo.statusesByGithubRunId(WS, ['gh-run-1', 'gh-run-2']);

    expect(result.size).toBe(2);
    expect(result.get('gh-run-1')).toEqual({ status: 'succeeded', findingsCount: 3 });
    expect(result.get('gh-run-2')).toEqual({ status: 'running', findingsCount: null });
    expect(result.has('gh-run-3')).toBe(false); // not requested, correctly excluded
  });

  it('excludes another workspace\'s row for the same github_run_id — never leaks cross-tenant status', async () => {
    // Mirrors the upsert collision scenario above: two workspaces CAN
    // (rarely) observe the same real GitHub run id. A status lookup must
    // stay workspace-scoped just like every other query in this repository.
    const { db } = makeFakeDb();
    const repo = new RunsRepository(db);
    await repo.upsertByGithubRunId(
      OTHER_WS,
      INSTALLATION_ID,
      'gh-run-shared',
      baseValues({ status: 'succeeded', findingsCount: 5 }),
    );

    const result = await repo.statusesByGithubRunId(WS, ['gh-run-shared']);

    expect(result.has('gh-run-shared')).toBe(false);
  });

  it('resolves an empty map without querying when githubRunIds is empty', async () => {
    const { db, ciRuns } = makeFakeDb();
    const repo = new RunsRepository(db);
    await repo.upsertByGithubRunId(WS, INSTALLATION_ID, 'gh-run-1', baseValues());
    expect(ciRuns).toHaveLength(1);

    const result = await repo.statusesByGithubRunId(WS, []);

    expect(result.size).toBe(0);
  });

  it('resolves an empty map when none of the requested ids have been observed yet', async () => {
    const { db } = makeFakeDb();
    const repo = new RunsRepository(db);

    const result = await repo.statusesByGithubRunId(WS, ['gh-run-never-seen']);

    expect(result.size).toBe(0);
  });
});

describe('RunsRepository.list', () => {
  it('returns the workspace-scoped rows the query resolves to', async () => {
    const { db, ciRuns } = makeFakeDb();
    const repo = new RunsRepository(db);
    await repo.upsertByGithubRunId(WS, INSTALLATION_ID, 'gh-run-1', baseValues());
    await repo.upsertByGithubRunId(WS, INSTALLATION_ID, 'gh-run-2', baseValues());

    const result = await repo.list(WS, {});

    expect(result).toHaveLength(2);
    expect(result).toBe(ciRuns); // same underlying data threaded through select/join/where/orderBy
  });

  it('resolves to an empty array when no runs exist yet', async () => {
    const { db } = makeFakeDb();
    const repo = new RunsRepository(db);

    const result = await repo.list(WS, { repo: 'acme/api', status: 'succeeded', sinceDays: 7 });

    expect(result).toEqual([]);
  });
});

describe('RunsRepository.getLastCheckedAt / setLastCheckedAt', () => {
  it('getLastCheckedAt returns null when no marker has been set', async () => {
    const { db } = makeFakeDb();
    const repo = new RunsRepository(db);

    await expect(repo.getLastCheckedAt(WS)).resolves.toBeNull();
  });

  it('round-trips a set value', async () => {
    const { db } = makeFakeDb();
    const repo = new RunsRepository(db);
    const at = new Date('2026-07-10T12:00:00Z');

    await repo.setLastCheckedAt(WS, at);
    const result = await repo.getLastCheckedAt(WS);

    expect(result).toEqual(at);
  });

  it('a second setLastCheckedAt call updates the same settings row — no duplicate row', async () => {
    const { db, settings } = makeFakeDb();
    const repo = new RunsRepository(db);

    await repo.setLastCheckedAt(WS, new Date('2026-07-10T00:00:00Z'));
    await repo.setLastCheckedAt(WS, new Date('2026-07-10T06:00:00Z'));

    expect(settings).toHaveLength(1); // updated in place, not duplicated
    const result = await repo.getLastCheckedAt(WS);
    expect(result).toEqual(new Date('2026-07-10T06:00:00Z'));
  });
});
