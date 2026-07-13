/**
 * Review module constants.
 */

/**
 * Studio review strategy. 'single-pass' = send the WHOLE diff in ONE LLM call.
 * We deliberately do NOT use 'auto'/map-reduce by default: map-reduce makes one
 * call PER FILE, which is slow and fragile (any single file's transient 5xx
 * fails the entire run) and unnecessary — the whole diff already fits the
 * model's context.
 */
export const REVIEW_STRATEGY = 'single-pass' as const;

// ---------------------------------------------------------------------------
// PR Why + Risk Brief (Step 4/5) — LLM-facing structured-output schema.
//
// Relocated to `platform/risk-brief.ts` (module-isolation fix, R6): the
// `eval` module also needs this schema/function and could not reach into
// `modules/reviews` for it. Re-exported here so existing `reviews/*` imports
// of `RiskBriefLlmResult` from this file keep working without a rename.
// ---------------------------------------------------------------------------

export { RiskBriefLlmResult } from '../../platform/risk-brief.js';

// ---------------------------------------------------------------------------
// Step 5 additions — rate limit for the explicit generate/regenerate route,
// and a re-export of the single source of truth for the input token budget
// (defined in `brief-generator-helpers.ts` — Step 3 — never duplicated here
// as a second literal).
// ---------------------------------------------------------------------------

export const BRIEF_GENERATE_RATE_LIMIT = { max: 3, timeWindow: '1 minute' } as const;

export { BRIEF_INPUT_TOKEN_BUDGET } from './brief-generator-helpers.js';

// ---------------------------------------------------------------------------
// Multi-Agent Review (plan Step 4) — concurrency cap for the fan-out worker
// pool (mirrors `review-all`'s existing `CONCURRENCY = 3` literal in
// `routes.ts`) and the rate limit for the trigger route (mirrors the existing
// `/pulls/:id/review` route's inline `{ max: 10, timeWindow: '1 minute' }`).
// ---------------------------------------------------------------------------

export const MULTI_AGENT_CONCURRENCY_CAP = 3;

export const MULTI_AGENT_RUN_RATE_LIMIT = { max: 10, timeWindow: '1 minute' } as const;
