/**
 * Hermetic tests for `ci/ingest-service.ts`'s `IngestService`.
 *
 * A combined hand-rolled fake `Db` models the exact Drizzle chain shapes used
 * by `InstallationsRepository.listTracked` and `RunsRepository`'s
 * upsert/list/settings methods — mirroring `ci-installations-repository.test.ts`
 * and `ci-runs-repository.test.ts`'s own fake-db conventions, combined into
 * one since `IngestService` lazily constructs BOTH real repositories from the
 * same `container.db`. `container.github()`/`container.agentsRepo` are
 * supplied directly as plain stub properties on a hand-built container object
 * (no real `Container` instance needed) — same convention as
 * `onboarding-service.test.ts`'s `makeContainer`. No Postgres, no Docker.
 */
import { describe, it, expect, vi } from 'vitest';
import JSZip from 'jszip';
import { IngestService } from '../src/modules/ci/ingest-service.js';
import { CI_RESULT_ARTIFACT_NAME } from '../src/modules/ci/helpers.js';
import { MockGitHubClient, type MockWorkflowRun, type MockRunArtifact } from '../src/adapters/mocks.js';
import { ExternalServiceError } from '../src/platform/errors.js';
import type { Container } from '../src/platform/container.js';
import type { Db } from '../src/db/client.js';
import type { CiInstallationRow } from '../src/modules/ci/repository/installations.repo.js';
import type { CiRunRow } from '../src/modules/ci/repository/runs.repo.js';
import type { CiResultArtifact, GitHubClient, RepoRef } from '@devdigest/shared';
import * as t from '../src/db/schema.js';

const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const AGENT_ID = '22222222-2222-2222-2222-222222222222';
const INSTALLATION_ID = '33333333-3333-3333-3333-333333333333';
const REPO = 'acme/payments-api';
const AGENT_NAME = 'Security Reviewer';

function makeInstallation(overrides: Partial<CiInstallationRow> = {}): CiInstallationRow {
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
  } as CiInstallationRow;
}

function makeArtifact(overrides: Partial<CiResultArtifact> = {}): CiResultArtifact {
  return {
    findings_count: 3,
    critical: 1,
    warning: 2,
    suggestion: 0,
    cost_usd: 0.05,
    duration_ms: 12345,
    // Deliberately NOT the real installation's agent — several tests assert
    // this is never trusted for attribution (AC-22).
    agent: 'Claimed-By-Artifact Agent',
    version: '1.0.0',
    pr_number: 42,
    ...overrides,
  };
}

async function zipOf(filename: string, contents: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(filename, contents);
  return zip.generateAsync({ type: 'nodebuffer' });
}

interface SettingsRow {
  id: string;
  workspaceId: string;
  userId: string | null;
  key: string;
  value: unknown;
}

interface FakeCiRunInsertValues {
  workspaceId: string;
  ciInstallationId: string;
  githubRunId: string;
  [key: string]: unknown;
}

/**
 * Recursively walks a real drizzle-orm SQL condition tree (as built by
 * `and(eq(...), inArray(...))` or a bare `eq()`) for a column whose `.name`
 * matches `columnName`, returning its bound value. For an `eq()` match the
 * bound value sits 2 chunks after the column (a `Param`-like `{value}`
 * wrapper); for an `inArray()` match it's an ARRAY of such wrappers at the
 * same position, returned here as a plain array. Mirrors
 * `ci-runs-repository.test.ts`'s `findColumnValue` (verified against the
 * installed drizzle-orm@0.38 runtime shape there); duplicated locally per
 * this file's existing no-shared-test-utils convention. Used both for the
 * upsert's `setWhere` cross-workspace guard and the new
 * `statusesByGithubRunId` read path — both real `RunsRepository` code paths
 * this combined fake exercises.
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

/**
 * Combined fake `Db`: `ci_installations` select (listTracked), `ci_runs`
 * insert/upsert + select/join (upsertByGithubRunId, list) + select/where
 * (statusesByGithubRunId), `settings` insert/select/update
 * (getLastCheckedAt/setLastCheckedAt). Real in-memory arrays back genuine
 * upsert-by-githubRunId semantics (find-or-push, then apply the conflict
 * `set`, honoring `setWhere`'s workspace guard exactly like real Postgres)
 * so the dedup/collision/status-lookup assertions are real, not scripted.
 */
function makeFakeDb(installations: CiInstallationRow[]) {
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
                  // semantics: when setWhere evaluates false against the
                  // EXISTING row, no update happens and no row is returned
                  // (the repository's own `if (!row) throw` turns that into
                  // a ConfigError) — see runs.repo.ts's upsertByGithubRunId.
                  if (conf.setWhere) {
                    const requiredWorkspaceId = findColumnValue(conf.setWhere, 'workspace_id');
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
            where: (cond: unknown) => {
              // setTimestampSetting updates by id (eq(settings.id, existingId));
              // find that exact row so distinct keys never clobber each other.
              const id = findColumnValue(cond, 'id');
              const row = id !== undefined ? settings.find((r) => r.id === id) : settings[0];
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
        if (table === t.ciInstallations) {
          // listTracked: select().from().where() — awaited directly, no .limit().
          return { where: () => Promise.resolve(installations) };
        }
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
            // condition tree so cross-workspace rows never leak into the map.
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
          // Key-aware: getTimestampSetting filters by (workspace, user_id NULL,
          // key). Distinct markers (ci_last_checked_at vs ci_runs_cleared_at)
          // must never read each other's value.
          return {
            where: (cond: unknown) => ({
              limit: (_n: number) => {
                const key = findColumnValue(cond, 'key');
                return Promise.resolve(
                  settings
                    .filter((r) => key === undefined || r.key === key)
                    .map((r) => ({ id: r.id, value: r.value })),
                );
              },
            }),
          };
        }
        throw new Error('unexpected select-from table in fake db');
      },
    }),
    delete: (table: unknown) => {
      if (table === t.ciRuns) {
        // deleteAllForWorkspace: delete(ciRuns).where(eq(workspace_id)).returning({id}).
        return {
          where: (cond: unknown) => ({
            returning: (): Promise<{ id: string }[]> => {
              const wsId = findColumnValue(cond, 'workspace_id');
              const removed = ciRuns.filter((r) => r.workspaceId === wsId);
              for (let i = ciRuns.length - 1; i >= 0; i--) {
                if (ciRuns[i]!.workspaceId === wsId) ciRuns.splice(i, 1);
              }
              return Promise.resolve(removed.map((r) => ({ id: r.id })));
            },
          }),
        };
      }
      throw new Error('unexpected delete table in fake db');
    },
  };

  return { db: fakeDb as unknown as Db, ciRuns, settings };
}

interface MakeContainerOpts {
  installations?: CiInstallationRow[];
  github?: GitHubClient;
  agentName?: string;
}

/** Hand-built container stub — only the members IngestService touches. */
function makeContainer(opts: MakeContainerOpts = {}) {
  const installations = opts.installations ?? [makeInstallation()];
  const { db, ciRuns, settings } = makeFakeDb(installations);
  const github = opts.github ?? new MockGitHubClient();
  const agentName = opts.agentName ?? AGENT_NAME;

  const container = {
    db,
    github: async () => github,
    agentsRepo: {
      getById: async (_workspaceId: string, _id: string) => ({ id: AGENT_ID, name: agentName }),
    },
  } as unknown as Container;

  return { container, ciRuns, settings, github };
}

// ---------------------------------------------------------------------------

describe('IngestService.checkForNewResults', () => {
  it('happy path: a completed+success run with a full artifact upserts a fully-populated row', async () => {
    const workflowRuns: MockWorkflowRun[] = [
      {
        id: 9001,
        status: 'completed',
        conclusion: 'success',
        html_url: 'https://github.com/acme/payments-api/actions/runs/9001',
        created_at: '2026-07-10T00:00:00Z',
      },
    ];
    const artifact = makeArtifact({ findings_count: 4 });
    const buf = await zipOf('devdigest-result.json', JSON.stringify(artifact));
    const github = new MockGitHubClient({
      workflowRuns,
      artifacts: [{ id: 5001, name: CI_RESULT_ARTIFACT_NAME, expired: false }],
      artifactContents: buf,
    });
    const { container, ciRuns } = makeContainer({ github });
    const service = new IngestService(container);

    const result = await service.checkForNewResults(WORKSPACE_ID);

    expect(ciRuns).toHaveLength(1);
    expect(result.runs_updated).toHaveLength(1);
    const dto = result.runs_updated[0]!;
    expect(dto.status).toBe('succeeded');
    expect(dto.findings_count).toBe(4);
    expect(dto.repo).toBe(REPO);
    expect(dto.agent).toBe(AGENT_NAME); // from the installation/agent lookup
    expect(dto.github_url).toBe(workflowRuns[0]!.html_url);
    expect(typeof result.checked_at).toBe('string');

    // Fixed workflow filename + correct repo-string parsing — never per-installation derived.
    expect(github.listedRuns).toEqual([
      { repo: { owner: 'acme', name: 'payments-api' }, workflowFile: 'devdigest-review.yml' },
    ]);
  });

  it('a non-completed run maps to "running" with every metric field null', async () => {
    const workflowRuns: MockWorkflowRun[] = [
      {
        id: 9002,
        status: 'in_progress',
        conclusion: null,
        html_url: 'https://github.com/acme/payments-api/actions/runs/9002',
        created_at: '2026-07-10T00:00:00Z',
      },
    ];
    const github = new MockGitHubClient({ workflowRuns });
    const { container } = makeContainer({ github });
    const service = new IngestService(container);

    const result = await service.checkForNewResults(WORKSPACE_ID);

    const dto = result.runs_updated[0]!;
    expect(dto.status).toBe('running');
    expect(dto.findings_count).toBeNull();
    expect(dto.cost_usd).toBeNull();
    expect(dto.critical).toBeNull();
    expect(dto.duration_s).toBeNull();
    // listRunArtifacts/downloadArtifact must never even be attempted for a non-completed run.
    expect(github.listedArtifacts).toHaveLength(0);
  });

  it('a completed+skipped run maps end to end to "skipped_fork"', async () => {
    const workflowRuns: MockWorkflowRun[] = [
      {
        id: 9003,
        status: 'completed',
        conclusion: 'skipped',
        html_url: 'https://github.com/acme/payments-api/actions/runs/9003',
        created_at: '2026-07-10T00:00:00Z',
      },
    ];
    const github = new MockGitHubClient({ workflowRuns });
    const { container, ciRuns } = makeContainer({ github });
    const service = new IngestService(container);

    const result = await service.checkForNewResults(WORKSPACE_ID);

    expect(result.runs_updated[0]!.status).toBe('skipped_fork');
    expect(result.runs_updated[0]!.findings_count).toBeNull();
    // Assert against the actually-persisted row, not just the returned DTO.
    expect(ciRuns[0]!.status).toBe('skipped_fork');
  });

  it('selects the result artifact by CI_RESULT_ARTIFACT_NAME, not positionally, when multiple artifacts exist', async () => {
    const workflowRuns: MockWorkflowRun[] = [
      {
        id: 9004,
        status: 'completed',
        conclusion: 'success',
        html_url: 'https://github.com/acme/payments-api/actions/runs/9004',
        created_at: '2026-07-10T00:00:00Z',
      },
    ];
    // The NAME-MATCHING artifact is deliberately listed SECOND — a positional
    // "just take the first one" implementation would pick the wrong one.
    const artifacts: MockRunArtifact[] = [
      { id: 111, name: 'unrelated-build-log', expired: false },
      { id: 222, name: CI_RESULT_ARTIFACT_NAME, expired: false },
    ];
    const buf = await zipOf('devdigest-result.json', JSON.stringify(makeArtifact()));
    const github = new MockGitHubClient({ workflowRuns, artifacts, artifactContents: buf });
    const { container } = makeContainer({ github });
    const service = new IngestService(container);

    await service.checkForNewResults(WORKSPACE_ID);

    expect(github.downloadedArtifacts).toHaveLength(1);
    expect(github.downloadedArtifacts[0]!.artifactId).toBe(222); // the name-matched one, not 111
  });

  it('no artifact matches by name: falls back gracefully (no crash), same as a download failure', async () => {
    const workflowRuns: MockWorkflowRun[] = [
      {
        id: 9005,
        status: 'completed',
        conclusion: 'success',
        html_url: 'https://github.com/acme/payments-api/actions/runs/9005',
        created_at: '2026-07-10T00:00:00Z',
      },
    ];
    const github = new MockGitHubClient({
      workflowRuns,
      artifacts: [{ id: 333, name: 'not-the-result-artifact', expired: false }],
    });
    const { container } = makeContainer({ github });
    const service = new IngestService(container);

    const result = await service.checkForNewResults(WORKSPACE_ID);

    expect(github.downloadedArtifacts).toHaveLength(0); // never attempted — no name match
    const dto = result.runs_updated[0]!;
    expect(dto.status).toBe('no_findings'); // fallback: completed+success, no artifact
    expect(dto.findings_count).toBeNull();
  });

  it('a downloadArtifact failure degrades to the null-artifact fallback instead of crashing the loop', async () => {
    const workflowRuns: MockWorkflowRun[] = [
      {
        id: 9006,
        status: 'completed',
        conclusion: 'failure',
        html_url: 'https://github.com/acme/payments-api/actions/runs/9006',
        created_at: '2026-07-10T00:00:00Z',
      },
    ];
    class ThrowingDownloadGithub extends MockGitHubClient {
      override async downloadArtifact(): Promise<Buffer> {
        throw new Error('network blip / expired artifact');
      }
    }
    const github = new ThrowingDownloadGithub({
      workflowRuns,
      artifacts: [{ id: 444, name: CI_RESULT_ARTIFACT_NAME, expired: false }],
    });
    const { container } = makeContainer({ github });
    const service = new IngestService(container);

    const result = await service.checkForNewResults(WORKSPACE_ID);

    const dto = result.runs_updated[0]!;
    expect(dto.status).toBe('failed'); // fallback: completed+non-success, no artifact
    expect(dto.findings_count).toBeNull();
  });

  it("an artifact's duration_ms is persisted as rounded whole-second duration_s, never raw milliseconds", async () => {
    const workflowRuns: MockWorkflowRun[] = [
      {
        id: 9007,
        status: 'completed',
        conclusion: 'success',
        html_url: 'https://github.com/acme/payments-api/actions/runs/9007',
        created_at: '2026-07-10T00:00:00Z',
      },
    ];
    const artifact = makeArtifact({ duration_ms: 12345 });
    const buf = await zipOf('devdigest-result.json', JSON.stringify(artifact));
    const github = new MockGitHubClient({
      workflowRuns,
      artifacts: [{ id: 555, name: CI_RESULT_ARTIFACT_NAME, expired: false }],
      artifactContents: buf,
    });
    const { container, ciRuns } = makeContainer({ github });
    const service = new IngestService(container);

    const result = await service.checkForNewResults(WORKSPACE_ID);

    expect(result.runs_updated[0]!.duration_s).toBe(12); // Math.round(12345 / 1000)
    // The persisted row itself (not just the returned DTO) must store the
    // rounded seconds value — never the raw milliseconds — anywhere.
    expect(ciRuns[0]!.durationS).toBe(12);
    expect(ciRuns[0]!.durationS).not.toBe(12345);
  });

  it('calling checkForNewResults twice for the same github run id upserts the same row — no duplicate', async () => {
    const workflowRuns: MockWorkflowRun[] = [
      {
        id: 9008,
        status: 'completed',
        conclusion: 'success',
        html_url: 'https://github.com/acme/payments-api/actions/runs/9008',
        created_at: '2026-07-10T00:00:00Z',
      },
    ];
    // No `artifacts`/`artifactContents` override — MockGitHubClient's
    // default `downloadArtifact` payload is not a valid zip, so every
    // attempt degrades to the null-artifact fallback (findingsCount stays
    // null). This is deliberately the DEGRADED case, distinct from the
    // "terminal + real artifact" skip-refetch fix below: a degraded row must
    // keep retrying on every poll (the artifact may become available
    // later), never get skip-cached like a genuinely fully-ingested one.
    const github = new MockGitHubClient({ workflowRuns });
    const { container, ciRuns } = makeContainer({ github });
    const service = new IngestService(container);

    await service.checkForNewResults(WORKSPACE_ID);
    expect(ciRuns).toHaveLength(1);
    expect(ciRuns[0]!.findingsCount).toBeNull(); // confirms this row IS the degraded case
    expect(github.listedArtifacts).toHaveLength(1);

    await service.checkForNewResults(WORKSPACE_ID);

    expect(ciRuns).toHaveLength(1); // still no duplicate row
    // The degraded (null-findingsCount) terminal row DOES retry the
    // artifact fetch on the second poll — the AC-27 skip-refetch fix must
    // NOT cache a degraded outcome the same way it caches a real one.
    expect(github.listedArtifacts).toHaveLength(2);
  });

  // ---------------------------------------------------------------------
  // Fix: per-installation failure isolation (AC-17) — one broken
  // installation must never abort the check for the others, and
  // setLastCheckedAt must still advance.
  // ---------------------------------------------------------------------

  it('one installation whose listWorkflowRuns throws does not abort the check for the OTHER installations', async () => {
    const installations = [
      makeInstallation({ id: 'inst-1', repo: 'acme/repo-one' }),
      makeInstallation({ id: 'inst-2', repo: 'acme/repo-two' }),
      makeInstallation({ id: 'inst-3', repo: 'acme/repo-three' }),
    ];
    // Throws only for installation #2's repo. #1 and #3 return their OWN
    // distinct run id each (a shared literal run id across two DIFFERENT
    // repos would itself be a github_run_id collision — that's the OTHER
    // regression test below; this one isolates the listWorkflowRuns-throw
    // failure mode specifically).
    class PartiallyBrokenGithub extends MockGitHubClient {
      override async listWorkflowRuns(repo: RepoRef): Promise<MockWorkflowRun[]> {
        if (repo.name === 'repo-two') {
          throw new Error('404: repository not found (renamed or deleted on GitHub)');
        }
        const id = repo.name === 'repo-one' ? 9401 : 9403;
        return [
          {
            id,
            status: 'completed',
            conclusion: 'success',
            html_url: `https://github.com/acme/${repo.name}/actions/runs/${id}`,
            created_at: '2026-07-10T00:00:00Z',
          },
        ];
      }
    }
    const github = new PartiallyBrokenGithub({ artifacts: [] });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const { container, ciRuns } = makeContainer({ installations, github });
    const service = new IngestService(container, logger);

    const result = await service.checkForNewResults(WORKSPACE_ID);

    // Installations #1 and #3 (unaffected repos) were still fully processed
    // — the broken installation #2 never aborted the loop for them.
    expect(ciRuns.filter((r) => r.ciInstallationId === 'inst-1')).toHaveLength(1);
    expect(ciRuns.filter((r) => r.ciInstallationId === 'inst-3')).toHaveLength(1);
    expect(ciRuns.filter((r) => r.ciInstallationId === 'inst-2')).toHaveLength(0);
    expect(result.runs_updated).toHaveLength(2);

    // The failure was logged (per-installation error + the summary warn),
    // never silently swallowed.
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]![0]).toMatchObject({
      installationId: 'inst-2',
      repo: 'acme/repo-two',
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![0]).toMatchObject({ failedInstallations: 1, totalInstallations: 3 });

    // The check as a whole still completed (AC-17: every OTHER installation
    // is still checked) — setLastCheckedAt still advanced instead of the
    // workspace getting stuck failing on every future call.
    const listed = await service.listRuns(WORKSPACE_ID, {});
    expect(listed.last_checked_at).not.toBeNull();
  });

  it('a cross-workspace github_run_id collision (ConfigError from upsertByGithubRunId) on one installation does not abort the others', async () => {
    const OTHER_WS = '55555555-5555-5555-5555-555555555555';
    const installations = [
      makeInstallation({ id: 'inst-1', repo: 'acme/repo-collide' }),
      makeInstallation({ id: 'inst-2', repo: 'acme/repo-clean' }),
    ];
    // Two DIFFERENT workspaces' installations legitimately tracking
    // different repos, but the ci_installations fixture here simulates the
    // documented supported scenario (server/insights.md 2026-07-10 Decision)
    // by having installation #1's repo observe a github_run_id that ALREADY
    // belongs to another workspace's row (pre-seeded below).
    class DualRepoGithub extends MockGitHubClient {
      override async listWorkflowRuns(repo: RepoRef): Promise<MockWorkflowRun[]> {
        if (repo.name === 'repo-collide') {
          return [
            {
              id: 9999,
              status: 'completed',
              conclusion: 'success',
              html_url: 'https://github.com/acme/repo-collide/actions/runs/9999',
              created_at: '2026-07-10T00:00:00Z',
            },
          ];
        }
        return [
          {
            id: 8888,
            status: 'completed',
            conclusion: 'success',
            html_url: 'https://github.com/acme/repo-clean/actions/runs/8888',
            created_at: '2026-07-10T00:05:00Z',
          },
        ];
      }
    }
    const github = new DualRepoGithub({ artifacts: [] }); // no artifact → degraded no_findings fallback, irrelevant to this test
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const { container, ciRuns } = makeContainer({ installations, github });
    // Pre-seed a row for run id "9999" already owned by a DIFFERENT
    // workspace — the exact scenario upsertByGithubRunId's setWhere guard
    // exists for.
    ciRuns.push({
      id: 'preexisting-other-ws-row',
      ciInstallationId: 'some-other-installation',
      prNumber: null,
      ranAt: null,
      status: 'succeeded',
      findingsCount: 2,
      costUsd: null,
      githubUrl: null,
      source: null,
      workspaceId: OTHER_WS,
      githubRunId: '9999',
      repo: null,
      agent: null,
      durationS: null,
      critical: null,
      warning: null,
      suggestion: null,
    } as CiRunRow);

    const service = new IngestService(container, logger);

    const result = await service.checkForNewResults(WORKSPACE_ID);

    // Installation #1's upsert collided (ConfigError) and was skipped;
    // installation #2 was completely unaffected.
    expect(ciRuns.filter((r) => r.workspaceId === WORKSPACE_ID)).toHaveLength(1);
    expect(ciRuns.find((r) => r.workspaceId === WORKSPACE_ID)?.githubRunId).toBe('8888');
    expect(result.runs_updated).toHaveLength(1);
    expect(result.runs_updated[0]!.github_url).toContain('8888');

    // The other workspace's pre-existing row is untouched — no silent
    // cross-tenant overwrite, and no crash of the OWN workspace's check.
    const otherRow = ciRuns.find((r) => r.workspaceId === OTHER_WS);
    expect(otherRow?.githubRunId).toBe('9999');
    expect(otherRow?.agent).toBeNull();

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]![0]).toMatchObject({ installationId: 'inst-1' });

    const listed = await service.listRuns(WORKSPACE_ID, {});
    expect(listed.last_checked_at).not.toBeNull();
  });

  // ---------------------------------------------------------------------
  // Fix: skip a redundant artifact re-download for an already-terminal run
  // on a later poll (AC-27 budget).
  // ---------------------------------------------------------------------

  it('a run already ingested with a terminal status + real artifact is not re-fetched on a later poll, while a different still-in-progress run in the same batch IS still checked', async () => {
    const terminalRun: MockWorkflowRun = {
      id: 9501,
      status: 'completed',
      conclusion: 'success',
      html_url: 'https://github.com/acme/payments-api/actions/runs/9501',
      created_at: '2026-07-10T00:00:00Z',
    };
    const inProgressRun: MockWorkflowRun = {
      id: 9502,
      status: 'in_progress',
      conclusion: null,
      html_url: 'https://github.com/acme/payments-api/actions/runs/9502',
      created_at: '2026-07-10T00:05:00Z',
    };
    const artifact = makeArtifact({ findings_count: 5 });
    const buf = await zipOf('devdigest-result.json', JSON.stringify(artifact));
    const github = new MockGitHubClient({
      workflowRuns: [terminalRun, inProgressRun],
      artifacts: [{ id: 7001, name: CI_RESULT_ARTIFACT_NAME, expired: false }],
      artifactContents: buf,
    });
    const { container, ciRuns } = makeContainer({ github });
    const service = new IngestService(container);

    const first = await service.checkForNewResults(WORKSPACE_ID);

    // First poll: the terminal run fetches its artifact once; the
    // in-progress run never attempts an artifact fetch at all.
    expect(github.listedArtifacts).toHaveLength(1);
    expect(github.downloadedArtifacts).toHaveLength(1);
    const terminalDto1 = first.runs_updated.find((r) => r.github_url?.includes('9501'));
    expect(terminalDto1?.status).toBe('succeeded');
    expect(terminalDto1?.findings_count).toBe(5);
    const inProgressDto1 = first.runs_updated.find((r) => r.github_url?.includes('9502'));
    expect(inProgressDto1?.status).toBe('running');
    expect(ciRuns).toHaveLength(2);

    // Second poll: the terminal run is observed again UNCHANGED (GitHub's
    // own report for a completed run never changes); the other run has now
    // finished too — a genuinely NEW observation for that one.
    const finishedRun: MockWorkflowRun = { ...inProgressRun, status: 'completed', conclusion: 'success' };
    github.listWorkflowRuns = async (repoRef) =>
      `${repoRef.owner}/${repoRef.name}` === REPO ? [terminalRun, finishedRun] : [];

    const second = await service.checkForNewResults(WORKSPACE_ID);

    // TOTAL across both polls: if the fix works, exactly ONE more
    // list/download happened this poll (for run 9502 only) — 2 total, not 3.
    // Without the fix, run 9501 would be re-fetched too (3 total).
    expect(github.listedArtifacts).toHaveLength(2);
    expect(github.listedArtifacts[1]!.runId).toBe(9502);
    expect(github.downloadedArtifacts).toHaveLength(2);

    // The already-ingested run never re-appears in this call's runs_updated
    // — nothing changed, nothing was re-upserted for it.
    expect(second.runs_updated.some((r) => r.github_url?.includes('9501'))).toBe(false);

    // The newly-finished run DOES appear, correctly resolved.
    const finishedDto = second.runs_updated.find((r) => r.github_url?.includes('9502'));
    expect(finishedDto?.status).toBe('succeeded');
    expect(finishedDto?.findings_count).toBe(5);

    // The terminal run's original row is untouched in the DB — still
    // exactly 2 rows total, no duplicate, no stale overwrite.
    expect(ciRuns).toHaveLength(2);
    const terminalRow = ciRuns.find((r) => r.githubRunId === '9501');
    expect(terminalRow?.status).toBe('succeeded');
    expect(terminalRow?.findingsCount).toBe(5);
  });

  it('rejects with ExternalServiceError (not the internal TimeoutError) when a GitHub call never resolves', async () => {
    vi.useFakeTimers();
    try {
      const hangingGithub = {
        listWorkflowRuns: () => new Promise<never>(() => {}), // never settles
      } as unknown as GitHubClient;
      const { container } = makeContainer({ github: hangingGithub });
      const service = new IngestService(container);

      const resultPromise = service.checkForNewResults(WORKSPACE_ID);
      const assertion = expect(resultPromise).rejects.toBeInstanceOf(ExternalServiceError);

      await vi.advanceTimersByTimeAsync(30_000);

      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('IngestService.listRuns', () => {
  it('never trusts identity fields from a parsed artifact — repo/agent come from the installation/agent lookup', async () => {
    const workflowRuns: MockWorkflowRun[] = [
      {
        id: 9009,
        status: 'completed',
        conclusion: 'success',
        html_url: 'https://github.com/acme/payments-api/actions/runs/9009',
        created_at: '2026-07-10T00:00:00Z',
      },
    ];
    // The artifact's OWN `agent` field claims a different identity — must be ignored (AC-22).
    const artifact = makeArtifact({ agent: 'Totally Different Claimed Agent' });
    const buf = await zipOf('devdigest-result.json', JSON.stringify(artifact));
    const github = new MockGitHubClient({
      workflowRuns,
      artifacts: [{ id: 666, name: CI_RESULT_ARTIFACT_NAME, expired: false }],
      artifactContents: buf,
    });
    const { container } = makeContainer({ github, agentName: AGENT_NAME });
    const service = new IngestService(container);

    await service.checkForNewResults(WORKSPACE_ID);
    const listed = await service.listRuns(WORKSPACE_ID, {});

    expect(listed.runs).toHaveLength(1);
    expect(listed.runs[0]!.agent).toBe(AGENT_NAME); // installation/agent lookup, not the artifact's claim
    expect(listed.runs[0]!.repo).toBe(REPO); // installation's own repo field
    expect(listed.last_checked_at).not.toBeNull();
  });

  it('resolves an empty run list and null last_checked_at when nothing has ever been checked', async () => {
    const { container } = makeContainer({ installations: [] });
    const service = new IngestService(container);

    const result = await service.listRuns(WORKSPACE_ID, {});

    expect(result.runs).toEqual([]);
    expect(result.last_checked_at).toBeNull();
  });
});

describe('IngestService.clearRuns', () => {
  it('deletes all runs, records a cleared-at marker, and a later check does NOT re-import older runs', async () => {
    const workflowRuns: MockWorkflowRun[] = [
      {
        id: 9101,
        status: 'completed',
        conclusion: 'success',
        html_url: 'https://github.com/acme/payments-api/actions/runs/9101',
        created_at: '2026-07-10T00:00:00Z',
      },
    ];
    const artifact = makeArtifact({ findings_count: 2 });
    const buf = await zipOf('devdigest-result.json', JSON.stringify(artifact));
    const github = new MockGitHubClient({
      workflowRuns,
      artifacts: [{ id: 5101, name: CI_RESULT_ARTIFACT_NAME, expired: false }],
      artifactContents: buf,
    });
    const { container, ciRuns, settings } = makeContainer({ github });
    const service = new IngestService(container);

    // First check ingests the GitHub run.
    await service.checkForNewResults(WORKSPACE_ID);
    expect(ciRuns).toHaveLength(1);

    // Clear wipes the rows AND records the cleared-at marker.
    const cleared = await service.clearRuns(WORKSPACE_ID);
    expect(cleared.deleted).toBe(1);
    expect(ciRuns).toHaveLength(0);
    expect(settings.some((s) => s.key === 'ci_runs_cleared_at')).toBe(true);

    // The old GitHub run (created 2026-07-10, before the clear) must NOT come
    // back on the next check — a cleared history stays cleared.
    const after = await service.checkForNewResults(WORKSPACE_ID);
    expect(ciRuns).toHaveLength(0);
    expect(after.runs_updated).toHaveLength(0);
  });

  it('a run created AFTER the clear is still ingested normally', async () => {
    const { container, ciRuns } = makeContainer();
    const service = new IngestService(container);

    // Clear first (sets the marker to ~now).
    await service.clearRuns(WORKSPACE_ID);

    // A brand-new run, created in the future relative to the clear.
    const github = new MockGitHubClient({
      workflowRuns: [
        {
          id: 9202,
          status: 'completed',
          conclusion: 'success',
          html_url: 'https://github.com/acme/payments-api/actions/runs/9202',
          created_at: '2099-01-01T00:00:00Z',
        },
      ],
      artifacts: [{ id: 5202, name: CI_RESULT_ARTIFACT_NAME, expired: false }],
      artifactContents: await zipOf('devdigest-result.json', JSON.stringify(makeArtifact({ findings_count: 1 }))),
    });
    // Swap the container's github to the one returning the post-clear run.
    (container as unknown as { github: () => Promise<GitHubClient> }).github = async () => github;

    const after = await service.checkForNewResults(WORKSPACE_ID);
    expect(ciRuns).toHaveLength(1);
    expect(after.runs_updated).toHaveLength(1);
  });
});
