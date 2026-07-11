/**
 * Hermetic tests for `ExportService` (Export-to-CI, Step 7). No Postgres, no
 * Docker, no network.
 *
 * `InstallationsRepository`/`RunsRepository` are injected via `ExportService`'s
 * constructor overrides (mirroring `BlastService`'s `repo?` test-injection
 * pattern) as hand-rolled, STATEFUL in-memory fakes — this lets tests assert
 * real upsert-on-conflict semantics (slug/id frozen, workflow_version bumped)
 * without simulating raw Drizzle chains. `container.agentsRepo` is likewise a
 * plain object literal set directly on the fake `Container` (the established
 * `test/onboarding-service.test.ts` convention) — the fake `db` therefore only
 * ever needs to answer ONE query shape: `ExportService`'s own private `t.repos`
 * lookup.
 */
import { describe, it, expect } from 'vitest';
import { ExportService } from '../src/modules/ci/export-service.js';
import { MockGitHubClient, MockRunnerBundler } from '../src/adapters/mocks.js';
import { AppError, NotFoundError } from '../src/platform/errors.js';
import type { Container } from '../src/platform/container.js';
import type { AgentRow } from '../src/db/rows.js';
import type {
  InstallationsRepository,
  CiInstallationRow,
  UpsertPublishedValues,
} from '../src/modules/ci/repository/installations.repo.js';
import type { RunsRepository, CiRunsListFilters } from '../src/modules/ci/repository/runs.repo.js';
import type { CiExportInput, CiExportPreviewInput } from '@devdigest/shared';

const WS_ID = '11111111-1111-1111-1111-111111111111';
const REPO_ID = '22222222-2222-2222-2222-222222222222';
const AGENT_ID = '33333333-3333-3333-3333-333333333333';
const REPO_FULL_NAME = 'acme/payments-api';

function makeAgentRow(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: AGENT_ID,
    workspaceId: WS_ID,
    name: 'Security Reviewer',
    description: '',
    provider: 'openrouter',
    model: 'anthropic/claude-3.5-sonnet',
    systemPrompt: 'Review this PR for security issues.',
    outputSchema: null,
    strategy: 'auto',
    ciFailOn: 'critical',
    repoIntel: true,
    enabled: true,
    version: 1,
    createdBy: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as AgentRow;
}

/**
 * Stateful in-memory fake mirroring `InstallationsRepository`'s documented
 * conflict semantics: `upsertPublished` never overwrites `slug`/`id`/
 * `targetType`/`installedAt`/`disconnectedAt` on an existing row, and always
 * bumps `workflow_version` by exactly 1.
 */
class FakeInstallationsRepo {
  public rows = new Map<string, CiInstallationRow>();
  public upsertCalls: { id: string; values: UpsertPublishedValues }[] = [];

  async findByRepo(workspaceId: string, repo: string): Promise<CiInstallationRow | undefined> {
    return [...this.rows.values()].find((r) => r.workspaceId === workspaceId && r.repo === repo);
  }

  async listByAgent(workspaceId: string, agentId: string): Promise<CiInstallationRow[]> {
    return [...this.rows.values()].filter(
      (r) => r.workspaceId === workspaceId && r.agentId === agentId,
    );
  }

  async listTracked(workspaceId: string): Promise<CiInstallationRow[]> {
    return [...this.rows.values()].filter(
      (r) => r.workspaceId === workspaceId && r.disconnectedAt === null,
    );
  }

  async upsertPublished(
    workspaceId: string,
    id: string,
    values: UpsertPublishedValues,
  ): Promise<CiInstallationRow> {
    this.upsertCalls.push({ id, values });
    const existing = this.rows.get(id);
    const row: CiInstallationRow = existing
      ? {
          ...existing,
          agentId: values.agentId,
          // slug and disconnectedAt ARE overwritten on conflict, exactly
          // like the real repository (Bug 1/2 fix) — the caller
          // (ExportService.resolveInstallationTarget) is responsible for
          // computing the correct value (frozen for a same-agent
          // re-export/reconnect, fresh for a different-agent takeover).
          slug: values.slug,
          triggers: values.triggers,
          postAs: values.postAs,
          workflowContents: values.workflowContents,
          workflowVersion: existing.workflowVersion + 1,
          disconnectedAt: null,
          // id/targetType/installedAt intentionally NOT overwritten —
          // mirrors the real onConflictDoUpdate SET list.
        }
      : {
          id,
          workspaceId,
          agentId: values.agentId,
          repo: values.repo,
          targetType: values.targetType,
          slug: values.slug,
          triggers: values.triggers,
          postAs: values.postAs,
          workflowContents: values.workflowContents,
          workflowVersion: 1,
          installedAt: new Date('2026-01-01T00:00:00Z'),
          disconnectedAt: null,
        };
    this.rows.set(id, row);
    return row;
  }

  async disconnect(workspaceId: string, id: string): Promise<CiInstallationRow | undefined> {
    const row = this.rows.get(id);
    if (!row || row.workspaceId !== workspaceId) return undefined;
    const updated = { ...row, disconnectedAt: new Date('2026-02-01T00:00:00Z') };
    this.rows.set(id, updated);
    return updated;
  }

  async getById(workspaceId: string, id: string): Promise<CiInstallationRow | undefined> {
    const row = this.rows.get(id);
    return row && row.workspaceId === workspaceId ? row : undefined;
  }
}

class FakeRunsRepo {
  // Filter-aware signature (mirrors the real `RunsRepository.list`) so tests
  // can override `list` with a function that branches on `sinceDays` being
  // passed or not — the default body still ignores its args and returns [].
  async list(_workspaceId: string, _filters: CiRunsListFilters = {}) {
    return [];
  }
  async getLastCheckedAt() {
    return null;
  }
  async setLastCheckedAt() {
    // no-op
  }
  async upsertByGithubRunId(): Promise<never> {
    throw new Error('not used by ExportService');
  }
}

interface MakeContainerOpts {
  github?: MockGitHubClient;
  runnerBundler?: MockRunnerBundler;
  agent?: AgentRow | null;
  skills?: { skill: { name: string; body: string; enabled: boolean }; order: number }[];
  secretValue?: string | undefined;
  repoRow?: { id: string; fullName: string } | null;
}

/** Fake db that answers ONLY `ExportService.getRepoRow`'s exact chain shape. */
function makeFakeDb(repoRow: { id: string; fullName: string } | null) {
  return {
    select: (_cols?: unknown) => ({
      from: (_table: unknown) => ({
        where: (_cond: unknown) => {
          const rows = repoRow ? [repoRow] : [];
          const promise = Promise.resolve(rows) as Promise<unknown[]> & {
            limit: (n: number) => Promise<unknown[]>;
          };
          promise.limit = () => Promise.resolve(rows);
          return promise;
        },
      }),
    }),
  };
}

function makeContainer(opts: MakeContainerOpts = {}): Container {
  const github = opts.github ?? new MockGitHubClient();
  const runnerBundler = opts.runnerBundler ?? new MockRunnerBundler();
  const agent = 'agent' in opts ? opts.agent : makeAgentRow();
  const skills = opts.skills ?? [];
  const repoRow = 'repoRow' in opts ? opts.repoRow : { id: REPO_ID, fullName: REPO_FULL_NAME };
  const secretValue = 'secretValue' in opts ? opts.secretValue : 'sk-or-test-key';

  return {
    db: makeFakeDb(repoRow ?? null),
    secrets: {
      get: async (key: string) => (key === 'OPENROUTER_API_KEY' ? secretValue : undefined),
    },
    github: async () => github,
    runnerBundler,
    agentsRepo: {
      getById: async () => agent ?? undefined,
      linkedSkills: async () => skills,
    },
  } as unknown as Container;
}

function makeService(
  container: Container,
  installationsRepo: FakeInstallationsRepo = new FakeInstallationsRepo(),
  runsRepo: FakeRunsRepo = new FakeRunsRepo(),
): { service: ExportService; installationsRepo: FakeInstallationsRepo } {
  const service = new ExportService(
    container,
    installationsRepo as unknown as InstallationsRepository,
    runsRepo as unknown as RunsRepository,
  );
  return { service, installationsRepo };
}

const EXPORT_INPUT: CiExportInput = {
  repo: REPO_FULL_NAME,
  target: 'gha',
  action: 'open_pr',
  post_as: 'github_review',
  triggers: ['opened', 'synchronize'],
  base: 'main',
  workflow_override: null,
};

const PREVIEW_INPUT: CiExportPreviewInput = {
  triggers: ['opened', 'synchronize'],
  post_as: 'github_review',
};

describe('ExportService.exportInstallation — open_pr call order + persistence timing', () => {
  it('calls commitFiles, then findOpenPr, then openPullRequest, and only calls upsertPublished after they succeed', async () => {
    const callOrder: string[] = [];
    const github = new MockGitHubClient();
    const originalCommit = github.commitFiles.bind(github);
    github.commitFiles = async (...args: Parameters<typeof originalCommit>) => {
      callOrder.push('commitFiles');
      return originalCommit(...args);
    };
    const originalFindOpenPr = github.findOpenPr.bind(github);
    github.findOpenPr = async (...args: Parameters<typeof originalFindOpenPr>) => {
      callOrder.push('findOpenPr');
      return originalFindOpenPr(...args);
    };
    const originalOpenPr = github.openPullRequest.bind(github);
    github.openPullRequest = async (...args: Parameters<typeof originalOpenPr>) => {
      callOrder.push('openPullRequest');
      return originalOpenPr(...args);
    };

    const installationsRepo = new FakeInstallationsRepo();
    const originalUpsert = installationsRepo.upsertPublished.bind(installationsRepo);
    installationsRepo.upsertPublished = async (...args: Parameters<typeof originalUpsert>) => {
      callOrder.push('upsertPublished');
      return originalUpsert(...args);
    };

    const container = makeContainer({ github });
    const { service } = makeService(container, installationsRepo);

    const result = await service.exportInstallation(WS_ID, REPO_ID, AGENT_ID, EXPORT_INPUT);

    expect(callOrder).toEqual(['commitFiles', 'findOpenPr', 'openPullRequest', 'upsertPublished']);
    expect(result.installation.workflow_version).toBe(1);
    expect(result.pr_url).toBe('https://github.com/mock/mock/pull/1');
    // The OpenRouter secret must NEVER be echoed back in the export result.
    expect(Object.prototype.hasOwnProperty.call(result, 'secret_value')).toBe(false);
  });

  it('a GitHub client that throws on commitFiles results in NO upsertPublished call', async () => {
    const github = new MockGitHubClient();
    github.commitFiles = async () => {
      throw new Error('network down');
    };
    const container = makeContainer({ github });
    const { service, installationsRepo } = makeService(container);

    await expect(
      service.exportInstallation(WS_ID, REPO_ID, AGENT_ID, EXPORT_INPUT),
    ).rejects.toThrow('network down');

    expect(installationsRepo.upsertCalls).toHaveLength(0);
    expect(installationsRepo.rows.size).toBe(0);
  });
});

describe('ExportService.exportInstallation — repo identity is server-derived, never client-supplied (AC-1)', () => {
  it('uses repoRow.fullName — not a mismatched input.repo — for every GitHub call and the persisted/returned installation', async () => {
    const CONNECTED_FULL_NAME = 'acme/actually-connected-repo';
    const MISMATCHED_INPUT_REPO = 'attacker/unconnected-repo';

    const capturedRepoRefs: { owner: string; name: string }[] = [];
    const github = new MockGitHubClient();
    const originalCommit = github.commitFiles.bind(github);
    github.commitFiles = async (...args: Parameters<typeof originalCommit>) => {
      capturedRepoRefs.push(args[0]);
      return originalCommit(...args);
    };
    const originalFindOpenPr = github.findOpenPr.bind(github);
    github.findOpenPr = async (...args: Parameters<typeof originalFindOpenPr>) => {
      capturedRepoRefs.push(args[0]);
      return originalFindOpenPr(...args);
    };
    const originalOpenPr = github.openPullRequest.bind(github);
    github.openPullRequest = async (...args: Parameters<typeof originalOpenPr>) => {
      capturedRepoRefs.push(args[0]);
      return originalOpenPr(...args);
    };

    // `repoRow.fullName` (what `repoId` actually resolves to in this
    // workspace) deliberately DIFFERS from `input.repo` (an arbitrary
    // client-supplied body field) — this is exactly the attack shape AC-1
    // guards against: a caller passing a valid `repoId` for one connected
    // repo but naming a different, possibly-unconnected repo string in the
    // body.
    const container = makeContainer({
      github,
      repoRow: { id: REPO_ID, fullName: CONNECTED_FULL_NAME },
    });
    const { service, installationsRepo } = makeService(container);
    const mismatchedInput: CiExportInput = { ...EXPORT_INPUT, repo: MISMATCHED_INPUT_REPO };

    const result = await service.exportInstallation(WS_ID, REPO_ID, AGENT_ID, mismatchedInput);

    expect(capturedRepoRefs.length).toBeGreaterThan(0);
    for (const ref of capturedRepoRefs) {
      expect(ref).toEqual({ owner: 'acme', name: 'actually-connected-repo' });
    }

    expect(result.installation.repo).toBe(CONNECTED_FULL_NAME);
    expect(installationsRepo.upsertCalls).toHaveLength(1);
    expect(installationsRepo.upsertCalls[0]!.values.repo).toBe(CONNECTED_FULL_NAME);
  });
});

describe('ExportService.exportInstallation — slug/id freeze across re-export (AC-4/AC-5/AC-45)', () => {
  it('reuses the same installation id/slug and bumps workflow_version by exactly 1 per call, even after an agent rename', async () => {
    const agent = makeAgentRow({ name: 'Security Reviewer' });
    const container = makeContainer({ agent });
    const { service } = makeService(container);

    const first = await service.exportInstallation(WS_ID, REPO_ID, AGENT_ID, EXPORT_INPUT);
    expect(first.installation.workflow_version).toBe(1);

    // Simulate the agent being renamed between the two exports.
    agent.name = 'Renamed Reviewer';

    const second = await service.exportInstallation(WS_ID, REPO_ID, AGENT_ID, EXPORT_INPUT);

    expect(second.installation.id).toBe(first.installation.id);
    expect(second.installation.slug).toBe(first.installation.slug);
    expect(second.installation.workflow_version).toBe(2);
  });
});

describe('ExportService — one-agent-per-repo conflict (AC-13 re-scoped)', () => {
  it('exportInstallation for a different agent against an already-installed repo throws a 409 AppError and makes no upsertPublished call', async () => {
    const firstAgent = makeAgentRow({ id: AGENT_ID, name: 'Security Reviewer' });
    const container1 = makeContainer({ agent: firstAgent });
    const installationsRepo = new FakeInstallationsRepo();
    const { service: service1 } = makeService(container1, installationsRepo);
    await service1.exportInstallation(WS_ID, REPO_ID, AGENT_ID, EXPORT_INPUT);
    expect(installationsRepo.rows.size).toBe(1);

    const OTHER_AGENT_ID = '44444444-4444-4444-4444-444444444444';
    const otherAgent = makeAgentRow({ id: OTHER_AGENT_ID, name: 'Style Reviewer' });
    const container2 = makeContainer({ agent: otherAgent });
    const { service: service2 } = makeService(container2, installationsRepo);

    await expect(
      service2.exportInstallation(WS_ID, REPO_ID, OTHER_AGENT_ID, EXPORT_INPUT),
    ).rejects.toBeInstanceOf(AppError);

    try {
      await service2.exportInstallation(WS_ID, REPO_ID, OTHER_AGENT_ID, EXPORT_INPUT);
    } catch (err) {
      expect((err as AppError).statusCode).toBe(409);
      expect((err as AppError).code).toBe('repo_already_installed');
      // The message now names the repository (and the conflicting agent) so the
      // user knows exactly where the conflict is — not just "a different agent".
      expect((err as AppError).message).toContain(REPO_FULL_NAME);
      expect((err as AppError).message).toMatch(/already has DevDigest installed/);
    }

    // Still exactly the one row from the first (successful) export.
    expect(installationsRepo.rows.size).toBe(1);
    // The two rejected attempts against the conflicting repo must not have
    // added any upsertPublished call beyond the first (successful) export's
    // single call — direct coverage that a conflict never reaches the
    // persisting write.
    expect(installationsRepo.upsertCalls).toHaveLength(1);
  });

  it('previewFiles for a different agent against an already-installed repo throws a 409 AppError', async () => {
    const firstAgent = makeAgentRow({ id: AGENT_ID, name: 'Security Reviewer' });
    const installationsRepo = new FakeInstallationsRepo();
    const container1 = makeContainer({ agent: firstAgent });
    const { service: service1 } = makeService(container1, installationsRepo);
    await service1.exportInstallation(WS_ID, REPO_ID, AGENT_ID, EXPORT_INPUT);

    const OTHER_AGENT_ID = '55555555-5555-5555-5555-555555555555';
    const otherAgent = makeAgentRow({ id: OTHER_AGENT_ID, name: 'Style Reviewer' });
    const container2 = makeContainer({ agent: otherAgent });
    const { service: service2 } = makeService(container2, installationsRepo);

    await expect(
      service2.previewFiles(WS_ID, REPO_ID, OTHER_AGENT_ID, PREVIEW_INPUT),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('exports the SAME agent to two different repos successfully — one agent, many repos still works (AC-13 re-scoped)', async () => {
    // Reference scenario from the plan (§1 design decision #1): Security
    // Reviewer -> payments-api + billing-worker, two independent installations.
    const agent = makeAgentRow({ id: AGENT_ID, name: 'Security Reviewer' });
    const installationsRepo = new FakeInstallationsRepo();

    const REPO_ID_B = '66666666-6666-6666-6666-666666666666';
    const REPO_FULL_NAME_B = 'acme/billing-worker';

    const containerA = makeContainer({ agent, repoRow: { id: REPO_ID, fullName: REPO_FULL_NAME } });
    const { service: serviceA } = makeService(containerA, installationsRepo);
    const resultA = await serviceA.exportInstallation(WS_ID, REPO_ID, AGENT_ID, EXPORT_INPUT);

    const containerB = makeContainer({
      agent,
      repoRow: { id: REPO_ID_B, fullName: REPO_FULL_NAME_B },
    });
    const { service: serviceB } = makeService(containerB, installationsRepo);
    const inputB: CiExportInput = { ...EXPORT_INPUT, repo: REPO_FULL_NAME_B };
    const resultB = await serviceB.exportInstallation(WS_ID, REPO_ID_B, AGENT_ID, inputB);

    expect(resultA.installation.id).not.toBe(resultB.installation.id);
    expect(resultA.installation.repo).toBe(REPO_FULL_NAME);
    expect(resultB.installation.repo).toBe(REPO_FULL_NAME_B);
    expect(installationsRepo.rows.size).toBe(2);
    expect(installationsRepo.upsertCalls).toHaveLength(2);
  });
});

describe('ExportService.exportInstallation — a disconnected installation is a fully free slot (Bug 2 takeover)', () => {
  it('a different agent can claim a repo whose only installation is disconnected — no 409, and the slug is FRESH, not inherited', async () => {
    const firstAgent = makeAgentRow({ id: AGENT_ID, name: 'Security Reviewer' });
    const installationsRepo = new FakeInstallationsRepo();
    const container1 = makeContainer({ agent: firstAgent });
    const { service: service1 } = makeService(container1, installationsRepo);
    const firstExport = await service1.exportInstallation(WS_ID, REPO_ID, AGENT_ID, EXPORT_INPUT);

    await installationsRepo.disconnect(WS_ID, firstExport.installation.id);

    const OTHER_AGENT_ID = '77777777-7777-7777-7777-777777777777';
    const otherAgent = makeAgentRow({ id: OTHER_AGENT_ID, name: 'Style Reviewer' });
    const container2 = makeContainer({ agent: otherAgent });
    const { service: service2 } = makeService(container2, installationsRepo);

    // No throw — a disconnected installation no longer blocks a different agent.
    const takeover = await service2.exportInstallation(WS_ID, REPO_ID, OTHER_AGENT_ID, EXPORT_INPUT);

    expect(takeover.installation.agent_id).toBe(OTHER_AGENT_ID);
    expect(takeover.installation.slug).not.toBe(firstExport.installation.slug);
    expect(takeover.installation.disconnected_at).toBeNull();
    // Same row reused (one-row-per-repo invariant) — never a second
    // installation for this repo.
    expect(takeover.installation.id).toBe(firstExport.installation.id);
    expect(installationsRepo.rows.size).toBe(1);
  });

  it('a different agent against an ACTIVE (non-disconnected) installation still 409s — must not regress', async () => {
    const firstAgent = makeAgentRow({ id: AGENT_ID, name: 'Security Reviewer' });
    const installationsRepo = new FakeInstallationsRepo();
    const container1 = makeContainer({ agent: firstAgent });
    const { service: service1 } = makeService(container1, installationsRepo);
    await service1.exportInstallation(WS_ID, REPO_ID, AGENT_ID, EXPORT_INPUT);
    // No disconnect() — the installation stays ACTIVE.

    const OTHER_AGENT_ID = '77777777-7777-7777-7777-777777777777';
    const otherAgent = makeAgentRow({ id: OTHER_AGENT_ID, name: 'Style Reviewer' });
    const container2 = makeContainer({ agent: otherAgent });
    const { service: service2 } = makeService(container2, installationsRepo);

    await expect(
      service2.exportInstallation(WS_ID, REPO_ID, OTHER_AGENT_ID, EXPORT_INPUT),
    ).rejects.toMatchObject({ statusCode: 409, code: 'repo_already_installed' });
    expect(installationsRepo.rows.size).toBe(1);
  });
});

describe('ExportService.exportInstallation — empty-slug fallback for non-ASCII-alnum agent names (Bug 6)', () => {
  it('falls back to agent-<id-prefix> when the agent name slugifies to an empty string', async () => {
    const weirdAgent = makeAgentRow({ name: '★★★' });
    const container = makeContainer({ agent: weirdAgent });
    const { service } = makeService(container);

    const result = await service.exportInstallation(WS_ID, REPO_ID, AGENT_ID, EXPORT_INPUT);

    expect(result.installation.slug).not.toBe('');
    expect(result.installation.slug).toBe(`agent-${AGENT_ID.slice(0, 8)}`);
  });

  it('applies the same fallback for a takeover slug (a different agent, disconnected slot, non-ASCII-alnum name)', async () => {
    const firstAgent = makeAgentRow({ id: AGENT_ID, name: 'Security Reviewer' });
    const installationsRepo = new FakeInstallationsRepo();
    const container1 = makeContainer({ agent: firstAgent });
    const { service: service1 } = makeService(container1, installationsRepo);
    const firstExport = await service1.exportInstallation(WS_ID, REPO_ID, AGENT_ID, EXPORT_INPUT);
    await installationsRepo.disconnect(WS_ID, firstExport.installation.id);

    const OTHER_AGENT_ID = '99999999-9999-9999-9999-999999999999';
    const weirdAgent = makeAgentRow({ id: OTHER_AGENT_ID, name: '日本語' });
    const container2 = makeContainer({ agent: weirdAgent });
    const { service: service2 } = makeService(container2, installationsRepo);

    const takeover = await service2.exportInstallation(WS_ID, REPO_ID, OTHER_AGENT_ID, EXPORT_INPUT);

    expect(takeover.installation.slug).not.toBe('');
    expect(takeover.installation.slug).toBe(`agent-${OTHER_AGENT_ID.slice(0, 8)}`);
  });
});

describe('ExportService.previewFiles — no side effects', () => {
  it('makes no GitHub call and no DB write', async () => {
    const github = new MockGitHubClient();
    const container = makeContainer({ github });
    const { service, installationsRepo } = makeService(container);

    const result = await service.previewFiles(WS_ID, REPO_ID, AGENT_ID, PREVIEW_INPUT);

    expect(result.files.length).toBeGreaterThan(0);
    expect(github.committed).toHaveLength(0);
    expect(github.openedPrs).toHaveLength(0);
    expect(installationsRepo.upsertCalls).toHaveLength(0);
  });

  it('throws NotFoundError for a repo absent from this workspace', async () => {
    const container = makeContainer({ repoRow: null });
    const { service } = makeService(container);
    await expect(
      service.previewFiles(WS_ID, REPO_ID, AGENT_ID, PREVIEW_INPUT),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws NotFoundError for an agent absent from this workspace', async () => {
    const container = makeContainer({ agent: null });
    const { service } = makeService(container);
    await expect(
      service.previewFiles(WS_ID, REPO_ID, AGENT_ID, PREVIEW_INPUT),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('ExportService.bulkUpdate', () => {
  it('opens a PR for each successful installation so the update lands; one failing to commitFiles still returns a full 2-entry results array with the other ok:true', async () => {
    const agent = makeAgentRow();
    const github = new MockGitHubClient();
    let commitCall = 0;
    const originalCommit = github.commitFiles.bind(github);
    github.commitFiles = async (...args: Parameters<typeof originalCommit>) => {
      commitCall += 1;
      if (commitCall === 1) throw new Error('rate limited');
      return originalCommit(...args);
    };
    let openPrCalls = 0;
    const originalOpenPr = github.openPullRequest.bind(github);
    github.openPullRequest = async (...args: Parameters<typeof originalOpenPr>) => {
      openPrCalls += 1;
      return originalOpenPr(...args);
    };

    const installationsRepo = new FakeInstallationsRepo();
    // Two pre-existing, non-disconnected installations for the same agent.
    await installationsRepo.upsertPublished(WS_ID, 'inst-a', {
      agentId: AGENT_ID,
      repo: 'acme/repo-a',
      targetType: 'gha',
      slug: 'security-reviewer',
      triggers: ['opened'],
      postAs: 'github_review',
      workflowContents: 'name: DevDigest Review A',
    });
    await installationsRepo.upsertPublished(WS_ID, 'inst-b', {
      agentId: AGENT_ID,
      repo: 'acme/repo-b',
      targetType: 'gha',
      slug: 'security-reviewer',
      triggers: ['opened'],
      postAs: 'github_review',
      workflowContents: 'name: DevDigest Review B',
    });
    installationsRepo.upsertCalls = []; // reset — only bulkUpdate's own calls matter below

    const container = makeContainer({ github, agent });
    const { service } = makeService(container, installationsRepo);

    const result = await service.bulkUpdate(WS_ID, AGENT_ID);

    expect(result.results).toHaveLength(2);
    const ok = result.results.filter((r) => r.ok);
    const failed = result.results.filter((r) => !r.ok);
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.error).toContain('rate limited');
    expect(failed[0]!.pr_url).toBeNull();
    // The one that committed successfully now LANDS via a PR (deliberate AC-40
    // deviation) so a merged prior export PR no longer strands the update.
    expect(ok[0]!.pr_url).toBe('https://github.com/mock/mock/pull/1');
    // A PR is opened only for the successful installation, never the failed one.
    expect(openPrCalls).toBe(1);
    // Only the successful installation's row got a fresh upsertPublished call.
    expect(installationsRepo.upsertCalls).toHaveLength(1);
  });

  it('reuses an already-open export PR instead of opening a second one (AC-10)', async () => {
    const agent = makeAgentRow();
    const github = new MockGitHubClient();
    // Simulate the original export PR still being open on the CI branch.
    github.openedPrs.push({ title: 'export', head: 'devdigest/ci', base: 'main', body: 'export' });
    let openPrCalls = 0;
    const originalOpenPr = github.openPullRequest.bind(github);
    github.openPullRequest = async (...args: Parameters<typeof originalOpenPr>) => {
      openPrCalls += 1;
      return originalOpenPr(...args);
    };

    const installationsRepo = new FakeInstallationsRepo();
    await installationsRepo.upsertPublished(WS_ID, 'inst-a', {
      agentId: AGENT_ID,
      repo: 'acme/repo-a',
      targetType: 'gha',
      slug: 'security-reviewer',
      triggers: ['opened'],
      postAs: 'github_review',
      workflowContents: 'name: DevDigest Review A',
    });

    const container = makeContainer({ agent, github });
    const { service } = makeService(container, installationsRepo);

    const result = await service.bulkUpdate(WS_ID, AGENT_ID);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.ok).toBe(true);
    // Reuses the existing open PR — never stacks a second one.
    expect(result.results[0]!.pr_url).toBe('https://github.com/mock/mock/pull/1');
    expect(openPrCalls).toBe(0);
  });

  it('excludes disconnected installations entirely from the results array, and never builds the runner bundle for a zero-active batch (Bug 3)', async () => {
    const agent = makeAgentRow();
    const installationsRepo = new FakeInstallationsRepo();
    await installationsRepo.upsertPublished(WS_ID, 'inst-a', {
      agentId: AGENT_ID,
      repo: 'acme/repo-a',
      targetType: 'gha',
      slug: 'security-reviewer',
      triggers: ['opened'],
      postAs: 'github_review',
      workflowContents: 'name: DevDigest Review A',
    });
    await installationsRepo.disconnect(WS_ID, 'inst-a');

    const runnerBundler = new MockRunnerBundler();
    const container = makeContainer({ agent, runnerBundler });
    const { service } = makeService(container, installationsRepo);

    const result = await service.bulkUpdate(WS_ID, AGENT_ID);
    expect(result.results).toHaveLength(0);
    // The bundle build (and, by extension, GitHub client construction) is
    // wasted work for a batch with zero active installations — must never run.
    expect(runnerBundler.buildCalls).toBe(0);
  });

  it('resolves the REAL default branch per installation via getDefaultBranch — never a hardcoded "main" (Bug 4)', async () => {
    const agent = makeAgentRow();
    const github = new MockGitHubClient({ defaultBranch: 'master' });
    const installationsRepo = new FakeInstallationsRepo();
    await installationsRepo.upsertPublished(WS_ID, 'inst-a', {
      agentId: AGENT_ID,
      repo: 'acme/repo-a',
      targetType: 'gha',
      slug: 'security-reviewer',
      triggers: ['opened'],
      postAs: 'github_review',
      workflowContents: 'name: DevDigest Review A',
    });

    const container = makeContainer({ agent, github });
    const { service } = makeService(container, installationsRepo);

    const result = await service.bulkUpdate(WS_ID, AGENT_ID);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.ok).toBe(true);
    expect(github.committed).toHaveLength(1);
    expect(github.committed[0]!.base).toBe('master');
    expect(github.gotDefaultBranches).toEqual([{ owner: 'acme', name: 'repo-a' }]);
  });
});

describe('ExportService.disconnect', () => {
  it('throws NotFoundError when no matching installation exists', async () => {
    const container = makeContainer();
    const { service } = makeService(container);
    await expect(service.disconnect(WS_ID, 'missing-id')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('returns the disconnected installation DTO', async () => {
    const installationsRepo = new FakeInstallationsRepo();
    await installationsRepo.upsertPublished(WS_ID, 'inst-a', {
      agentId: AGENT_ID,
      repo: REPO_FULL_NAME,
      targetType: 'gha',
      slug: 'security-reviewer',
      triggers: ['opened'],
      postAs: 'github_review',
      workflowContents: 'name: DevDigest Review',
    });
    const container = makeContainer();
    const { service } = makeService(container, installationsRepo);

    const result = await service.disconnect(WS_ID, 'inst-a');
    expect(result.installation.disconnected_at).not.toBeNull();
  });
});

describe('ExportService.getAgentCiSurface', () => {
  it('active_count counts only non-disconnected installations, and the 7-day rollup aggregates runs', async () => {
    const installationsRepo = new FakeInstallationsRepo();
    await installationsRepo.upsertPublished(WS_ID, 'inst-a', {
      agentId: AGENT_ID,
      repo: 'acme/repo-a',
      targetType: 'gha',
      slug: 'security-reviewer',
      triggers: ['opened'],
      postAs: 'github_review',
      workflowContents: 'name: DevDigest Review A',
    });
    await installationsRepo.upsertPublished(WS_ID, 'inst-b', {
      agentId: AGENT_ID,
      repo: 'acme/repo-b',
      targetType: 'gha',
      slug: 'security-reviewer',
      triggers: ['opened'],
      postAs: 'github_review',
      workflowContents: 'name: DevDigest Review B',
    });
    await installationsRepo.disconnect(WS_ID, 'inst-b');

    const runsRepo = new FakeRunsRepo();
    runsRepo.list = async () => [
      {
        id: 'run-1',
        ciInstallationId: 'inst-a',
        prNumber: 12,
        ranAt: new Date('2026-07-09T00:00:00Z'),
        status: 'succeeded',
        findingsCount: 3,
        costUsd: 0.05,
        githubUrl: 'https://github.com/acme/repo-a/actions/runs/1',
        source: 'ci',
        workspaceId: WS_ID,
        githubRunId: '1',
        repo: 'acme/repo-a',
        agent: 'Security Reviewer',
        durationS: 30,
        critical: 0,
        warning: 1,
        suggestion: 2,
      },
      {
        id: 'run-2',
        ciInstallationId: 'inst-a',
        prNumber: 13,
        ranAt: new Date('2026-07-10T00:00:00Z'),
        status: 'failed',
        findingsCount: 1,
        costUsd: 0.02,
        githubUrl: 'https://github.com/acme/repo-a/actions/runs/2',
        source: 'ci',
        workspaceId: WS_ID,
        githubRunId: '2',
        repo: 'acme/repo-a',
        agent: 'Security Reviewer',
        durationS: 20,
        critical: 1,
        warning: 0,
        suggestion: 0,
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any;

    const container = makeContainer();
    const { service } = makeService(container, installationsRepo, runsRepo);

    const surface = await service.getAgentCiSurface(WS_ID, AGENT_ID);

    expect(surface.active_count).toBe(1);
    expect(surface.installations).toHaveLength(2);
    expect(surface.last_7_days.runs).toBe(2);
    expect(surface.last_7_days.findings).toBe(4);
    expect(surface.last_7_days.cost_usd).toBeCloseTo(0.07);

    const instA = surface.installations.find((i) => i.id === 'inst-a')!;
    // run-2 has the later ran_at — its status ('failed') wins as latest_run_status.
    expect(instA.latest_run_status).toBe('failed');

    const instB = surface.installations.find((i) => i.id === 'inst-b')!;
    expect(instB.latest_run_status).toBeNull();
    expect(instB.disconnected_at).not.toBeNull();
  });
});

describe('ExportService.getAgentCiSurface — latest_run_status is not limited to the 7-day rollup window (Bug 5)', () => {
  it('reflects an installation whose only run is older than 7 days, while last_7_days.runs stays 0', async () => {
    const installationsRepo = new FakeInstallationsRepo();
    await installationsRepo.upsertPublished(WS_ID, 'inst-a', {
      agentId: AGENT_ID,
      repo: 'acme/repo-a',
      targetType: 'gha',
      slug: 'security-reviewer',
      triggers: ['opened'],
      postAs: 'github_review',
      workflowContents: 'name: DevDigest Review A',
    });

    const oldRun = {
      id: 'run-old',
      ciInstallationId: 'inst-a',
      prNumber: 9,
      ranAt: new Date('2026-06-01T00:00:00Z'), // well over 7 days before "now"
      status: 'succeeded',
      findingsCount: 2,
      costUsd: 0.01,
      githubUrl: 'https://github.com/acme/repo-a/actions/runs/9',
      source: 'ci',
      workspaceId: WS_ID,
      githubRunId: '9',
      repo: 'acme/repo-a',
      agent: 'Security Reviewer',
      durationS: 15,
      critical: 0,
      warning: 0,
      suggestion: 2,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // The fake must be filter-aware for this test to actually exercise the
    // fix: the windowed call (sinceDays present) sees no runs, the unwindowed
    // call (sinceDays absent) sees the old run.
    const runsRepo = new FakeRunsRepo();
    runsRepo.list = async (_workspaceId: string, filters: CiRunsListFilters = {}) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (filters.sinceDays != null ? [] : [oldRun]) as any;

    const container = makeContainer();
    const { service } = makeService(container, installationsRepo, runsRepo);

    const surface = await service.getAgentCiSurface(WS_ID, AGENT_ID);

    expect(surface.last_7_days.runs).toBe(0);
    const instA = surface.installations.find((i) => i.id === 'inst-a')!;
    expect(instA.latest_run_status).toBe('succeeded');
  });
});
