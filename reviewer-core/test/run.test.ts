import { describe, it, expect } from 'vitest';
import type { LLMProvider, StructuredResult } from '@devdigest/shared';
import { MockLLMProvider, MockGitClient } from '../../server/src/adapters/mocks.js';
import { reviewPullRequest, sliceDiff, type TokenCounter } from '../src/index.js';

/**
 * Engine-level test for reviewPullRequest (the core lifted out of the server's
 * runOneAgent). Uses the server's mock LLM + git so we exercise the real
 * assemble → completeStructured → reduce → grounding pipeline with no DB/SSE.
 */
describe('reviewPullRequest (engine)', () => {
  // One grounded finding (line 11 is in the MockGitClient diff) + one
  // hallucinated finding (line 999) the grounding gate must drop.
  const fixture = {
    verdict: 'request_changes',
    summary: 'secret key committed',
    score: 38,
    findings: [
      {
        id: 'f1',
        severity: 'CRITICAL',
        category: 'security',
        title: 'Hardcoded Stripe secret key',
        file: 'src/config.ts',
        start_line: 11,
        end_line: 11,
        rationale: 'sk_live in diff',
        confidence: 0.98,
        kind: 'finding',
      },
      {
        id: 'f-hallucinated',
        severity: 'WARNING',
        category: 'bug',
        title: 'phantom finding on a line not in the diff',
        file: 'src/config.ts',
        start_line: 999,
        end_line: 999,
        rationale: 'not real',
        confidence: 0.3,
        kind: 'finding',
      },
    ],
  };

  it('single-pass: assembles, grounds, drops the hallucinated finding', async () => {
    const llm = new MockLLMProvider('openai', { structured: fixture });
    const diff = await new MockGitClient().diff();

    const events: string[] = [];
    const outcome = await reviewPullRequest({
      systemPrompt: 'security reviewer',
      model: 'gpt-4.1',
      diff,
      llm,
      task: 'Review PR #482',
      onEvent: (e) => events.push(e.msg),
    });

    expect(outcome.mode).toBe('single-pass');
    expect(outcome.grounding).toBe('1/2 passed');
    expect(outcome.review.findings).toHaveLength(1);
    expect(outcome.review.findings[0]!.start_line).toBe(11);
    expect(outcome.dropped).toHaveLength(1);
    // Score is derived from the SURVIVING findings, not the model's self-reported
    // 38: one CRITICAL remains after grounding ⇒ 100 − 35 = 65.
    expect(outcome.review.score).toBe(65);
    // progress is surfaced (server bridges this onto SSE; runner logs it)
    expect(events.some((m) => m.includes('Citation grounding'))).toBe(true);
  });

  it('score is deterministic from findings: a clean approve scores 100', async () => {
    // Model "approves" but reports a nonsense low score (the cheap-model bug).
    // The engine must ignore that and score the zero findings as a perfect 100.
    const clean = { verdict: 'approve', summary: 'looks good', score: 10, findings: [] };
    const llm = new MockLLMProvider('openai', { structured: clean });
    const diff = await new MockGitClient().diff();

    const outcome = await reviewPullRequest({
      systemPrompt: 'security reviewer',
      model: 'deepseek/deepseek-v4-flash',
      diff,
      llm,
      task: 'Review PR #5',
    });

    expect(outcome.review.findings).toHaveLength(0);
    expect(outcome.review.score).toBe(100);
  });

  it('checkCancelled throwing aborts before the LLM call', async () => {
    const llm = new MockLLMProvider('openai', { structured: fixture });
    const diff = await new MockGitClient().diff();
    await expect(
      reviewPullRequest({
        systemPrompt: 's',
        model: 'gpt-4.1',
        diff,
        llm,
        checkCancelled: () => {
          throw new Error('cancelled');
        },
      }),
    ).rejects.toThrow('cancelled');
  });

  it('forwards sessionId to every LLM call (OpenRouter session grouping)', async () => {
    const seen: (string | undefined)[] = [];
    const recorder: LLMProvider = {
      id: 'openrouter',
      async completeStructured<T>(req): Promise<StructuredResult<T>> {
        seen.push(req.sessionId);
        return {
          data: fixture as unknown as T,
          model: req.model,
          tokensIn: 0,
          tokensOut: 0,
          costUsd: 0,
          raw: '',
          attempts: 1,
        };
      },
      async listModels() {
        return [];
      },
      async complete() {
        throw new Error('not used');
      },
      async embed() {
        return [];
      },
    };
    const diff = await new MockGitClient().diff();
    await reviewPullRequest({ systemPrompt: 's', model: 'm', diff, llm: recorder, sessionId: 'sess-abc' });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s === 'sess-abc')).toBe(true);
  });

  // ---------------------------------------------------------------------
  // Token-budget map-reduce + cache accumulation (WS2, WS5). `countTokens`
  // is injected only in the new cases below — every test ABOVE this line is
  // unmodified and exercises the countTokens-omitted (legacy) path.
  // ---------------------------------------------------------------------

  /** Synthesize a diff hunk that adds `lines` new lines to `path` (no context beyond one anchor line). */
  function manyLineFile(path: string, lines: number): string {
    const adds = Array.from({ length: lines }, (_, i) => `+line${i}`).join('\n');
    return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,${lines + 1} @@\n x\n${adds}`;
  }

  const APPROVE_FIXTURE = { verdict: 'approve', summary: 'ok', score: 100, findings: [] };

  it('countTokens omitted: multi-file diffs still use line-count auto mode-selection + one-file-per-chunk map-reduce (regression guard)', async () => {
    // Two 250-line files ⇒ totalLines=500 > DEFAULT_MAP_THRESHOLD_LINES(400), multi-file ⇒ map-reduce
    // via the untouched line-counting branch of selectMode (no countTokens injected).
    const raw = [manyLineFile('src/a.ts', 250), manyLineFile('src/b.ts', 250)].join('\n');
    const diff = await new MockGitClient({ diff: raw }).diff();
    const llm = new MockLLMProvider('openai', { structured: APPROVE_FIXTURE });

    const outcome = await reviewPullRequest({
      systemPrompt: 'security reviewer',
      model: 'gpt-4.1',
      diff,
      llm,
    });

    expect(outcome.mode).toBe('map-reduce');
    // Legacy one-file-per-chunk shape, untouched.
    expect(outcome.chunks).toEqual([{ label: 'src/a.ts' }, { label: 'src/b.ts' }]);
    expect(outcome.mapReduceChunkCount).toBe(2);
    // New fields resolve to their "countTokens not injected" defaults.
    expect(outcome.mapReduceThresholdTokens).toBeNull();
    expect(outcome.cachedInputTokens).toBeNull();
    expect(outcome.cacheControlApplied).toBe(false);
  });

  it('bin-packs many small files into fewer chunks than files when countTokens is injected', async () => {
    const paths = ['f0.ts', 'f1.ts', 'f2.ts', 'f3.ts', 'f4.ts', 'f5.ts'];
    const smallBlock = (p: string) =>
      `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1,1 +1,2 @@\n x\n+y`;
    const raw = paths.map(smallBlock).join('\n');
    const diff = await new MockGitClient({ diff: raw }).diff();

    const countTokens: TokenCounter = (t) => t.length;
    // All 6 filenames share the same length ⇒ identical per-file token counts;
    // pack ~2 files per chunk.
    const singleFileTokens = countTokens(sliceDiff(diff, paths[0]!));
    const mapThresholdTokens = Math.floor(singleFileTokens * 2.5);

    const llm = new MockLLMProvider('openai', { structured: APPROVE_FIXTURE });

    const outcome = await reviewPullRequest({
      systemPrompt: 'security reviewer',
      model: 'gpt-4.1',
      diff,
      llm,
      strategy: 'map-reduce',
      countTokens,
      mapThresholdTokens,
    });

    expect(outcome.mode).toBe('map-reduce');
    expect(outcome.mapReduceThresholdTokens).toBe(mapThresholdTokens);
    expect(outcome.mapReduceChunkCount).toBeLessThan(paths.length);
    expect(outcome.chunks.length).toBe(outcome.mapReduceChunkCount);
    // Each chunk's label is its member paths joined.
    expect(outcome.chunks.every((c) => c.label.length > 0)).toBe(true);
  });

  it('flushes a single over-threshold file as its own chunk without splitting or merging, even inside a bin-packed run', async () => {
    const smallBlock = (p: string) =>
      `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1,1 +1,2 @@\n x\n+y`;
    const bigBlock =
      `diff --git a/big.ts b/big.ts\n--- a/big.ts\n+++ b/big.ts\n@@ -1,1 +1,5 @@\n x\n` +
      `+${'a'.repeat(200)}\n+${'b'.repeat(200)}\n+${'c'.repeat(200)}\n+${'d'.repeat(200)}`;
    const raw = [smallBlock('small0.ts'), bigBlock, smallBlock('small1.ts')].join('\n');
    const diff = await new MockGitClient({ diff: raw }).diff();

    const countTokens: TokenCounter = (t) => t.length;
    const smallTokens = countTokens(sliceDiff(diff, 'small0.ts'));
    // Threshold comfortably above one small file, far below the big file.
    const mapThresholdTokens = smallTokens + 20;

    const llm = new MockLLMProvider('openai', { structured: APPROVE_FIXTURE });

    const outcome = await reviewPullRequest({
      systemPrompt: 'security reviewer',
      model: 'gpt-4.1',
      diff,
      llm,
      strategy: 'map-reduce',
      countTokens,
      mapThresholdTokens,
    });

    expect(outcome.chunks.map((c) => c.label)).toEqual(['small0.ts', 'big.ts', 'small1.ts']);
    expect(outcome.mapReduceChunkCount).toBe(3);
  });

  const TWO_FILE_DIFF =
    'diff --git a/src/config.ts b/src/config.ts\n' +
    '--- a/src/config.ts\n' +
    '+++ b/src/config.ts\n' +
    '@@ -10,3 +10,4 @@\n' +
    '   port: 3000,\n' +
    '+  stripeKey: "sk_live_xxx",\n' +
    '   redisUrl: x,\n' +
    'diff --git a/src/other.ts b/src/other.ts\n' +
    '--- a/src/other.ts\n' +
    '+++ b/src/other.ts\n' +
    '@@ -1,1 +1,2 @@\n' +
    ' x\n' +
    '+y';

  it('cachedInputTokens: null when any chunk omits cachedTokens (null-propagation, same style as costUsd)', async () => {
    const diff = await new MockGitClient({ diff: TWO_FILE_DIFF }).diff();
    let call = 0;
    const recorder: LLMProvider = {
      id: 'openrouter',
      async completeStructured<T>(req): Promise<StructuredResult<T>> {
        call += 1;
        return {
          data: fixture as unknown as T,
          model: req.model,
          tokensIn: 10,
          tokensOut: 5,
          costUsd: 0.001,
          raw: '',
          attempts: 1,
          cachedTokens: call === 1 ? 120 : undefined,
        };
      },
      async listModels() {
        return [];
      },
      async complete() {
        throw new Error('not used');
      },
      async embed() {
        return [];
      },
    };

    const outcome = await reviewPullRequest({
      systemPrompt: 's',
      model: 'm',
      diff,
      llm: recorder,
      strategy: 'map-reduce',
    });

    expect(outcome.mapReduceChunkCount).toBe(2);
    expect(outcome.cachedInputTokens).toBeNull();
  });

  it('cachedInputTokens: sums when every chunk reports a number', async () => {
    const diff = await new MockGitClient({ diff: TWO_FILE_DIFF }).diff();
    const recorder: LLMProvider = {
      id: 'openrouter',
      async completeStructured<T>(req): Promise<StructuredResult<T>> {
        return {
          data: fixture as unknown as T,
          model: req.model,
          tokensIn: 10,
          tokensOut: 5,
          costUsd: 0.001,
          raw: '',
          attempts: 1,
          cachedTokens: 80,
        };
      },
      async listModels() {
        return [];
      },
      async complete() {
        throw new Error('not used');
      },
      async embed() {
        return [];
      },
    };

    const outcome = await reviewPullRequest({
      systemPrompt: 's',
      model: 'm',
      diff,
      llm: recorder,
      strategy: 'map-reduce',
    });

    expect(outcome.mapReduceChunkCount).toBe(2);
    expect(outcome.cachedInputTokens).toBe(160);
  });
});
