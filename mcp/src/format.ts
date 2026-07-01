/**
 * Pure projection and pagination helpers for the MCP server.
 *
 * Rules:
 *  - No async, no I/O, no side effects, no console, no env reads.
 *  - No imports from server/src/ — types via `import type` from @devdigest/shared only.
 *  - No import from @devdigest/reviewer-core.
 */

import type { Agent, Convention, PrBrief, ReviewRecord } from '@devdigest/shared';
import type { FindingRecord } from '@devdigest/shared';

// ---------------------------------------------------------------------------
// Agent projection
// ---------------------------------------------------------------------------

/** Projected agent shape — drops system_prompt, output_schema, version, strategy,
 *  ci_fail_on, and repo_intel. Keeps only the fields useful to an LLM caller. */
export type ProjectedAgent = {
  id: string;
  name: string;
  description: string;
  provider: string;
  model: string;
  enabled: boolean;
};

/**
 * Projects an Agent to a concise shape for MCP responses.
 * Drops system_prompt, output_schema, version, strategy, ci_fail_on, repo_intel.
 */
export function projectAgent(agent: Agent): ProjectedAgent {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    provider: agent.provider,
    model: agent.model,
    enabled: agent.enabled,
  };
}

// ---------------------------------------------------------------------------
// Convention projection
// ---------------------------------------------------------------------------

/** Projected convention shape for MCP responses. */
export type ProjectedConvention = {
  rule: string;
  category: string;
  status: string;
  evidence_path: string | null;
};

/**
 * Projects a Convention to a concise shape.
 *  - rule: edited_rule if present, else rule
 *  - category: category if present, else 'uncategorized'
 *  - evidence_path: evidence_path if present, else null
 *
 * Note: status filtering (accepted/verified only) happens at the call site
 * (Step 5 tool handler) — this function is a pure projection with no filtering.
 */
export function projectConvention(c: Convention): ProjectedConvention {
  return {
    rule: c.edited_rule ?? c.rule,
    category: c.category ?? 'uncategorized',
    status: c.status,
    evidence_path: c.evidence_path ?? null,
  };
}

// ---------------------------------------------------------------------------
// Blast radius projection
// ---------------------------------------------------------------------------

/** Shape returned when blast radius is not available. */
export type BlastUnavailable = {
  available: false;
  reason: string;
};

/** Shape returned when blast radius data is present. */
export type BlastAvailable = {
  available: true;
  summary: string;
  changed_symbols_count: number;
  downstream_count: number;
  top_downstream: Array<{
    symbol: string;
    callers_count: number;
    endpoints_affected: string[];
  }>;
};

export type ProjectedBlast = BlastUnavailable | BlastAvailable;

/**
 * Projects a PrBrief (or null) to a blast radius shape.
 *  - null brief → { available: false, reason: "blast radius computed in a later lesson" }
 *  - non-null brief → { available: true, ... } using brief.blast
 *
 * Per the PrBrief schema, blast is always present when brief is non-null.
 * We map DownstreamImpact to a concise shape: { symbol, callers_count, endpoints_affected }.
 */
export function projectBlast(brief: PrBrief | null): ProjectedBlast {
  if (brief === null) {
    return {
      available: false,
      reason: 'blast radius computed in a later lesson',
    };
  }

  const blast = brief.blast;

  return {
    available: true,
    summary: blast.summary,
    changed_symbols_count: blast.changed_symbols.length,
    downstream_count: blast.downstream.length,
    top_downstream: blast.downstream.slice(0, 5).map((d) => ({
      symbol: d.symbol,
      callers_count: d.callers.length,
      endpoints_affected: d.endpoints_affected,
    })),
  };
}

// ---------------------------------------------------------------------------
// Findings pagination
// ---------------------------------------------------------------------------

/** Severity sort order: CRITICAL (0) → WARNING (1) → SUGGESTION (2). */
const SEVERITY_ORDER: Record<string, number> = {
  CRITICAL: 0,
  WARNING: 1,
  SUGGESTION: 2,
};

/** Paginated findings result. */
export type PaginatedFindings = {
  items: FindingRecord[];
  has_more: boolean;
  total: number;
};

/**
 * Flattens all findings from all reviews, sorts by severity
 * (CRITICAL → WARNING → SUGGESTION), then paginates.
 *
 *  - limit defaults to 20
 *  - limit is capped at 50
 *  - has_more is true when total > effective limit
 */
export function paginateFindings(
  reviews: ReviewRecord[],
  limit = 20,
): PaginatedFindings {
  const effectiveLimit = Math.min(limit, 50);

  const all: FindingRecord[] = reviews.flatMap((r) => r.findings);

  all.sort((a, b) => {
    const orderA = SEVERITY_ORDER[a.severity] ?? 3;
    const orderB = SEVERITY_ORDER[b.severity] ?? 3;
    return orderA - orderB;
  });

  const total = all.length;
  const items = all.slice(0, effectiveLimit);
  const has_more = total > effectiveLimit;

  return { items, has_more, total };
}

// ---------------------------------------------------------------------------
// findings_breakdown computation (from review findings)
// ---------------------------------------------------------------------------

/** Findings breakdown counts by severity. */
export type FindingsBreakdown = {
  critical: number;
  warning: number;
  suggestion: number;
};

/**
 * Counts findings by severity for one review's findings array.
 * ReviewRecord has no pre-computed breakdown field — we compute it here.
 */
export function computeBreakdown(findings: FindingRecord[]): FindingsBreakdown {
  let critical = 0;
  let warning = 0;
  let suggestion = 0;
  for (const f of findings) {
    if (f.severity === 'CRITICAL') critical++;
    else if (f.severity === 'WARNING') warning++;
    else if (f.severity === 'SUGGESTION') suggestion++;
  }
  return { critical, warning, suggestion };
}

// ---------------------------------------------------------------------------
// Concise review summary
// ---------------------------------------------------------------------------

/** Per-agent concise summary — no finding bodies. */
export type ConciseReviewEntry = {
  agent_name: string | null;
  verdict: string | null;
  score: number | null;
  findings_breakdown: FindingsBreakdown;
};

/**
 * Returns a per-review concise summary without finding bodies.
 * findings_breakdown is computed from the review's findings array since
 * ReviewRecord does not carry a pre-built breakdown field.
 */
export function conciseReviewSummary(reviews: ReviewRecord[]): ConciseReviewEntry[] {
  return reviews.map((r) => ({
    agent_name: r.agent_name ?? null,
    verdict: r.verdict,
    score: r.score,
    findings_breakdown: computeBreakdown(r.findings),
  }));
}

// ---------------------------------------------------------------------------
// Detailed review summary
// ---------------------------------------------------------------------------

/** Per-agent detailed entry: concise shape + top paginated findings. */
export type DetailedReviewEntry = ConciseReviewEntry & {
  top_findings: FindingRecord[];
};

/** Detailed summary result: agents + pagination metadata across all findings. */
export type DetailedReviewSummary = {
  agents: DetailedReviewEntry[];
  has_more: boolean;
  total_findings: number;
};

/**
 * Returns a per-review concise shape plus top_findings paginated by limit.
 * has_more and total_findings are computed across all findings from all reviews.
 */
export function detailedReviewSummary(
  reviews: ReviewRecord[],
  limit = 20,
): DetailedReviewSummary {
  const effectiveLimit = Math.min(limit, 50);

  // Compute total findings across all reviews for pagination metadata.
  const total_findings = reviews.reduce((sum, r) => sum + r.findings.length, 0);

  // Distribute the effective limit proportionally per review.
  // Simpler approach: sort all findings and paginate globally, then assign back.
  // The plan asks for top_findings per agent (paginated by limit).
  // We interpret limit as the total cap across all agents combined.
  const allSorted: Array<{ reviewIdx: number; finding: FindingRecord }> =
    reviews.flatMap((r, idx) =>
      r.findings.map((f) => ({ reviewIdx: idx, finding: f })),
    );

  allSorted.sort((a, b) => {
    const orderA = SEVERITY_ORDER[a.finding.severity] ?? 3;
    const orderB = SEVERITY_ORDER[b.finding.severity] ?? 3;
    return orderA - orderB;
  });

  // Build per-review finding buckets up to the global limit.
  const perReview: FindingRecord[][] = reviews.map(() => []);
  let remaining = effectiveLimit;
  for (const { reviewIdx, finding } of allSorted) {
    if (remaining <= 0) break;
    const bucket = perReview[reviewIdx];
    if (bucket !== undefined) {
      bucket.push(finding);
      remaining--;
    }
  }

  const has_more = total_findings > effectiveLimit;

  const agents: DetailedReviewEntry[] = reviews.map((r, idx) => ({
    agent_name: r.agent_name ?? null,
    verdict: r.verdict,
    score: r.score,
    findings_breakdown: computeBreakdown(r.findings),
    top_findings: perReview[idx] ?? [],
  }));

  return { agents, has_more, total_findings };
}
