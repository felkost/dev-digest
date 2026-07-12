/**
 * Hermetic tests for `ReviewRunExecutor.executeRunsConcurrent` (Multi-Agent
 * Review, plan Step 4) — the bounded-concurrency worker-pool entry point,
 * distinct from the sequential `executeRuns` used by single-agent/`all:true`/
 * `review-all`.
 *
 * No Postgres, no Docker. `ReviewRepository` and `Container['agentsRepo']` are
 * hand-rolled `vi.fn()` stubs (constructor-injected, per `run-executor.ts`);
 * `container.git`/`llm` mirror `test/run-executor-context-docs.test.ts`'s
 * fixture conventions.
 *
 * Covers (per plan Step 4 verify checklist):
 *  - executeRunsConcurrent calls into all jobs (every job's completeAgentRun fires)
 *  - one job's induced failure (unresolvable LLM provider) does not prevent the
 *    other jobs from completing successfully
 *  - `runBus.complete` fires for every job, including the failed one
 */
import { describe, it, expect, vi } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { ReviewRunExecutor } from '../src/modules/reviews/run-executor.js';
import { MockLLMProvider, MockGitClient } from '../src/adapters/mocks.js';
import { RunBus } from '../src/platform/sse.js';
import type { Container } from '../src/platform/container.js';
import { ContextDocsService } from '../src/modules/context-docs/service.js';
import type { ReviewRepository, PullRow } from '../src/modules/reviews/repository.js';
import { MULTI_AGENT_CONCURRENCY_CAP } from '../src/modules/reviews/constants.js';
import type {
  RunTrace,
  LLMProvider,
  ModelInfo,
  CompletionRequest,
  CompletionResult,
  StructuredRequest,
  StructuredResult,
} from '@devdigest/shared';
import type { AgentRow } from '../src/db/rows.js';
import * as schema from '../src/db/schema.js';

const WS_ID = '11111111-1111-1111-1111-111111111111';
const REPO_ID = '22222222-2222-2222-2222-222222222222';
const PR_ID = '33333333-3333-3333-3333-333333333333';

const REPO_ROW = {
  id: REPO_ID,
  workspaceId: WS_ID,
  owner: 'acme',
  name: 'api',
  fullName: 'acme/api',
  defaultBranch: 'main',
  clonePath: '/mock/clones/acme/api',
  lastPolledAt: null,
  createdBy: null,
  createdAt: new Date('2026-01-01'),
  contextFolders: null,
} as unknown as typeof schema.repos.$inferSelect;

const PULL_ROW: PullRow = {
  id: PR_ID,
  workspaceId: WS_ID,
  repoId: REPO_ID,
  number: 100,
  title: 'Multi-agent test PR',
  author: 'marisa.koch',
  branch: 'feat/multi',
  base: 'main',
  headSha: 'a1b2c3d4',
  lastReviewedSha: null,
  additions: 4,
  deletions: 0,
  filesCount: 1,
  status: 'needs_review',
  body: null,
  openedAt: null,
  updatedAt: null,
} as unknown as PullRow;

function makeAgent(id: string, name: string, provider: 'openai' | 'anthropic'): AgentRow {
  return {
    id,
    workspaceId: WS_ID,
    name,
    description: '',
    provider,
    model: provider === 'openai' ? 'gpt-4.1' : 'claude-sonnet',
    systemPrompt: 'You review PRs.',
    outputSchema: null,
    strategy: 'single-pass',
    ciFailOn: 'critical',
    // repoIntel off — irrelevant here, avoids mocking container.repoIntel.
    repoIntel: false,
    enabled: true,
    version: 1,
    createdBy: null,
    createdAt: new Date('2026-01-01'),
  } as unknown as AgentRow;
}

const AGENT_A = makeAgent('44444444-4444-4444-4444-444444444444', 'Agent A', 'openai');
const AGENT_B = makeAgent('55555555-5555-5555-5555-555555555555', 'Agent B', 'openai');
// Provider deliberately made unresolvable below to induce a failure for this job.
const AGENT_C_FAILING = makeAgent('66666666-6666-6666-6666-666666666666', 'Agent C (fails)', 'anthropic');

const RUN_ID_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const RUN_ID_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const RUN_ID_C = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

/** Minimal call-counted fake db satisfying ONLY ContextDocsRepository's queries
 *  (agent/skill attachments + repo context-folders lookup) — mirrors
 *  `test/run-executor-context-docs.test.ts`'s `makeDb` helper, no attachments. */
function makeDb() {
  function tableNameOf(table: unknown): string {
    try {
      return getTableName(table as Parameters<typeof getTableName>[0]);
    } catch {
      return '';
    }
  }
  function makeChain(resolve: () => Record<string, unknown>[]): Record<string, unknown> {
    const chain: Record<string, unknown> = {
      where: () => chain,
      orderBy: () => chain,
      limit: () => Promise.resolve(resolve()),
      then: (onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(resolve()).then(onF, onR),
      catch: (onR?: (e: unknown) => unknown) => Promise.resolve(resolve()).catch(onR),
    };
    return chain;
  }
  return {
    select: (columns?: Record<string, unknown>) => ({
      from: (table: unknown) => {
        const tableName = tableNameOf(table);
        return makeChain(() => {
          if (columns && ('clonePath' in columns || 'contextFolders' in columns)) {
            return [
              {
                clonePath: REPO_ROW.clonePath,
                owner: REPO_ROW.owner,
                name: REPO_ROW.name,
                contextFolders: null,
              },
            ];
          }
          if (tableName === 'agent_context_docs') return [];
          if (tableName === 'skill_context_docs') return [];
          return [];
        });
      },
    }),
  };
}

/** Minimal ReviewRepository stub — records completeAgentRun status per runId. */
function makeReviewRepo() {
  const completedByRun = new Map<string, { status: string }>();
  const savedTraces: RunTrace[] = [];
  const repo = {
    getIntent: vi.fn().mockResolvedValue(undefined),
    upsertIntent: vi.fn().mockResolvedValue(undefined),
    getPrFiles: vi.fn().mockResolvedValue([]),
    insertReview: vi.fn().mockImplementation(async (values: { runId: string | null }) => ({
      id: `review-${values.runId}`,
      workspaceId: WS_ID,
      prId: PR_ID,
      agentId: null,
      runId: values.runId,
      kind: 'review',
      verdict: 'comment',
      summary: 'ok',
      score: 95,
      model: 'gpt-4.1',
      createdAt: new Date(),
    })),
    insertFindings: vi.fn().mockResolvedValue([]),
    markReviewed: vi.fn().mockResolvedValue(undefined),
    completeAgentRun: vi.fn().mockImplementation(async (runId: string, values: { status: string }) => {
      completedByRun.set(runId, values);
    }),
    saveRunTrace: vi.fn().mockImplementation(async (_runId: string, trace: RunTrace) => {
      savedTraces.push(trace);
    }),
    upsertBrief: vi.fn().mockRejectedValue(new Error('brief composition not exercised in this test')),
    __completedByRun: completedByRun,
    __savedTraces: savedTraces,
  };
  return repo as unknown as ReviewRepository & {
    __completedByRun: Map<string, { status: string }>;
    __savedTraces: RunTrace[];
  };
}

function makeAgentsRepo() {
  return { linkedSkills: vi.fn().mockResolvedValue([]) } as unknown as Container['agentsRepo'];
}

/** Container whose `llm()` resolver THROWS for 'anthropic' — the induced,
 *  isolated per-job failure — but resolves normally for 'openai'. */
function makeContainer(): { container: Container; completeSpy: ReturnType<typeof vi.fn> } {
  const gitClient = new MockGitClient({});
  const openaiLlm = new MockLLMProvider('openai', {
    structured: { verdict: 'comment', summary: 'Looks fine.', score: 95, findings: [] },
  });

  const runBus = new RunBus();
  const completeSpy = vi.spyOn(runBus, 'complete');

  const container = {
    db: makeDb(),
    git: gitClient,
    tokenizer: { count: (text: string) => text.split(/\s+/).filter(Boolean).length },
    llm: async (provider: 'openai' | 'anthropic' | 'openrouter') => {
      if (provider === 'anthropic') throw new Error('anthropic unavailable (induced failure)');
      return openaiLlm;
    },
    runBus,
    blast: { getBlast: vi.fn().mockRejectedValue(new Error('blast not exercised')) },
  } as unknown as Container;
  (container as unknown as { contextDocs: ContextDocsService }).contextDocs = new ContextDocsService(container);

  return { container, completeSpy };
}

/**
 * A delayed LLM wrapper that also tracks the PEAK number of concurrently
 * in-flight `completeStructured` calls — used to prove the worker pool never
 * exceeds `MULTI_AGENT_CONCURRENCY_CAP` jobs running at once (not merely that
 * all jobs eventually complete). Mirrors `multi-run.it.test.ts`'s
 * `DelayedLLMProvider` shape (test-file-only, not `adapters/mocks.ts`).
 */
class TrackingDelayedLLMProvider implements LLMProvider {
  readonly id: 'openai' | 'anthropic' | 'openrouter';
  constructor(
    private inner: LLMProvider,
    private delayMs: number,
    private tracker: { inFlight: number; peak: number },
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
    this.tracker.inFlight++;
    this.tracker.peak = Math.max(this.tracker.peak, this.tracker.inFlight);
    try {
      await new Promise((r) => setTimeout(r, this.delayMs));
      return await this.inner.completeStructured(req);
    } finally {
      this.tracker.inFlight--;
    }
  }
  embed(texts: string[]): Promise<number[][]> {
    return this.inner.embed(texts);
  }
}

describe('ReviewRunExecutor.executeRunsConcurrent', () => {
  it('runs all jobs, isolates one induced failure, and completes the bus for every job', async () => {
    const { container, completeSpy } = makeContainer();
    const reviewRepo = makeReviewRepo();
    const agentsRepo = makeAgentsRepo();

    const executor = new ReviewRunExecutor(container, reviewRepo, agentsRepo);

    await executor.executeRunsConcurrent(WS_ID, PULL_ROW, REPO_ROW, [
      { agent: AGENT_A, runId: RUN_ID_A },
      { agent: AGENT_B, runId: RUN_ID_B },
      { agent: AGENT_C_FAILING, runId: RUN_ID_C },
    ]);

    // Every job was completed (agent_runs row written) — no job silently dropped.
    expect(reviewRepo.__completedByRun.size).toBe(3);
    expect(reviewRepo.__completedByRun.get(RUN_ID_A)?.status).toBe('done');
    expect(reviewRepo.__completedByRun.get(RUN_ID_B)?.status).toBe('done');
    // The induced-failure job is isolated: it fails, but does NOT prevent A/B.
    expect(reviewRepo.__completedByRun.get(RUN_ID_C)?.status).toBe('failed');

    // runBus.complete fired for every job, including the failed one.
    const completedRunIds = completeSpy.mock.calls.map((c) => c[0]);
    expect(completedRunIds).toContain(RUN_ID_A);
    expect(completedRunIds).toContain(RUN_ID_B);
    expect(completedRunIds).toContain(RUN_ID_C);

    // A trace was persisted for every job (both the success and failure paths).
    expect(reviewRepo.__savedTraces).toHaveLength(3);
  });

  it('all jobs failing (pre-work diff-load failure) still completes the bus for every job', async () => {
    const { container, completeSpy } = makeContainer();
    // Force the diff load to fail entirely: git.diff throws AND the pr_files
    // fallback (diffFromPrFiles → repo.getPrFiles) also throws, so loadDiff
    // itself rejects (a git.diff throw alone would just fall through to an
    // empty-but-successful pr_files reconstruction, not a real failure).
    vi.spyOn(container.git, 'diff').mockRejectedValue(new Error('git unreachable'));
    const reviewRepo = makeReviewRepo();
    reviewRepo.getPrFiles = vi.fn().mockRejectedValue(new Error('pr_files unavailable'));
    const agentsRepo = makeAgentsRepo();

    const executor = new ReviewRunExecutor(container, reviewRepo, agentsRepo);

    await executor.executeRunsConcurrent(WS_ID, PULL_ROW, REPO_ROW, [
      { agent: AGENT_A, runId: RUN_ID_A },
      { agent: AGENT_B, runId: RUN_ID_B },
    ]);

    // Pre-work failure fails EVERY queued run (mirrors executeRuns's failAll).
    expect(reviewRepo.__completedByRun.get(RUN_ID_A)?.status).toBe('failed');
    expect(reviewRepo.__completedByRun.get(RUN_ID_B)?.status).toBe('failed');
    const completedRunIds = completeSpy.mock.calls.map((c) => c[0]);
    expect(completedRunIds).toContain(RUN_ID_A);
    expect(completedRunIds).toContain(RUN_ID_B);
  });
});

describe('ReviewRunExecutor.executeRunsConcurrent — concurrency cap enforcement', () => {
  it('never runs more than MULTI_AGENT_CONCURRENCY_CAP jobs in flight at once, for a job count exceeding the cap', async () => {
    const { container } = makeContainer();
    const tracker = { inFlight: 0, peak: 0 };
    const baseLlm = new MockLLMProvider('openai', {
      structured: { verdict: 'comment', summary: 'Looks fine.', score: 95, findings: [] },
    });
    const trackingLlm = new TrackingDelayedLLMProvider(baseLlm, 25, tracker);
    // Hand out the SAME tracking instance regardless of the job's own provider
    // — only the in-flight COUNT matters here, not per-provider routing.
    (container as unknown as { llm: Container['llm'] }).llm = async () => trackingLlm;

    const reviewRepo = makeReviewRepo();
    const agentsRepo = makeAgentsRepo();
    const executor = new ReviewRunExecutor(container, reviewRepo, agentsRepo);

    // More jobs than the cap, so a correctly-bounded pool MUST throttle at
    // some point — a peak equal to the job count would mean the cap was not
    // enforced at all.
    const jobCount = MULTI_AGENT_CONCURRENCY_CAP + 2;
    const jobs = Array.from({ length: jobCount }, (_, i) => ({
      agent: makeAgent(`77777777-7777-7777-7777-77777777777${i}`, `Agent ${i}`, 'openai'),
      runId: `dddddddd-dddd-dddd-dddd-dddddddddd0${i}`,
    }));

    await executor.executeRunsConcurrent(WS_ID, PULL_ROW, REPO_ROW, jobs);

    // Every job still completes despite the cap (regression guard: bounding
    // concurrency must never drop a job).
    expect(reviewRepo.__completedByRun.size).toBe(jobCount);
    // Genuine concurrency happened (not accidentally serialized down to 1)...
    expect(tracker.peak).toBeGreaterThan(1);
    // ...but the pool never let more than the cap run at the same time, even
    // with more jobs queued than slots.
    expect(tracker.peak).toBeLessThanOrEqual(MULTI_AGENT_CONCURRENCY_CAP);
  });
});
