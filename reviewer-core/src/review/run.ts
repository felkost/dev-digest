import type {
  Finding,
  Intent,
  LLMProvider,
  PromptAssembly,
  Review,
  RunEventKind,
  UnifiedDiff,
} from '@devdigest/shared';
import { Review as ReviewSchema } from '@devdigest/shared';
import { assemblePrompt } from '../prompt.js';
import { groundFindings, groundingSummary } from '../grounding.js';
import { reduceReviews, scoreFromFindings, sliceDiff } from './reduce.js';
import type { TokenCounter } from '../tokens.js';

/**
 * reviewPullRequest — the review engine entry point.
 *
 * given (diff + resolved agent inputs + injected LLM) → grounded Review.
 *
 * This is the pure core lifted out of the server's `ReviewService.runOneAgent`:
 * assemble prompt → single-pass OR map-reduce per file → reduce → SHARED
 * citation-grounding gate. It performs NO I/O beyond the injected LLM provider
 * (no DB, GitHub, fs, memory retrieval, intent, or persistence) — those stay in
 * the caller (server persists + streams SSE; runner posts + writes an artifact).
 *
 * Skill bodies / memory / specs are RESOLVED strings here: the caller turns
 * AgentManifest skill slugs into bodies (DB in the studio, fs in the runner).
 */

/** Default map-reduce threshold (matches the server's FILE_MAP_THRESHOLD_LINES). */
export const DEFAULT_MAP_THRESHOLD_LINES = 400;
/**
 * Default token-budget map-reduce threshold, used only when `countTokens` is
 * injected (see `ReviewInput.countTokens`). A seed value validated against
 * fixture measurements during cost-surgery instrumentation work — NOT a
 * spec-pinned number; revisit if real-world chunking looks off.
 */
export const DEFAULT_MAP_THRESHOLD_TOKENS = 6000;
/** Default structured-output reprompt retries (matches REVIEW_MAX_RETRIES). */
export const DEFAULT_REVIEW_MAX_RETRIES = 2;

export type ReviewStrategy = 'auto' | 'single-pass' | 'map-reduce';
export type ReviewMode = 'single-pass' | 'map-reduce';

/** Progress event emitted during a review (server → SSE bus, runner → log). */
export interface ReviewEvent {
  kind: RunEventKind;
  msg: string;
  data?: unknown;
}

export interface ReviewInput {
  /** Agent system prompt (trusted). */
  systemPrompt: string;
  /** Model id understood by the injected provider (e.g. 'deepseek/deepseek-v4-flash'). */
  model: string;
  /** The PR's unified diff (already parsed; hunks carry new-side line numbers). */
  diff: UnifiedDiff;
  /** Injected LLM provider (OpenRouter in CI, OpenAI/Anthropic in the studio). */
  llm: LLMProvider;
  /** 'auto' (default) picks single-pass unless the diff is large + multi-file. */
  strategy?: ReviewStrategy;
  /** Resolved skill bodies (NOT slugs). */
  skills?: string[];
  /** Curated memory items. */
  memory?: string[];
  /** Project-context spec chunks (untrusted; delimiter-wrapped downstream). */
  specs?: string[];
  /**
   * Optional callers-of-changed-symbols digest (T1.3). Untrusted; rendered
   * before the diff section. Empty/undefined → section omitted.
   */
  callers?: string;
  /**
   * Optional repo skeleton / map (T3). Untrusted; rendered before the project
   * context section. Empty/undefined → section omitted.
   */
  repoMap?: string;
  /** PR author's description/body (untrusted; truncated + delimiter-wrapped in
      the prompt). Empty/undefined → section omitted. */
  prDescription?: string;
  /** PR intent derived by the cheap-model pre-pass. When present, injected into
      the system prompt to scope the reviewer. Omitting has zero effect. */
  intent?: Intent;
  /** Task framing line, e.g. "Review PR #482 …". */
  task?: string;
  /** Override the structured-output retry budget. */
  maxRetries?: number;
  /** Override the map-reduce line threshold. */
  mapThresholdLines?: number;
  /**
   * Injected token counter (cost-surgery instrumentation). When provided, it
   * REPLACES line-counting for the `'auto'` mode-selection decision (uses
   * `countTokens(diff.raw)` against `mapThresholdTokens`) and switches
   * map-reduce chunk building from one-file-per-chunk to a token-budgeted
   * greedy bin-packer. Omitting `countTokens` preserves every existing
   * behavior byte-for-byte: line-count `selectMode`, one-file-per-chunk
   * map-reduce. Explicit `'single-pass'`/`'map-reduce'` strategy overrides are
   * unaffected either way — only the `'auto'` threshold decision and the
   * map-reduce chunk shape change.
   */
  countTokens?: TokenCounter;
  /** Override the map-reduce token threshold (only used when `countTokens` is injected). */
  mapThresholdTokens?: number;
  /**
   * OpenRouter session id — forwarded on every LLM call so all chunks of this
   * review group into one session in the OpenRouter dashboard.
   */
  sessionId?: string;
  /** Progress sink. */
  onEvent?: (e: ReviewEvent) => void;
  /**
   * Cancellation checkpoint, called before each (expensive) chunk LLM call.
   * Supply a function that THROWS to abort mid-run (the caller owns the error
   * type, e.g. the server's RunCancelledError); the engine stays agnostic.
   */
  checkCancelled?: () => void;
}

export interface ReviewOutcome {
  /** The reduced, GROUNDED review (findings that survived the citation gate). */
  review: Review;
  /** Human-readable grounding summary, e.g. "3/4 passed". */
  grounding: string;
  /** Findings dropped by grounding, with reasons (for logs / "never go silent"). */
  dropped: { finding: Finding; reason: string }[];
  /** Which path ran. */
  mode: ReviewMode;
  /** Prompt assembly (for the run trace). Single-pass: the one call; map-reduce: the whole-diff assembly. */
  assembly: PromptAssembly;
  /** Per-chunk labels (for the run trace's tool_calls). */
  chunks: { label: string }[];
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
  /**
   * Prompt-cache-hit input tokens, summed across chunks (cost-surgery
   * instrumentation). Same null-propagation style as `costUsd`: sums when
   * every chunk reports a number; `null` as soon as any chunk's
   * `StructuredResult.cachedTokens` is `null`/`undefined`.
   */
  cachedInputTokens: number | null;
  /** Whether cache-control breakpoints were applied on ANY chunk (OR across chunks). */
  cacheControlApplied: boolean;
  /**
   * The resolved token threshold actually used for mode selection / chunk
   * building — `null` when `countTokens` wasn't injected (line-count path ran
   * instead).
   */
  mapReduceThresholdTokens: number | null;
  /** Number of chunks the review ran over (`chunks.length`); `1` for single-pass. */
  mapReduceChunkCount: number;
  /** Joined raw model outputs (for the run trace). */
  raw: string;
}

function selectMode(
  strategy: ReviewStrategy,
  diff: UnifiedDiff,
  thresholdLines: number,
  countTokens: TokenCounter | undefined,
  thresholdTokens: number | undefined,
): ReviewMode {
  if (strategy === 'single-pass') return 'single-pass';
  if (strategy === 'map-reduce') return diff.files.length > 1 ? 'map-reduce' : 'single-pass';
  // auto: map-reduce only when the diff is both large AND multi-file (else 1 call).
  if (countTokens) {
    // Token-budgeted decision REPLACES line-counting entirely when injected —
    // no line-count fallback mixed in, per the byte-for-byte compat contract.
    const totalTokens = countTokens(diff.raw);
    return totalTokens > (thresholdTokens ?? DEFAULT_MAP_THRESHOLD_TOKENS) && diff.files.length > 1
      ? 'map-reduce'
      : 'single-pass';
  }
  const totalLines = diff.files.reduce((n, f) => n + f.additions + f.deletions, 0);
  return totalLines > thresholdLines && diff.files.length > 1 ? 'map-reduce' : 'single-pass';
}

interface MapReduceChunk {
  label: string;
  diffText: string;
}

/**
 * Build the map-reduce chunk list.
 *
 * Legacy path (`countTokens` omitted): one chunk per file — unchanged since
 * this function's introduction, byte-for-byte.
 *
 * Token-budgeted path (`countTokens` injected): greedy bin-packer — iterate
 * `diff.files` in order, accumulating into a "current chunk" while adding the
 * next file stays within `thresholdTokens`; close and start a new chunk when
 * it would exceed the threshold. A file whose own tokens already exceed the
 * threshold is flushed immediately as its own one-file chunk (never split,
 * never dropped). Each chunk's `label` is its member file paths joined.
 */
function buildMapReduceChunks(
  diff: UnifiedDiff,
  countTokens: TokenCounter | undefined,
  thresholdTokens: number,
): MapReduceChunk[] {
  if (!countTokens) {
    return diff.files.map((f) => ({ label: f.path, diffText: sliceDiff(diff, f.path) }));
  }

  const chunks: MapReduceChunk[] = [];
  let pending: { path: string; diffText: string }[] = [];
  let pendingTokens = 0;

  const flush = () => {
    if (pending.length === 0) return;
    chunks.push({
      label: pending.map((f) => f.path).join(', '),
      diffText: pending.map((f) => f.diffText).join('\n'),
    });
    pending = [];
    pendingTokens = 0;
  };

  for (const f of diff.files) {
    const diffText = sliceDiff(diff, f.path);
    const fileTokens = countTokens(diffText);
    if (fileTokens > thresholdTokens) {
      // Over-threshold on its own: never split, never merged with neighbors —
      // flush whatever was pending, then emit this file alone.
      flush();
      chunks.push({ label: f.path, diffText });
      continue;
    }
    if (pending.length > 0 && pendingTokens + fileTokens > thresholdTokens) {
      flush();
    }
    pending.push({ path: f.path, diffText });
    pendingTokens += fileTokens;
  }
  flush();

  return chunks;
}

export async function reviewPullRequest(input: ReviewInput): Promise<ReviewOutcome> {
  const threshold = input.mapThresholdLines ?? DEFAULT_MAP_THRESHOLD_LINES;
  // Resolved token threshold — only meaningful (non-null) when countTokens is
  // injected; this is also the value reported back on ReviewOutcome.
  const tokenThreshold = input.countTokens
    ? (input.mapThresholdTokens ?? DEFAULT_MAP_THRESHOLD_TOKENS)
    : null;
  const maxRetries = input.maxRetries ?? DEFAULT_REVIEW_MAX_RETRIES;
  const mode = selectMode(
    input.strategy ?? 'auto',
    input.diff,
    threshold,
    input.countTokens,
    tokenThreshold ?? undefined,
  );
  const emit = (kind: RunEventKind, msg: string, data?: unknown) =>
    input.onEvent?.({ kind, msg, data });

  const promptParts = {
    system: input.systemPrompt,
    skills: input.skills,
    memory: input.memory,
    specs: input.specs,
    callers: input.callers,
    repoMap: input.repoMap,
    prDescription: input.prDescription,
    task: input.task,
    ...(input.intent ? { intent: input.intent } : {}),
  };

  // Whole-diff assembly is the trace default; overwritten below for single-pass.
  let assembly: PromptAssembly = assemblePrompt({ ...promptParts, diff: input.diff.raw }).assembly;

  const chunks: MapReduceChunk[] =
    mode === 'map-reduce'
      ? buildMapReduceChunks(input.diff, input.countTokens, tokenThreshold ?? DEFAULT_MAP_THRESHOLD_TOKENS)
      : [{ label: 'all files', diffText: input.diff.raw }];

  emit(
    'info',
    mode === 'map-reduce'
      ? `Large diff → map-reduce over ${input.diff.files.length} files`
      : `Reviewing ${input.diff.files.length} changed file(s) in one pass`,
  );

  const partials: Review[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd: number | null = 0;
  let cachedInputTokens: number | null = 0;
  let cacheControlApplied = false;
  const raws: string[] = [];

  for (const chunk of chunks) {
    // Cancellation checkpoint — stop before the next (expensive) LLM call.
    input.checkCancelled?.();
    // 'map:' prefix only for the map-reduce path (one call per file). In
    // single-pass there is exactly one chunk (the whole diff) — don't mislabel it.
    emit(
      'tool',
      mode === 'map-reduce' ? `map: reviewing ${chunk.label}` : `Reviewing ${chunk.label} in one pass`,
      { file: chunk.label },
    );
    const a = assemblePrompt({ ...promptParts, diff: chunk.diffText });
    if (mode === 'single-pass') assembly = a.assembly;
    const res = await input.llm.completeStructured<Review>({
      model: input.model,
      schema: ReviewSchema,
      schemaName: 'Review',
      messages: a.messages,
      maxRetries,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    });
    tokensIn += res.tokensIn;
    tokensOut += res.tokensOut;
    costUsd = costUsd == null || res.costUsd == null ? null : costUsd + res.costUsd;
    // Same null-propagation style as costUsd: sum while every chunk reports a
    // number; null as soon as any chunk's cachedTokens is null/undefined.
    cachedInputTokens =
      cachedInputTokens == null || res.cachedTokens == null
        ? null
        : cachedInputTokens + res.cachedTokens;
    if (res.cacheControlApplied === true) cacheControlApplied = true;
    raws.push(res.raw);
    partials.push(res.data);
    emit('result', `${chunk.label}: ${res.data.findings.length} candidate finding(s)`);
  }

  const merged = reduceReviews(partials);
  emit(
    'result',
    `Reduced to ${merged.findings.length} finding(s); verdict=${merged.verdict}, score=${merged.score}`,
  );

  // SHARED citation-grounding gate (the only post-step; not duplicated per strategy).
  const ground = groundFindings(merged.findings, input.diff);
  const grounding = groundingSummary(ground);
  for (const d of ground.dropped) {
    emit('info', `grounding dropped "${d.finding.title}": ${d.reason}`);
  }
  emit('result', `Citation grounding: ${grounding}`);

  // Score is derived from the findings that SURVIVED grounding (not the model's
  // self-reported number, and not the pre-grounding set) so the score, the
  // findings list, and the deterministic event always agree.
  return {
    review: { ...merged, findings: ground.kept, score: scoreFromFindings(ground.kept) },
    grounding,
    dropped: ground.dropped,
    mode,
    assembly,
    chunks: chunks.map((c) => ({ label: c.label })),
    tokensIn,
    tokensOut,
    costUsd,
    cachedInputTokens,
    cacheControlApplied,
    mapReduceThresholdTokens: tokenThreshold,
    mapReduceChunkCount: chunks.length,
    raw: raws.join('\n---\n'),
  };
}
