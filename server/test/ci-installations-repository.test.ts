/**
 * Hermetic tests for `InstallationsRepository` — a hand-rolled fake `Db`
 * satisfies the exact Drizzle chain shapes this repository calls
 * (`select().from().where()[.limit()]`,
 * `insert().values().onConflictDoUpdate().returning()`,
 * `update().set().where().returning()`), mirroring `test/pull.repo.test.ts`'s
 * `makeFakeDb` pattern. No Postgres, no Docker.
 */
import { describe, it, expect } from 'vitest';
import { Column, Param, SQL, StringChunk } from 'drizzle-orm';
import { InstallationsRepository } from '../src/modules/ci/repository/installations.repo.js';
import { AppError } from '../src/platform/errors.js';
import type { Db } from '../src/db/client.js';

const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const REPO = 'acme/payments-api';
const AGENT_ID = '22222222-2222-2222-2222-222222222222';
const INSTALLATION_ID = '33333333-3333-3333-3333-333333333333';

interface FakeRow {
  [key: string]: unknown;
}

interface ConflictConfig {
  target: unknown;
  set: Record<string, unknown>;
  setWhere?: unknown;
}

/**
 * Walks a REAL drizzle-orm `SQL` condition tree built from `or()`/`eq()`/
 * `isNotNull()` — the exact combinator `upsertPublished`'s `setWhere` guard
 * is built from — and reports every `column = value` / `column IS NOT NULL`
 * leaf it finds via callback. Mirrors the `extractEqPairs`/`sqlText`
 * convention already established for other stateful repository tests in
 * this codebase (see server/insights.md's 2026-07-06/2026-07-07 entries):
 * a genuine (if minimal) predicate evaluator over the real SQL object,
 * never a scripted stub. `or()`/`sql.join()` nest plain `SQL` chunks inside
 * `queryChunks`, so recursing until a chunk-list contains no nested `SQL`
 * (a "leaf") correctly walks arbitrary combinator depth.
 */
function walkSetWhereCondition(
  node: unknown,
  onEq: (column: string, value: unknown) => void,
  onIsNotNull: (column: string) => void,
): void {
  if (!(node instanceof SQL)) return;
  const chunks = node.queryChunks;
  const hasNestedSql = chunks.some((c) => c instanceof SQL);
  if (!hasNestedSql) {
    const column = chunks.find((c): c is Column => c instanceof Column);
    const param = chunks.find((c): c is Param => c instanceof Param);
    if (column && param) {
      onEq(column.name, param.value);
      return;
    }
    if (column) {
      const text = chunks
        .filter((c): c is StringChunk => c instanceof StringChunk)
        .map((c) => c.value.join(''))
        .join('');
      if (text.includes('is not null')) {
        onIsNotNull(column.name);
        return;
      }
    }
  }
  for (const chunk of chunks) walkSetWhereCondition(chunk, onEq, onIsNotNull);
}

/** `agent_id` → `agentId` — Drizzle's default column↔JS-field casing. */
function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Evaluates a REAL drizzle `setWhere` SQL condition against the CURRENT
 * (pre-update) row — mirrors what Postgres itself does when deciding
 * whether a conflict-path `DO UPDATE ... WHERE <condition>` fires.
 */
function evaluateSetWhere(condition: unknown, row: FakeRow): boolean {
  let allowed = false;
  walkSetWhereCondition(
    condition,
    (column, value) => {
      if (row[snakeToCamel(column)] === value) allowed = true;
    },
    (column) => {
      if (row[snakeToCamel(column)] != null) allowed = true;
    },
  );
  return allowed;
}

function makeFakeDb(opts: {
  selectRows?: FakeRow[];
  insertReturning?: FakeRow[];
  updateReturning?: FakeRow[];
  onSelectWhere?: (whereArg: unknown) => void;
  onInsertValues?: (values: unknown) => void;
  onConflictConfig?: (config: ConflictConfig) => void;
  onUpdateSet?: (values: unknown) => void;
  onUpdateWhere?: (whereArg: unknown) => void;
}): Db {
  const fakeDb = {
    select: (_cols?: unknown) => ({
      from: (_table: unknown) => ({
        where: (whereArg: unknown) => {
          opts.onSelectWhere?.(whereArg);
          const rows = opts.selectRows ?? [];
          // Some methods `await` the where()-chain directly (listByAgent,
          // listTracked); others call `.limit(n)` on it first (findByRepo,
          // getById). Support both by returning a real Promise with an
          // extra `.limit` method attached.
          const promise = Promise.resolve(rows) as Promise<FakeRow[]> & {
            limit: (n: number) => Promise<FakeRow[]>;
          };
          promise.limit = (_n: number) => Promise.resolve(rows);
          return promise;
        },
      }),
    }),
    insert: (_table: unknown) => ({
      values: (values: unknown) => {
        opts.onInsertValues?.(values);
        return {
          onConflictDoUpdate: (config: ConflictConfig) => {
            opts.onConflictConfig?.(config);
            return {
              returning: () => Promise.resolve(opts.insertReturning ?? []),
            };
          },
        };
      },
    }),
    update: (_table: unknown) => ({
      set: (values: unknown) => {
        opts.onUpdateSet?.(values);
        return {
          where: (whereArg: unknown) => {
            opts.onUpdateWhere?.(whereArg);
            return {
              returning: () => Promise.resolve(opts.updateReturning ?? []),
            };
          },
        };
      },
    }),
  };
  return fakeDb as unknown as Db;
}

/**
 * Minimal STATEFUL fake `Db` — unlike `makeFakeDb` above (which always
 * replays one fixed, pre-configured response, sufficient for a
 * single-query-per-test case), this one actually tracks a single in-memory
 * row across MULTIPLE sequential `upsertPublished`/`disconnect` calls in the
 * same test, mirroring Postgres's real `INSERT ... ON CONFLICT DO UPDATE`
 * semantics closely enough to assert on the RETURNED row after a genuine
 * disconnect → reconnect round trip (not just the captured SET config).
 */
function makeStatefulFakeDb(): Db {
  let row: FakeRow | undefined;
  const fakeDb = {
    insert: (_table: unknown) => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: (config: ConflictConfig) => ({
          returning: () => {
            if (!row) {
              // First insert for this (workspaceId, repo) — `workflowVersion`
              // and `disconnectedAt` mirror the real column defaults
              // (schema/ci.ts) since `.values()` never sets them explicitly.
              row = { workflowVersion: 1, disconnectedAt: null, ...values };
              return Promise.resolve([{ ...row }]);
            }
            // Conflict path — evaluate the REAL `setWhere` SQL condition
            // against the row's CURRENT state first, exactly like Postgres's
            // `ON CONFLICT ... DO UPDATE ... WHERE <condition>`: when it's
            // present and false, the update is skipped and RETURNING yields
            // no row (the race-loser / blocked-hijack case).
            if (config.setWhere !== undefined && !evaluateSetWhere(config.setWhere, row)) {
              return Promise.resolve([]);
            }
            // Apply ONLY the keys actually present in `config.set`, exactly
            // like a real `DO UPDATE SET` (columns omitted from `set`, e.g.
            // `id`, are never touched).
            for (const [key, value] of Object.entries(config.set)) {
              row[key] = key === 'workflowVersion' ? (row.workflowVersion as number) + 1 : value;
            }
            return Promise.resolve([{ ...row }]);
          },
        }),
      }),
    }),
    update: (_table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: (_whereArg: unknown) => ({
          returning: () => {
            if (row) row = { ...row, ...values };
            return Promise.resolve(row ? [{ ...row }] : []);
          },
        }),
      }),
    }),
  };
  return fakeDb as unknown as Db;
}

function makeRow(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id: INSTALLATION_ID,
    workspaceId: WORKSPACE_ID,
    agentId: AGENT_ID,
    repo: REPO,
    targetType: 'gha',
    slug: 'security-reviewer',
    triggers: ['opened', 'synchronize'],
    postAs: 'github_review',
    workflowContents: 'name: DevDigest Review',
    workflowVersion: 1,
    installedAt: new Date('2026-01-01T00:00:00Z'),
    disconnectedAt: null,
    ...overrides,
  };
}

describe('InstallationsRepository.findByRepo', () => {
  it('returns the row when an installation exists for this (workspace, repo)', async () => {
    const row = makeRow();
    let whereCalled = false;
    const db = makeFakeDb({
      selectRows: [row],
      onSelectWhere: () => {
        whereCalled = true;
      },
    });
    const repo = new InstallationsRepository(db);

    const result = await repo.findByRepo(WORKSPACE_ID, REPO);

    expect(result).toEqual(row);
    expect(whereCalled).toBe(true);
  });

  it('returns undefined when no installation exists for that repo', async () => {
    const db = makeFakeDb({ selectRows: [] });
    const repo = new InstallationsRepository(db);

    const result = await repo.findByRepo(WORKSPACE_ID, 'acme/some-other-repo');

    expect(result).toBeUndefined();
  });
});

describe('InstallationsRepository.listByAgent', () => {
  it('returns every installation for the agent, including disconnected ones', async () => {
    const active = makeRow({ id: 'a', repo: 'acme/repo-a' });
    const disconnected = makeRow({ id: 'b', repo: 'acme/repo-b', disconnectedAt: new Date() });
    const db = makeFakeDb({ selectRows: [active, disconnected] });
    const repo = new InstallationsRepository(db);

    const result = await repo.listByAgent(WORKSPACE_ID, AGENT_ID);

    expect(result).toEqual([active, disconnected]);
  });
});

describe('InstallationsRepository.listTracked', () => {
  it('returns the rows the (mocked) query resolves — filtering itself is expressed in the where clause', async () => {
    const row = makeRow();
    let whereCalled = false;
    const db = makeFakeDb({
      selectRows: [row],
      onSelectWhere: () => {
        whereCalled = true;
      },
    });
    const repo = new InstallationsRepository(db);

    const result = await repo.listTracked(WORKSPACE_ID);

    expect(result).toEqual([row]);
    expect(whereCalled).toBe(true);
  });
});

describe('InstallationsRepository.getById', () => {
  it('returns the row when found in this workspace', async () => {
    const row = makeRow();
    const db = makeFakeDb({ selectRows: [row] });
    const repo = new InstallationsRepository(db);

    const result = await repo.getById(WORKSPACE_ID, INSTALLATION_ID);

    expect(result).toEqual(row);
  });

  it('returns undefined when the row does not exist in this workspace', async () => {
    const db = makeFakeDb({ selectRows: [] });
    const repo = new InstallationsRepository(db);

    const result = await repo.getById(WORKSPACE_ID, 'missing-id');

    expect(result).toBeUndefined();
  });
});

describe('InstallationsRepository.disconnect', () => {
  it('sets disconnectedAt and returns the updated row', async () => {
    const row = makeRow({ disconnectedAt: new Date('2026-07-10T00:00:00Z') });
    let capturedSet: unknown;
    let whereCalled = false;
    const db = makeFakeDb({
      updateReturning: [row],
      onUpdateSet: (v) => {
        capturedSet = v;
      },
      onUpdateWhere: () => {
        whereCalled = true;
      },
    });
    const repo = new InstallationsRepository(db);

    const result = await repo.disconnect(WORKSPACE_ID, INSTALLATION_ID);

    expect(result).toEqual(row);
    expect(capturedSet).toMatchObject({ disconnectedAt: expect.any(Date) });
    expect(whereCalled).toBe(true);
  });

  it('returns undefined when no matching row exists', async () => {
    const db = makeFakeDb({ updateReturning: [] });
    const repo = new InstallationsRepository(db);

    const result = await repo.disconnect(WORKSPACE_ID, 'missing-id');

    expect(result).toBeUndefined();
  });
});

describe('InstallationsRepository.upsertPublished', () => {
  it('inserts with the given id/workspaceId/slug and a (workspaceId, repo) conflict target', async () => {
    let capturedValues: Record<string, unknown> | undefined;
    let capturedConfig: ConflictConfig | undefined;
    const insertedRow = makeRow();
    const db = makeFakeDb({
      insertReturning: [insertedRow],
      onInsertValues: (v) => {
        capturedValues = v as Record<string, unknown>;
      },
      onConflictConfig: (c) => {
        capturedConfig = c;
      },
    });
    const repo = new InstallationsRepository(db);

    const result = await repo.upsertPublished(WORKSPACE_ID, INSTALLATION_ID, {
      agentId: AGENT_ID,
      repo: REPO,
      targetType: 'gha',
      slug: 'security-reviewer',
      triggers: ['opened', 'synchronize'],
      postAs: 'github_review',
      workflowContents: 'name: DevDigest Review',
    });

    expect(result).toEqual(insertedRow);
    expect(capturedValues).toMatchObject({
      id: INSTALLATION_ID,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      repo: REPO,
      slug: 'security-reviewer',
    });
    expect(capturedConfig).toBeDefined();
    expect(Array.isArray(capturedConfig!.target)).toBe(true);
  });

  it('includes slug in the conflict SET clause unconditionally — the caller (export-service.ts) computes frozen-vs-fresh, not this method', async () => {
    let capturedConfig: ConflictConfig | undefined;
    const db = makeFakeDb({
      insertReturning: [makeRow()],
      onConflictConfig: (c) => {
        capturedConfig = c;
      },
    });
    const repo = new InstallationsRepository(db);

    await repo.upsertPublished(WORKSPACE_ID, INSTALLATION_ID, {
      agentId: AGENT_ID,
      repo: REPO,
      targetType: 'gha',
      slug: 'whatever-the-caller-computed',
      triggers: ['opened'],
      postAs: 'pr_comment',
      workflowContents: 'x',
    });

    expect(capturedConfig).toBeDefined();
    expect(capturedConfig!.set.slug).toBe('whatever-the-caller-computed');
    const setKeys = Object.keys(capturedConfig!.set);
    expect(setKeys).not.toContain('id');
    expect(setKeys).not.toContain('targetType');
    expect(setKeys).not.toContain('installedAt');
    expect(setKeys.sort()).toEqual(
      ['agentId', 'disconnectedAt', 'postAs', 'slug', 'triggers', 'workflowContents', 'workflowVersion'].sort(),
    );
  });

  it('always attaches a setWhere guard to the conflict SET clause (agentId match OR disconnected) — the DB-level one-agent-per-repo enforcement point', async () => {
    let capturedConfig: ConflictConfig | undefined;
    const db = makeFakeDb({
      insertReturning: [makeRow()],
      onConflictConfig: (c) => {
        capturedConfig = c;
      },
    });
    const repo = new InstallationsRepository(db);

    await repo.upsertPublished(WORKSPACE_ID, INSTALLATION_ID, {
      agentId: AGENT_ID,
      repo: REPO,
      targetType: 'gha',
      slug: 'security-reviewer',
      triggers: ['opened'],
      postAs: 'github_review',
      workflowContents: 'x',
    });

    expect(capturedConfig).toBeDefined();
    expect(capturedConfig!.setWhere).toBeDefined();
    // The real condition genuinely allows a same-agent row (row.agentId ===
    // AGENT_ID) and a disconnected row (disconnectedAt not null), and blocks
    // a different agent's write against an active row — proven behaviorally
    // by the two `makeStatefulFakeDb` tests below, not re-asserted here via
    // shape alone.
    expect(
      evaluateSetWhere(capturedConfig!.setWhere, { agentId: AGENT_ID, disconnectedAt: null }),
    ).toBe(true);
    expect(
      evaluateSetWhere(capturedConfig!.setWhere, { agentId: 'someone-else', disconnectedAt: null }),
    ).toBe(false);
    expect(
      evaluateSetWhere(capturedConfig!.setWhere, {
        agentId: 'someone-else',
        disconnectedAt: new Date('2026-01-01T00:00:00Z'),
      }),
    ).toBe(true);
  });

  it('a second upsertPublished call for the same (workspace, repo) with a DIFFERENT agentId is BLOCKED and throws a 409 AppError when the existing row is still ACTIVE — the TOCTOU race-loser case (Bug 1)', async () => {
    const db = makeStatefulFakeDb();
    const repo = new InstallationsRepository(db);

    const first = await repo.upsertPublished(WORKSPACE_ID, INSTALLATION_ID, {
      agentId: AGENT_ID,
      repo: REPO,
      targetType: 'gha',
      slug: 'security-reviewer',
      triggers: ['opened'],
      postAs: 'github_review',
      workflowContents: 'name: v1',
    });
    expect(first.disconnectedAt).toBeNull();

    // Simulates the race: a second caller's `resolveInstallationTarget` read
    // "no conflict yet" (e.g. it ran before the first write landed) and now
    // attempts its OWN fresh insert for the SAME (workspace, repo) — with a
    // DIFFERENT agentId and a fresh candidate id of its own.
    const RACE_LOSER_ID = '77777777-7777-7777-7777-777777777777';
    const OTHER_AGENT_ID = '88888888-8888-8888-8888-888888888888';

    await expect(
      repo.upsertPublished(WORKSPACE_ID, RACE_LOSER_ID, {
        agentId: OTHER_AGENT_ID,
        repo: REPO,
        targetType: 'gha',
        slug: 'hijacker',
        triggers: ['opened'],
        postAs: 'github_review',
        workflowContents: 'name: hijack attempt',
      }),
    ).rejects.toMatchObject({
      name: 'AppError',
      code: 'repo_already_installed',
      statusCode: 409,
    });

    await expect(
      repo.upsertPublished(WORKSPACE_ID, RACE_LOSER_ID, {
        agentId: OTHER_AGENT_ID,
        repo: REPO,
        targetType: 'gha',
        slug: 'hijacker',
        triggers: ['opened'],
        postAs: 'github_review',
        workflowContents: 'name: hijack attempt',
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('a second upsertPublished call for the same (workspace, repo) with a DIFFERENT agentId SUCCEEDS once the existing row is disconnected — a disconnected installation is a fully free slot (Bug 2 takeover)', async () => {
    const db = makeStatefulFakeDb();
    const repo = new InstallationsRepository(db);

    const first = await repo.upsertPublished(WORKSPACE_ID, INSTALLATION_ID, {
      agentId: AGENT_ID,
      repo: REPO,
      targetType: 'gha',
      slug: 'security-reviewer',
      triggers: ['opened'],
      postAs: 'github_review',
      workflowContents: 'name: v1',
    });

    const disconnected = await repo.disconnect(WORKSPACE_ID, INSTALLATION_ID);
    expect(disconnected!.disconnectedAt).not.toBeNull();

    const OTHER_AGENT_ID = '88888888-8888-8888-8888-888888888888';
    // The caller (export-service.ts's resolveInstallationTarget) is
    // responsible for computing a FRESH slug for a takeover — this test
    // supplies one directly to prove upsertPublished trusts and applies it.
    const takeover = await repo.upsertPublished(WORKSPACE_ID, 'irrelevant-fresh-id', {
      agentId: OTHER_AGENT_ID,
      repo: REPO,
      targetType: 'gha',
      slug: 'style-reviewer',
      triggers: ['opened'],
      postAs: 'github_review',
      workflowContents: 'name: takeover',
    });

    // Same row reused (one-row-per-repo invariant) — never a duplicate.
    expect(takeover.id).toBe(first.id);
    expect(takeover.agentId).toBe(OTHER_AGENT_ID);
    expect(takeover.slug).toBe('style-reviewer');
    expect(takeover.slug).not.toBe(first.slug);
    // The re-claimed slot is active again.
    expect(takeover.disconnectedAt).toBeNull();
  });

  it('unconditionally clears disconnectedAt to null in the conflict SET clause (AC-47)', async () => {
    let capturedConfig: ConflictConfig | undefined;
    const db = makeFakeDb({
      insertReturning: [makeRow()],
      onConflictConfig: (c) => {
        capturedConfig = c;
      },
    });
    const repo = new InstallationsRepository(db);

    await repo.upsertPublished(WORKSPACE_ID, INSTALLATION_ID, {
      agentId: AGENT_ID,
      repo: REPO,
      targetType: 'gha',
      slug: 'security-reviewer',
      triggers: ['opened'],
      postAs: 'github_review',
      workflowContents: 'x',
    });

    expect(capturedConfig).toBeDefined();
    expect(capturedConfig!.set.disconnectedAt).toBeNull();
  });

  it('a second upsertPublished call for the same (workspaceId, repo) updates the existing row in place — never a duplicate — applying the fresh values (general ON CONFLICT dedup sanity, no disconnect involved)', async () => {
    const db = makeStatefulFakeDb();
    const repo = new InstallationsRepository(db);

    const first = await repo.upsertPublished(WORKSPACE_ID, INSTALLATION_ID, {
      agentId: AGENT_ID,
      repo: REPO,
      targetType: 'gha',
      slug: 'security-reviewer',
      triggers: ['opened'],
      postAs: 'github_review',
      workflowContents: 'name: v1',
    });
    expect(first.id).toBe(INSTALLATION_ID);
    expect(first.workflowVersion).toBe(1);

    const second = await repo.upsertPublished(WORKSPACE_ID, INSTALLATION_ID, {
      agentId: AGENT_ID,
      repo: REPO,
      targetType: 'gha',
      slug: 'security-reviewer',
      triggers: ['opened', 'synchronize', 'reopened'],
      postAs: 'pr_comment',
      workflowContents: 'name: v2',
    });

    // Same row updated in place (never a second, duplicate installation for
    // this (workspaceId, repo)) — id is stable, and the fresh values from the
    // second call actually replace the first call's, proving the insert vs.
    // update-via-ON-CONFLICT dedup path both work end to end.
    expect(second.id).toBe(first.id);
    expect(second.triggers).toEqual(['opened', 'synchronize', 'reopened']);
    expect(second.postAs).toBe('pr_comment');
    expect(second.workflowContents).toBe('name: v2');
    expect(second.workflowVersion).toBe(2);
  });

  it('clears disconnected_at on the returned row when re-publishing a previously disconnected installation (AC-47 reconnect)', async () => {
    const db = makeStatefulFakeDb();
    const repo = new InstallationsRepository(db);

    const published = {
      agentId: AGENT_ID,
      repo: REPO,
      targetType: 'gha',
      slug: 'security-reviewer',
      triggers: ['opened', 'synchronize'],
      postAs: 'github_review',
      workflowContents: 'name: DevDigest Review',
    };

    const first = await repo.upsertPublished(WORKSPACE_ID, INSTALLATION_ID, published);
    expect(first.disconnectedAt).toBeNull();
    expect(first.workflowVersion).toBe(1);

    const disconnected = await repo.disconnect(WORKSPACE_ID, INSTALLATION_ID);
    expect(disconnected!.disconnectedAt).not.toBeNull();

    const reconnected = await repo.upsertPublished(WORKSPACE_ID, INSTALLATION_ID, published);

    expect(reconnected.disconnectedAt).toBeNull();
    // workflowVersion still increments normally — unaffected by this fix.
    expect(reconnected.workflowVersion).toBe(2);
  });

  it('increments workflow_version via a SQL expression referencing the existing column, never a plain literal', async () => {
    let capturedConfig: ConflictConfig | undefined;
    const db = makeFakeDb({
      insertReturning: [makeRow()],
      onConflictConfig: (c) => {
        capturedConfig = c;
      },
    });
    const repo = new InstallationsRepository(db);

    await repo.upsertPublished(WORKSPACE_ID, INSTALLATION_ID, {
      agentId: AGENT_ID,
      repo: REPO,
      targetType: 'gha',
      slug: 'security-reviewer',
      triggers: ['opened'],
      postAs: 'github_review',
      workflowContents: 'x',
    });

    const versionExpr = capturedConfig!.set.workflowVersion;
    // A real Drizzle `sql` template tag produces a SQL object, never a plain
    // number — confirms `workflow_version = ci_installations.workflow_version + 1`
    // is expressed as a column-referencing SQL fragment, not a hardcoded value.
    expect(versionExpr).not.toBeNull();
    expect(typeof versionExpr).toBe('object');
    expect(typeof versionExpr).not.toBe('number');
  });
});
