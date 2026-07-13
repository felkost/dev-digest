/**
 * Hermetic tests for `ReviewRunExecutor`'s cost-surgery instrumentation
 * (Step 10 — WS1/WS2/WS3/WS4/WS5 studio wiring), exercised indirectly via the
 * public `executeRuns` entry point (`runOneAgent` is private).
 *
 * No Postgres, no Docker. `ReviewRepository` and `Container['agentsRepo']` are
 * constructor-injected hand-rolled `vi.fn()` stubs (mirrors
 * `run-executor-context-docs.test.ts`'s conventions); `container.git`/`llm`
 * use the mocks in `src/adapters/mocks.ts`. `container.db` is a minimal
 * call-counted fake satisfying `ContextDocsRepository`'s queries (empty
 * attachments) AND `getFeatureModelOverride`'s `settings` lookup (no
 * override) — the latter is newly exercised because `runOneAgent` now calls
 * `resolveIntentModel` (Step 10 item 2) instead of `routeModel` directly.
 *
 * Covers (per Step 10's "New tests" list):
 *  (a) a diff containing a `package-lock.json` change is excluded before
 *      `budgetDiff` runs even though the whole diff is comfortably under the
 *      model's token budget (the "unconditional, not only-when-over-budget"
 *      behavior change).
 *  (b) a run's persisted `RunTrace.cost_report.block_token_counts` has one
 *      entry per present prompt slot (only `system` + `user` are present for
 *      this fixture — no skills/memory/specs/callers/repo_map/pr_description).
 *  (c) `excluded_boilerplate_files: []` / `excluded_boilerplate_tokens: 0` are
 *      PRESENT (not omitted) on a run with zero boilerplate files.
 */
import { describe, it, expect, vi } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { ReviewRunExecutor } from '../src/modules/reviews/run-executor.js';
import { MockLLMProvider, MockGitClient } from '../src/adapters/mocks.js';
import { RunBus } from '../src/platform/sse.js';
import type { Container } from '../src/platform/container.js';
import { ContextDocsService } from '../src/modules/context-docs/service.js';
import type { ReviewRepository, PullRow } from '../src/modules/reviews/repository.js';
import type { RunTrace } from '@devdigest/shared';
import * as schema from '../src/db/schema.js';

const WS_ID = 'a2222222-2222-2222-2222-222222222222';
const REPO_ID = 'a3333333-3333-3333-3333-333333333333';
const AGENT_ID = 'a4444444-4444-4444-4444-444444444444';
const PR_ID = 'a6666666-6666-6666-6666-666666666666';
const RUN_ID = 'a7777777-7777-7777-7777-777777777777';

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
  number: 42,
  title: 'Add rate limiting',
  author: 'marisa.koch',
  branch: 'feat/rate-limit',
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

const AGENT_ROW = {
  id: AGENT_ID,
  workspaceId: WS_ID,
  name: 'Reviewer',
  description: '',
  provider: 'anthropic' as const,
  model: 'claude-sonnet',
  systemPrompt: 'You review PRs.',
  outputSchema: null,
  strategy: 'single-pass' as const,
  ciFailOn: 'critical' as const,
  repoIntel: false, // keep repo-intel enrichment off — irrelevant here, avoids extra mocking
  enabled: true,
  version: 1,
  createdBy: null,
  createdAt: new Date('2026-01-01'),
};

/** One git-diff --git block (matches reviewer-core's `boilerplate.test.ts` helper). */
function block(path: string, body: string): string {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}`;
}

const CODE_BLOCK = block(
  'src/config.ts',
  '@@ -1,2 +1,3 @@\n export const PORT = 3000;\n+export const HOST = "0.0.0.0";',
);
const LOCK_BLOCK = block(
  'package-lock.json',
  '@@ -1,2 +1,3 @@\n {\n+  "lockfileVersion": 3,\n }',
);
/** Diff with one core file + one boilerplate (lockfile) change, both tiny —
 *  well under any model's token budget, so exclusion here can ONLY be
 *  explained by the unconditional boilerplate filter, not `budgetDiff`. */
const DIFF_WITH_LOCKFILE = [CODE_BLOCK, LOCK_BLOCK].join('\n');

/** Minimal call-counted fake db satisfying:
 *  - ContextDocsRepository's queries (agent/skill attachments, context folders) — all empty
 *  - `getFeatureModelOverride`'s `settings` lookup (`{key, value}` columns) —
 *    returns `settingsRows` verbatim, `[]` (no override) by default. */
function makeDb(settingsRows: { key: string; value: unknown }[] = []) {
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
      limit: (_n: number) => Promise.resolve(resolve()),
      then: (
        onFulfilled?: (value: Record<string, unknown>[]) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => Promise.resolve(resolve()).then(onFulfilled, onRejected),
      catch: (onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(resolve()).catch(onRejected),
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
          // `getFeatureModelOverride`'s settings lookup — `{key, value}` columns.
          if (columns && 'key' in columns && 'value' in columns) {
            return settingsRows;
          }
          // agent_context_docs / skill_context_docs — empty.
          void tableName;
          return [];
        });
      },
    }),
  };
}

/** Minimal ReviewRepository stub — only the methods executeRuns/runOneAgent call.
 *  `cachedIntent`, when passed, makes `getIntent` return an already-classified
 *  intent (cache hit) — the pre-pass skips the LLM call entirely. */
function makeReviewRepo(opts: { cachedIntent?: import('@devdigest/shared').Intent } = {}): ReviewRepository {
  const savedTraces: RunTrace[] = [];
  const completed: { status: string }[] = [];
  const repo = {
    getIntent: vi.fn().mockResolvedValue(opts.cachedIntent),
    upsertIntent: vi.fn().mockResolvedValue(undefined),
    getPrFiles: vi.fn().mockResolvedValue([]),
    insertReview: vi.fn().mockResolvedValue({
      id: 'review-1',
      workspaceId: WS_ID,
      prId: PR_ID,
      agentId: AGENT_ID,
      runId: RUN_ID,
      kind: 'review',
      verdict: 'comment',
      summary: 'ok',
      score: 95,
      model: AGENT_ROW.model,
      createdAt: new Date(),
    }),
    insertFindings: vi.fn().mockResolvedValue([]),
    markReviewed: vi.fn().mockResolvedValue(undefined),
    completeAgentRun: vi.fn().mockImplementation(async (_runId: string, values: { status: string }) => {
      completed.push(values);
    }),
    saveRunTrace: vi.fn().mockImplementation(async (_runId: string, trace: RunTrace) => {
      savedTraces.push(trace);
    }),
    upsertBrief: vi.fn().mockRejectedValue(new Error('brief composition not exercised in this test')),
    __savedTraces: savedTraces,
    __completed: completed,
  };
  return repo as unknown as ReviewRepository;
}

/** Container with MockLLMProvider (returns findings:[] / score:95) + MockGitClient
 *  (diff fixture overridable per test) + the fake db above. Tokenizer is a
 *  deterministic word-count so exact counts don't matter — only presence,
 *  zero-vs-nonzero, and relative comparisons are asserted.
 *
 *  `settingsRows` seeds `getFeatureModelOverride`'s lookup (e.g. a
 *  `review_intent` provider override). `llmCalls`, when passed, records every
 *  provider id `container.llm(...)` was called with — lets a test assert
 *  WHICH provider drove client selection (High-severity fix regression test:
 *  the intent step must use the OVERRIDE's provider, not the agent's). */
function makeContainer(opts: {
  diff?: string;
  settingsRows?: { key: string; value: unknown }[];
  llmCalls?: string[];
  /** Per-schemaName fixtures — e.g. `{ PRIntent: {...} }` to make the intent
   *  pre-pass succeed instead of falling through to the Review-shaped
   *  default (which fails PRIntent's schema and leaves intent undefined). */
  structuredBySchema?: Record<string, unknown>;
}): Container {
  const gitClient = new MockGitClient({ diff: opts.diff });
  const llm = new MockLLMProvider('anthropic', {
    structured: { verdict: 'comment', summary: 'Looks fine.', score: 95, findings: [] },
    ...(opts.structuredBySchema ? { structuredBySchema: opts.structuredBySchema } : {}),
  });

  const container = {
    db: makeDb(opts.settingsRows),
    git: gitClient,
    tokenizer: { count: (text: string) => text.split(/\s+/).filter(Boolean).length },
    llm: async (id: string) => {
      opts.llmCalls?.push(id);
      return llm;
    },
    runBus: new RunBus(),
    blast: { getBlast: vi.fn().mockRejectedValue(new Error('blast not exercised')) },
  } as unknown as Container;
  // `run-executor.ts` consumes `container.contextDocs` (Container's lazy
  // facade getter). This test's `container` is a plain object fake (not a
  // real `Container` instance), so the getter doesn't exist — build the real
  // service here, backed by the same `db` fake, under the same property name.
  (container as unknown as { contextDocs: ContextDocsService }).contextDocs =
    new ContextDocsService(container);

  return container;
}

function makeAgentsRepo() {
  return {
    linkedSkills: vi.fn().mockResolvedValue([]),
  } as unknown as Container['agentsRepo'];
}

// ---------------------------------------------------------------------------
// (a) Boilerplate exclusion is UNCONDITIONAL — runs even when already under budget
// ---------------------------------------------------------------------------

describe('ReviewRunExecutor — unconditional boilerplate exclusion', () => {
  it('excludes package-lock.json before budgetDiff even though the whole diff is under the token budget', async () => {
    const container = makeContainer({ diff: DIFF_WITH_LOCKFILE });
    const reviewRepo = makeReviewRepo();
    const executor = new ReviewRunExecutor(container, reviewRepo, makeAgentsRepo());

    await executor.executeRuns(WS_ID, PULL_ROW, REPO_ROW, [{ agent: AGENT_ROW as never, runId: RUN_ID }]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const savedTraces = (reviewRepo as any).__savedTraces as RunTrace[];
    expect(savedTraces).toHaveLength(1);
    const trace = savedTraces[0]!;

    // The lockfile was excluded — recorded in cost_report, not silently dropped.
    expect(trace.cost_report?.excluded_boilerplate_files).toEqual(['package-lock.json']);
    expect(trace.cost_report?.excluded_boilerplate_tokens).toBeGreaterThan(0);

    // The prompt actually sent to the LLM (assembly.user, which carries the
    // '## Diff to review' section) never contains the excluded file's content —
    // proving exclusion happened BEFORE reviewPullRequest/assemblePrompt, not
    // just that it was reported after the fact.
    expect(trace.prompt_assembly.user).toContain('src/config.ts');
    expect(trace.prompt_assembly.user).not.toContain('package-lock.json');

    // Live-log line confirms the always-emitted, non-conditional wiring.
    expect(trace.log.some((l) => /boilerplate filter: 1 file\(s\) excluded/.test(l.msg))).toBe(true);

    // Run still completes successfully.
    expect((reviewRepo as any).__completed[0]!.status).toBe('done'); // eslint-disable-line @typescript-eslint/no-explicit-any
  });
});

// ---------------------------------------------------------------------------
// (b) block_token_counts has one entry per present prompt slot
// ---------------------------------------------------------------------------

describe('ReviewRunExecutor — cost_report.block_token_counts', () => {
  it('has exactly one entry per present prompt slot (system + user only, for this fixture)', async () => {
    const container = makeContainer({}); // default single-file diff (no lockfile)
    const reviewRepo = makeReviewRepo();
    const executor = new ReviewRunExecutor(container, reviewRepo, makeAgentsRepo());

    await executor.executeRuns(WS_ID, PULL_ROW, REPO_ROW, [{ agent: AGENT_ROW as never, runId: RUN_ID }]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const savedTraces = (reviewRepo as any).__savedTraces as RunTrace[];
    const trace = savedTraces[0]!;

    // This fixture (repoIntel:false, no skills, no specs, no PR body, intent
    // classification fails against the Review-shaped mock fixture) leaves only
    // `system` and `user` populated in the assembled prompt — absent slots
    // (skills/memory/specs/callers/repo_map/pr_description) must be OMITTED,
    // never reported with a fabricated 0.
    const blocks = trace.cost_report?.block_token_counts ?? [];
    expect(blocks.map((b) => b.block).sort()).toEqual(['system', 'user']);
    for (const b of blocks) {
      expect(typeof b.tokens).toBe('number');
      expect(b.tokens as number).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// (c) zero-boilerplate run still reports [] / 0, never omits the keys
// ---------------------------------------------------------------------------

describe('ReviewRunExecutor — cost_report zero-exclusion fields are present, not omitted', () => {
  it('persists excluded_boilerplate_files: [] and excluded_boilerplate_tokens: 0 on a run with no boilerplate files', async () => {
    const container = makeContainer({}); // default single-file diff (no lockfile)
    const reviewRepo = makeReviewRepo();
    const executor = new ReviewRunExecutor(container, reviewRepo, makeAgentsRepo());

    await executor.executeRuns(WS_ID, PULL_ROW, REPO_ROW, [{ agent: AGENT_ROW as never, runId: RUN_ID }]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const savedTraces = (reviewRepo as any).__savedTraces as RunTrace[];
    const trace = savedTraces[0]!;

    expect(trace.cost_report).toBeDefined();
    expect(trace.cost_report).toHaveProperty('excluded_boilerplate_files');
    expect(trace.cost_report).toHaveProperty('excluded_boilerplate_tokens');
    expect(trace.cost_report?.excluded_boilerplate_files).toEqual([]);
    expect(trace.cost_report?.excluded_boilerplate_tokens).toBe(0);

    // Also present (per Step 10 item 6) — the other cost_report fields, unconditionally.
    expect(trace.cost_report?.cached_input_tokens === null || typeof trace.cost_report?.cached_input_tokens === 'number').toBe(true);
    expect(typeof trace.cost_report?.cache_control_applied).toBe('boolean');
    expect(typeof trace.cost_report?.map_reduce_chunk_count).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// (d) High-severity architecture-review fix: `resolveIntentModel`'s result
// (provider AND model) must drive `container.llm(...)` for intent
// classification. Before the fix, the caller discarded the resolved
// `.provider` and always built the LLM client from `firstProvider` (the
// agent's own provider) — silently degrading intent for any workspace with a
// cross-provider `review_intent` override (the override's model string would
// be sent to the WRONG provider's client).
// ---------------------------------------------------------------------------

describe('ReviewRunExecutor — resolveIntentModel provider routing (High-severity fix)', () => {
  it('a cross-provider review_intent override drives container.llm(...) for the intent step, not the agent\'s own provider', async () => {
    const llmCalls: string[] = [];
    const container = makeContainer({
      settingsRows: [
        {
          key: 'feature_models',
          value: { review_intent: { provider: 'openrouter', model: 'z-ai/glm-4.7-flash' } },
        },
      ],
      llmCalls,
    });
    const reviewRepo = makeReviewRepo();
    const executor = new ReviewRunExecutor(container, reviewRepo, makeAgentsRepo());

    // AGENT_ROW.provider is 'anthropic'. The buggy code called
    // `container.llm(firstProvider)` — i.e. always 'anthropic' — for intent,
    // ignoring the 'openrouter' override entirely. The fix must call
    // `container.llm('openrouter')` for the intent step (in addition to the
    // agent's own 'anthropic' call for its review).
    await executor.executeRuns(WS_ID, PULL_ROW, REPO_ROW, [{ agent: AGENT_ROW as never, runId: RUN_ID }]);

    expect(llmCalls).toContain('openrouter'); // intent classification — from the override
    expect(llmCalls).toContain('anthropic'); // the agent's own review call — unaffected

    // The run still completes successfully — a cross-provider intent
    // override must never degrade the review itself (intent classification
    // failure, if any, stays non-fatal).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((reviewRepo as any).__completed[0]!.status).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// (e) The intent-classification pre-pass's own cost/tokens surface in
// cost_report.intent_* — previously computed then discarded (only logged),
// never persisted anywhere a user could see it on the Trace tab.
// ---------------------------------------------------------------------------

describe('ReviewRunExecutor — cost_report.intent_* (intent-phase cost surfacing)', () => {
  it('persists the intent pre-pass tokens/cost when this batch freshly classified intent', async () => {
    const container = makeContainer({
      structuredBySchema: {
        PRIntent: { intent: 'Adds rate limiting', in_scope: ['rate limiting'], out_of_scope: ['auth'] },
      },
    });
    const reviewRepo = makeReviewRepo(); // getIntent resolves undefined — forces classification
    const executor = new ReviewRunExecutor(container, reviewRepo, makeAgentsRepo());

    await executor.executeRuns(WS_ID, PULL_ROW, REPO_ROW, [{ agent: AGENT_ROW as never, runId: RUN_ID }]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const trace = ((reviewRepo as any).__savedTraces as RunTrace[])[0]!;

    // MockLLMProvider's completeStructured always returns tokensIn:100,
    // tokensOut:50, costUsd:0.001 — deterministic, so exact values are safe.
    expect(trace.cost_report?.intent_cost_usd).toBe(0.001);
    expect(trace.cost_report?.intent_tokens_in).toBe(100);
    expect(trace.cost_report?.intent_tokens_out).toBe(50);
  });

  it('leaves intent_cost_usd/intent_tokens_* null when this batch reused a cached pr_intent (no LLM call)', async () => {
    const container = makeContainer({}); // no PRIntent fixture needed — classification never runs
    const reviewRepo = makeReviewRepo({
      cachedIntent: { intent: 'Adds rate limiting', in_scope: ['rate limiting'], out_of_scope: [] },
    });
    const executor = new ReviewRunExecutor(container, reviewRepo, makeAgentsRepo());

    await executor.executeRuns(WS_ID, PULL_ROW, REPO_ROW, [{ agent: AGENT_ROW as never, runId: RUN_ID }]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const trace = ((reviewRepo as any).__savedTraces as RunTrace[])[0]!;

    expect(trace.cost_report?.intent_cost_usd).toBeNull();
    expect(trace.cost_report?.intent_tokens_in).toBeNull();
    expect(trace.cost_report?.intent_tokens_out).toBeNull();
  });
});
