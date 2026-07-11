import type { BlockTokenCount, Finding } from '@devdigest/shared';
import { CiResultArtifact } from '@devdigest/shared';
import { RunnerError } from './errors.js';

/** Runner version string embedded in every artifact (informational only). */
export const RUNNER_VERSION = '1';

export interface BuildResultArtifactInput {
  findings: Finding[];
  costUsd: number | null;
  durationMs: number;
  agent: string;
  prNumber: number;
  /**
   * Set when the review was SKIPPED rather than run (e.g. `'diff_too_large'`).
   * Findings are empty in that case; ingest maps this to the `skipped_large`
   * run status instead of a misleading zero-finding "no findings".
   */
  skippedReason?: string;
  /**
   * Cost-surgery instrumentation (CI parity with the studio's `cost_report`,
   * mirrors `RunTraceCostReport` in `contracts/trace.ts`). All optional — the
   * skipped-diff-too-large path (and any older caller) omits them entirely,
   * which is fine since every corresponding `CiResultArtifact` field is
   * `.nullish()`.
   */
  blockTokenCounts?: BlockTokenCount[];
  cachedInputTokens?: number | null;
  cacheControlApplied?: boolean;
  excludedBoilerplateFiles?: string[];
  excludedBoilerplateTokens?: number;
  mapReduceThresholdTokens?: number | null;
  mapReduceChunkCount?: number;
}

function severityCounts(findings: Finding[]): { critical: number; warning: number; suggestion: number } {
  const counts = { critical: 0, warning: 0, suggestion: 0 };
  for (const f of findings) {
    if (f.severity === 'CRITICAL') counts.critical++;
    else if (f.severity === 'WARNING') counts.warning++;
    else counts.suggestion++;
  }
  return counts;
}

/**
 * Build + validate the `devdigest-result.json` artifact (AC-26). Validated
 * against the SAME `CiResultArtifact` Zod contract the studio's ingest path
 * (T6) will `safeParse` on the way back in, so a malformed artifact fails
 * loudly here rather than silently on ingest.
 */
export function buildResultArtifact(input: BuildResultArtifactInput): CiResultArtifact {
  const counts = severityCounts(input.findings);
  const candidate = {
    findings_count: input.findings.length,
    critical: counts.critical,
    warning: counts.warning,
    suggestion: counts.suggestion,
    cost_usd: input.costUsd,
    duration_ms: input.durationMs,
    agent: input.agent,
    version: RUNNER_VERSION,
    pr_number: input.prNumber,
    skipped_reason: input.skippedReason,
    block_token_counts: input.blockTokenCounts,
    cached_input_tokens: input.cachedInputTokens,
    cache_control_applied: input.cacheControlApplied,
    excluded_boilerplate_files: input.excludedBoilerplateFiles,
    excluded_boilerplate_tokens: input.excludedBoilerplateTokens,
    map_reduce_threshold_tokens: input.mapReduceThresholdTokens,
    map_reduce_chunk_count: input.mapReduceChunkCount,
  };
  const result = CiResultArtifact.safeParse(candidate);
  if (!result.success) {
    // Should be unreachable — every field above is shaped to the schema. If
    // this ever fires it's a genuine internal bug, not a user/config error.
    throw new RunnerError(
      `Internal error: built result artifact failed CiResultArtifact validation: ${result.error.message}`,
    );
  }
  return result.data;
}
