/**
 * Risk-brief narrative generation — the ONE structured LLM call of the PR
 * Why + Risk Brief pipeline (`modules/reviews/brief-generator.ts`), plus its
 * LLM-facing structured-output schema (`RiskBriefLlmResult`).
 *
 * Platform-layer copy: this file lives in `platform/` (not `modules/reviews/`)
 * so that other modules (`reviews`, `eval`) can consume it without a forbidden
 * `modules/*` → `modules/reviews` cross-import (R6, see
 * `server/src/modules/AGENTS.md`). `platform/` is the composition/platform
 * layer — mirrors `platform/feature-models.ts`'s identical rationale for
 * relocating `resolveFeatureModel`/`getFeatureModelOverride` out of a single
 * module so `reviews`/`onboarding` could both reach it. This file must NOT
 * import from any `modules/*` path — only `@devdigest/shared`,
 * `@devdigest/reviewer-core`, and other `platform/*` files.
 */
import { z } from 'zod';
import { RiskLevel, RiskSeverity, type LLMProvider, type StructuredResult } from '@devdigest/shared';

// ---------------------------------------------------------------------------
// PR Why + Risk Brief — LLM-facing structured-output schema.
//
// Narrower than the full `LlmBrief`/`Risk` shared types (co-located here per
// `onboarding/constants.ts`'s precedent of keeping a module's LLM schema next
// to its other constants). NO `github_link` field on either `risks[]` or
// `review_focus[]` entries — that is computed server-side, post-validation,
// by `BriefGeneratorService` via `buildGithubBlobLink`.
// ---------------------------------------------------------------------------

const RiskBriefLlmRisk = z.object({
  title: z.string(),
  explanation: z.string(),
  severity: RiskSeverity,
  kind: z.string(),
  file: z.string().nullish(),
  line: z.number().int().nullish(),
  endpoint: z.string().nullish(),
  symbol: z.string().nullish(),
});

const RiskBriefLlmReviewFocusItem = z.object({
  path: z.string(),
  line: z.number().int().nullish(),
  reason: z.string(),
  priority: z.number().int(),
});

export const RiskBriefLlmResult = z.object({
  what: z.string(),
  why: z.string(),
  risk_level: RiskLevel,
  risks: z.array(RiskBriefLlmRisk),
  review_focus: z.array(RiskBriefLlmReviewFocusItem),
});
export type RiskBriefLlmResult = z.infer<typeof RiskBriefLlmResult>;

/**
 * The ONE structured LLM call of the risk-brief pipeline, extracted as a pure
 * function so both `reviews/brief-generator.ts` (production) and
 * `eval/run-orchestrator.ts` (eval path, `risk_brief_narrative`-kind cases)
 * can invoke the exact same generation logic. Deliberately does NOT catch/wrap
 * errors — the raw throw must reach the caller so each consumer applies its
 * own error-handling policy.
 */
export async function generateRiskBriefNarrative(
  llm: LLMProvider,
  model: string,
  systemPrompt: string,
  input: string,
): Promise<StructuredResult<RiskBriefLlmResult>> {
  return llm.completeStructured({
    model,
    schema: RiskBriefLlmResult,
    schemaName: 'RiskBriefLlmResult',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: input },
    ],
  });
}
