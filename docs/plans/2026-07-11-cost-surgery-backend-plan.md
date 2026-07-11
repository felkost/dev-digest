# Development Plan: Cost Surgery — Backend/Engine

**Date:** 2026-07-11
**Requirements:** [docs/feature-requirements/2026-07-11-cost-surgery-backend.md](../feature-requirements/2026-07-11-cost-surgery-backend.md) (Status: approved, amended 2026-07-11 post architecture-review — §13 is binding)
**Execution mode:** multi-agent
**Scope:** server / reviewer-core / agent-runner (backend & engine only — no client)
**Affects modules:** `reviewer-core/src/{tokens.ts,review/*}`, `server/src/platform/`, `server/src/modules/reviews/`, `server/src/modules/eval/`, `server/src/modules/settings/` (one file removed), `server/src/adapters/llm/`, `server/src/db/`, `server/src/vendor/shared/`, `agent-runner/src/`

---

## 1. Context

DevDigest's review engine burns LLM budget in three measurable, fixable ways: (1) no per-prompt-block token visibility and no captured cache signal, even though the provider already reports both; (2) intent classification is cheap-tier but the risk-brief narrative is not, and a visible "review intent" override control in Settings does nothing; (3) boilerplate files (lock files, generated/minified code) are only trimmed once a diff already exceeds budget, and map-reduce chunks one LLM call per file regardless of how small each file is. This spec instruments, routes, and filters all three — as **data**, not dashboards (Spec B, later, builds the UI) — and, because `reviewer-core` is shared unmodified between the studio and the CI runner (`agent-runner`), every fix must reach both.

An architecture review of the approved spec (§13) found that three of the original ACs described the right *observable outcome* ("one shared implementation, not two-by-convention") without pinning *where* that implementation must live — leaving room for a plan that quietly grows a second, CI-only copy. This plan encodes the amendment's three structural resolutions directly into file ownership: the token counter and the boilerplate classifier become **reviewer-core exports** (the same pattern `OpenRouterProvider` already established), and feature-model override resolution moves to **`platform/`** (the same layer that already owns `routeModel`), closing the `reviews`→`settings` cross-module import instead of adding a second one.

## 2. Architecture Fit

**reviewer-core (`@devdigest/reviewer-core`)** gains four small, pure, zero-I/O modules — `src/tokens.ts` (the canonical token counter, injected everywhere as a plain function, never assumed), `src/review/classify.ts` (boilerplate/core/wiring classification, relocated verbatim from the server), `src/review/boilerplate.ts` (pre-assembly exclusion, built on the already-exported `sliceDiff`), and `src/review/token-report.ts` (per-block token breakdown over an already-built `PromptAssembly`). `src/review/run.ts`'s `selectMode` and the map-reduce chunk-builder take an *optional* injected `countTokens` — omitted, they preserve today's line-count behavior exactly (so the existing hermetic suite needs zero changes); supplied (by both real consumers), they switch to token-threshold, bin-packed chunking. All four new modules are exported from `src/index.ts` alongside the existing `OpenRouterProvider` — the codebase's own precedent for "one implementation both `server` and `agent-runner` consume."

**server** gets one new platform-layer file, `platform/feature-models.ts` — the relocated `resolveFeatureModel`/`getFeatureModelOverride` plus a new `resolveRoutedFeatureModel`, which layers `routeModel`'s cheap-tier default under the existing override mechanism. This closes the `reviews → settings` cross-module import (R6) instead of extending it: `reviews/brief-generator.ts` and `reviews/routes.ts`/`helpers.ts` both import from `platform/`, never from `modules/settings/` again. `container.ts`'s `tokenizer` getter is re-pointed at reviewer-core's exported counter (deleting the server-local duplicate). `run-executor.ts` and `agent-runner/src/run.ts` each get one consolidated wiring pass (boilerplate exclusion → existing `budgetDiff` → `reviewPullRequest` with `countTokens` injected → per-block/cache/exclusion trace fields) so no workstream leaves either file in a half-wired state.

**Data:** all WS1/WS2/WS4 facts are additive fields on the existing `RunTrace`/`CiResultArtifact`/`StructuredResult` shared contracts (JSONB `run_traces.trace` for the studio, the `devdigest-result.json` artifact for CI) — no new table, no migration. WS6 is the one genuine schema change: two new nullable/defaulted columns on `eval_cases` (`case_kind`, `passing_threshold`) via a new forward-only migration `0026`.

```
reviewer-core/src/
├── tokens.ts                 [NEW] countTokens, TokenCounter  ── canonical, WS1/WS5
├── review/
│   ├── classify.ts           [NEW] classifyFile (relocated)   ── canonical, WS4
│   ├── boilerplate.ts        [NEW] excludeBoilerplateFiles    ── WS4
│   ├── token-report.ts       [NEW] countPromptAssemblyBlocks  ── WS1
│   ├── run.ts                [EDIT] selectMode + chunk bin-pack + cache accumulation ── WS2/WS5
│   └── reduce.ts             (unchanged; sliceDiff reused by boilerplate.ts)
├── llm/openrouter.ts         [EDIT] cachedTokens extraction   ── WS2
└── index.ts                  [EDIT] barrel exports

server/src/
├── platform/
│   ├── feature-models.ts     [NEW] relocated + resolveRoutedFeatureModel ── WS3
│   ├── model-router.ts       (unchanged; routeModel's override param finally used)
│   └── container.ts          [EDIT] tokenizer ← reviewer-core's countTokens ── WS1
├── adapters/
│   ├── tokenizer/index.ts    [DELETE] superseded by reviewer-core/src/tokens.ts
│   └── llm/anthropic.ts      [EDIT] cache_control + cachedTokens ── WS2
├── modules/
│   ├── settings/feature-models.ts [DELETE, once its last consumer moves off it]
│   ├── reviews/
│   │   ├── run-executor.ts   [EDIT] consolidated WS1/2/3/4/5 studio wiring
│   │   ├── routes.ts         [EDIT] intent via resolveIntentModel ── WS3
│   │   ├── helpers.ts        [EDIT] + resolveIntentModel
│   │   ├── brief-generator.ts[EDIT] cheap-tier risk-brief + extracted narrative helper ── WS3
│   │   └── smart-diff-rules.ts [DELETE] superseded by reviewer-core/review/classify.ts
│   └── eval/
│       ├── scoring.ts        [EDIT] + scoreIntentCase/scoreRiskBriefCase ── WS6
│       └── run-orchestrator.ts [EDIT] case_kind branching ── WS6
└── db/
    ├── schema/eval.ts        [EDIT] case_kind, passing_threshold
    └── migrations/0026_eval_case_kind.sql [NEW]

agent-runner/src/
├── run.ts                    [EDIT] boilerplate exclusion + countTokens injection ── CI parity
└── artifact.ts                [EDIT] cost/cache/exclusion fields into CiResultArtifact
```

## 3. Skills & Patterns Applied

**`backend-onion-architecture`:**
- R6 (module import isolation) is the direct driver of WS3's design: `reviews/brief-generator.ts` currently imports `modules/settings/feature-models.ts` (a forbidden cross-module import already in the codebase, mirrored a second time by `onboarding/service.ts`). Both are re-pointed at `platform/feature-models.ts` — the sanctioned "container/platform" route, never a second module-to-module import.
- AP-4 (cross-module internal import): the fix pattern here is "extract to `platform/`", exactly as the anti-pattern catalog prescribes.
- Composition root discipline: `container.ts` remains the only place a concrete reviewer-core implementation (`OpenRouterProvider`, now also `countTokens`) is instantiated/wired.

**`typescript-expert`:**
- Every new/changed exported field across `reviewer-core`, `server/src/vendor/shared/`, and `agent-runner` is additive (optional/nullish) — old callers, old tests, and old persisted JSONB documents all keep parsing (`.nullish()` over `.nullable()` for a key that may not exist at all in old documents, per the project's own documented JSONB-parsing quirk).
- `ReviewInput.countTokens?: TokenCounter` is a classic optional-injected-dependency pattern: the function's own default behavior (undefined → old code path) is a compile-time-checked branch, not a runtime guess.

**`zod`:**
- `EvalCaseKind` is a `z.enum` (fixed, small, stable set) — not a free-text field — per `schema-use-enums`.
- All new fields on `RunTrace`, `StructuredResult`, `CiResultArtifact`, `EvalCaseCreateInput` use `.nullish()`/`.optional()`/`.default()` correctly distinguished by whether the *key* can be absent from old data (`.nullish()`) vs. the *value* is a genuine business null (`.nullable()`) vs. a client-omittable input with a server default (`.default()`).

**`fastify-best-practices`:**
- `routes.ts` stays thin: the WS3 consolidation moves the intent-model resolution logic into `reviews/helpers.ts` (a plain function), not the route handler.

**`drizzle-orm-patterns` / `postgresql-table-design`:**
- Two new columns, both defaulted/nullable — zero-downtime additive migration, no table rewrite trigger (no volatile default), no index needed (neither column is a query filter/join key in this spec's scope).
- `insertCase(data: EvalCaseInsert)` already accepts the full generic Drizzle insert type — the new columns need no repository signature change (confirmed against the project's own documented pattern for this exact scenario).

## 4. Project Constraints

- **Secrets** — no new secret, no new `process.env` read outside `agent-runner`'s already-documented CI-env exception. Anthropic/OpenRouter adapter changes read only the existing injected API key.
- **`server/src/vendor/shared/`** — additive-only for this plan: new optional/nullish fields on `RunTrace`, `StructuredResult`, `CiResultArtifact`, `EvalCaseCreateInput`, `EvalCaseListItem`, plus one new `EvalCaseKind` enum export. No rename, no removal, no required-field addition (which would break existing fixtures per the documented 2026-06-30 Mistake entry). `client/src/vendor/shared/` is **not** touched — no client code reads any of these new fields yet (verified by grep in Step 2), so no mirror is needed for this spec.
- **`server/src/db/migrations/`** — exactly one new forward-only migration (`0026_eval_case_kind.sql`); no applied migration is edited. `pnpm db:generate` must report "No schema changes" on a second run after the rename, per the project's documented snapshot-naming gotcha (tag renamed in `_journal.json`, `meta/NNNN_snapshot.json` left numeric).
- **`reviewer-core/src/grounding.ts`** — untouched. No workstream in this spec touches citation grounding.
- **reviewer-core zero-I/O** — `tokens.ts`, `review/classify.ts`, `review/boilerplate.ts`, `review/token-report.ts` are all pure functions: no DB, no file reads, no `process.env`. `countTokens`'s `js-tiktoken` encoder is a pure in-memory computation, not I/O.
- **Adapters only via Container** — `container.tokenizer` remains the sole server-side access point; services never import `@devdigest/reviewer-core`'s `countTokens` directly except inside `container.ts` itself (mirrors the existing `OpenRouterProvider` rule).
- **`AppError` for expected failures** — unchanged; no new route in this spec (WS6's case creation reuses the existing `POST /agents/:id/evals` route and its existing `ValidationError` conventions).
- **`workspace_id` scoping** — `resolveRoutedFeatureModel`/`getFeatureModelOverride` already scope by `workspaceId` (moved verbatim); the new `eval_cases` columns ride on every existing workspace-scoped query with no new query added.
- **Cross-package impact (reviewer-core insight, 2026-07-09)** — every reviewer-core-touching step's Verify checklist includes `cd agent-runner && pnpm typecheck` (and `pnpm test` where relevant): a green `server` suite does **not** prove `agent-runner` still compiles.
- **agent-runner's documented CI-env exception** — Step 11 reads no new secret; it only consumes reviewer-core's new pure exports the same way it already consumes `OpenRouterProvider`.
- **No per-agent map-reduce threshold override** — `DEFAULT_MAP_THRESHOLD_TOKENS` is a single centrally shared constant (AC-23); `AgentManifest` gets no new field.
- **No new persistent token/cache/exclusion analytics table** — CI's per-run data lives only in the `devdigest-result.json` artifact (mirroring the studio's `run_traces.trace`), never in `ci_runs`.

## 5. Implementation Steps

**Parallelization map:**
```
Wave 1 (4 parallel, no dependencies):
  Step 1  reviewer-core foundation exports (tokens/classify/boilerplate/token-report)
  Step 2  shared contracts — additive fields (trace.ts, adapters.ts, eval-ci.ts)
  Step 3  WS6 schema + migration 0026 + eval-batch.ts contracts
  Step 4  platform/feature-models.ts + resolveRoutedFeatureModel + onboarding import fix

Wave 2 (5 parallel, each depends on specific Wave-1 steps):
  Step 5  reviewer-core run.ts — token-budget map-reduce + cache accumulation   [needs 1, 2]
  Step 6  LLM adapters — anthropic.ts cache_control + openrouter.ts cachedTokens [needs 2]
  Step 7  container.ts tokenizer swap + delete adapters/tokenizer/index.ts      [needs 1]
  Step 8  reviews/routes.ts + helpers.ts — intent-model consolidation           [needs 4]
  Step 9  reviews/brief-generator.ts — cheap-tier routing + narrative extraction [needs 4]

Wave 3 (3 parallel, each depends on specific Wave-2 steps):
  Step 10 run-executor.ts — consolidated studio wiring          [needs 1,2,5,6,7,8]
  Step 11 agent-runner CI parity                                 [needs 1,2,5,6]
  Step 12 eval module — WS6 orchestrator                         [needs 3,4,9]
```
No two steps in the same wave touch the same file. Every `reviews`-module edit for run-executor.ts is consolidated into Step 10 alone; every `agent-runner/src/run.ts` edit is consolidated into Step 11 alone — no workstream gets its own separate touch to either file.

---

### Step 1: reviewer-core — token counter, boilerplate classifier, per-block token report (WS1/WS4 foundation)

**Dependencies:** none
**Owned paths:** `reviewer-core/src/tokens.ts` [new], `reviewer-core/src/review/classify.ts` [new], `reviewer-core/src/review/boilerplate.ts` [new], `reviewer-core/src/review/token-report.ts` [new], `reviewer-core/src/index.ts` [edit], `reviewer-core/package.json` [edit], `reviewer-core/test/tokens.test.ts` [new], `reviewer-core/test/classify.test.ts` [new], `reviewer-core/test/boilerplate.test.ts` [new], `reviewer-core/test/token-report.test.ts` [new]

**What to do:**
1. Add `"js-tiktoken": "^1.0.21"` to `reviewer-core/package.json` dependencies (matches `server/package.json`'s pinned version); run `pnpm install` inside `reviewer-core/`.
2. Create `reviewer-core/src/tokens.ts`: `export type TokenCounter = (text: string) => number;` and `export const countTokens: TokenCounter = ...` — a lazily-initialized `js-tiktoken` `cl100k_base` encoder, falling back permanently to `Math.ceil(text.length / 4)` on first encoder failure. This is a byte-for-byte behavioral port of `server/src/adapters/tokenizer/index.ts`'s `TiktokenTokenizer`/`approxTokens` — same fallback semantics, now the single canonical implementation per §13's amendment. Zero I/O, zero env reads.
3. Create `reviewer-core/src/review/classify.ts`: move `LOCK_FILE_NAMES`, `BOILERPLATE_EXTENSIONS`, `ROLE_PATTERNS`, `classifyFile` **verbatim** from `server/src/modules/reviews/smart-diff-rules.ts` — a relocation, not a rewrite. AC-18's Dockerfile/`.github/workflows/`/`.env.example` exception must classify identically to today.
4. Create `reviewer-core/src/review/boilerplate.ts`: `export function excludeBoilerplateFiles(diff: UnifiedDiff, countTokens?: TokenCounter): { diff: UnifiedDiff; excludedFiles: string[]; excludedTokensEstimate: number }`. Partition `diff.files` via `classifyFile(f.path)` into kept (non-boilerplate) and excluded (boilerplate). Rebuild `raw` by joining `sliceDiff(diff, f.path)` (already exported from `./reduce.js`) for each kept file, preserving original diff order. `excludedTokensEstimate` sums `(countTokens ?? the same char/4 fallback tokens.ts uses)(sliceDiff(diff, f.path))` over excluded files. Zero boilerplate matches → return the **original** `diff` object unchanged, `excludedFiles: []`, `excludedTokensEstimate: 0` (AC-17's always-present zero-count case — never omitted).
5. Create `reviewer-core/src/review/token-report.ts`: `export function countPromptAssemblyBlocks(assembly: PromptAssembly, countTokens: TokenCounter): { block: string; tokens: number | 'unavailable' }[]`. Iterate the named slots in a fixed order — `system`, `skills`, `memory`, `specs`, `callers`, `repo_map`, `pr_description`, `user`. A slot whose value is null/undefined is **omitted entirely** from the result (AC-1's "not folded into one total" plus the §9 contract's "a block missing from the list means that slot was not part of this run's prompt" — distinct from `'unavailable'`, which means the slot WAS present but counting on it threw). A present slot's `countTokens(text)` call is wrapped in try/catch; on throw, emit `'unavailable'` for that slot only (AC-4) — this function itself must never throw.
6. Export everything from `reviewer-core/src/index.ts`, following the existing barrel/doc-comment convention (see the `OpenRouterProvider` export block): `countTokens`/`TokenCounter` from `./tokens.js`; `classifyFile`/`LOCK_FILE_NAMES`/`BOILERPLATE_EXTENSIONS`/`ROLE_PATTERNS` from `./review/classify.js`; `excludeBoilerplateFiles` from `./review/boilerplate.js`; `countPromptAssemblyBlocks` from `./review/token-report.js`. Add a doc comment naming these as the canonical, single-sourced implementations per §13.
7. Tests: `tokens.test.ts` (non-empty text → positive integer; empty string → 0). `classify.test.ts` (port every case from `server/test/smart-diff-rules.test.ts` verbatim, including the AC-18 Dockerfile/workflow/`.env.example` exceptions). `boilerplate.test.ts` (mixed core+lock-file diff excludes only the lock file, preserves order; zero-boilerplate diff returns the original diff object with an empty array — AC-17; **AC-20's designated fixture** — a synthetic large multi-file diff containing one large lock-file-style change, asserting and recording in the test both the raw and post-exclusion token counts via a stubbed counter, so the reduction is a concrete asserted number). `token-report.test.ts` (full assembly → 8 ordered entries; partial assembly omits absent slots entirely, not as zero/unavailable; a counter that throws for one slot yields `'unavailable'` for that slot only, function doesn't throw).

**Verify:**
- [ ] `cd reviewer-core && pnpm typecheck`
- [ ] `cd reviewer-core && pnpm test`
- [ ] `cd agent-runner && pnpm typecheck` (confirms the new exports don't break agent-runner's raw-source consumption)
- [ ] AC-18 exception cases pass; AC-17's zero-count case returns an empty array, never omitted

**Commit:** `feat(reviewer-core): add canonical token counter, boilerplate classifier, and per-block token report (WS1/WS4 foundation)`

---

### Step 2: shared contracts — additive fields for token/cache/exclusion data (WS1, WS2, WS4-CI)

**Dependencies:** none
**Owned paths:** `server/src/vendor/shared/contracts/trace.ts`, `server/src/vendor/shared/adapters.ts`, `server/src/vendor/shared/contracts/eval-ci.ts`

**What to do:**
1. `contracts/trace.ts`: add `BlockTokenCount = z.object({ block: z.string(), tokens: z.union([z.number().int(), z.literal('unavailable')]) })` and `RunTraceCostReport = z.object({ block_token_counts: z.array(BlockTokenCount), cached_input_tokens: z.number().int().nullable(), cache_control_applied: z.boolean(), excluded_boilerplate_files: z.array(z.string()), excluded_boilerplate_tokens: z.number().int(), map_reduce_threshold_tokens: z.number().int().nullable(), map_reduce_chunk_count: z.number().int() })`. Add `cost_report: RunTraceCostReport.nullish()` to `RunTrace` — `.nullish()` (not `.nullable()`) because old persisted JSONB documents omit the key entirely, matching the project's own documented JSONB-parsing quirk (2026-06-26).
2. `adapters.ts`: add `cachedTokens?: number | null` and `cacheControlApplied?: boolean` to `StructuredResult<T>` — additive optional fields; every existing implementer of the interface remains valid unmodified.
3. `contracts/eval-ci.ts`: add the same seven fields to `CiResultArtifact`, all `.nullish()`. This is CI's durable per-run record (mirrors `run_traces.cost_report` for the studio); it is **not** also added to `ci_runs`/the DB (no new aggregation table, per the spec's own Non-goal).
4. Do not touch `client/src/vendor/shared/` — confirm with `grep -rn "cost_report\|cachedTokens\|cacheControlApplied" client/src` returning nothing before finishing.

**Verify:**
- [ ] `cd server && pnpm typecheck`
- [ ] `cd server && pnpm exec vitest run --exclude '**/*.it.test.ts' test/contracts.test.ts` (new fields are optional/nullish — no fixture update required)
- [ ] `cd agent-runner && pnpm typecheck` (resolves `@devdigest/shared` to this same file via its own alias)
- [ ] `grep -rn "cost_report\|cachedTokens\|cacheControlApplied" client/src` returns nothing

**Commit:** `feat(shared): additive RunTrace/StructuredResult/CiResultArtifact fields for token, cache, and boilerplate-exclusion data`

---

### Step 3: WS6 schema + migration 0026 + eval-batch.ts contracts

**Dependencies:** none
**Owned paths:** `server/src/db/schema/eval.ts`, `server/src/db/migrations/0026_eval_case_kind.sql` [new], `server/src/db/migrations/meta/*` [new snapshot + journal entry], `server/src/vendor/shared/contracts/eval-batch.ts`

**What to do:**
1. `db/schema/eval.ts`: add two columns to `evalCases`: `caseKind: text('case_kind', { enum: ['review_finding', 'intent', 'risk_brief_narrative'] }).notNull().default('review_finding')` and `passingThreshold: doublePrecision('passing_threshold')` (nullable — per-case editable per §13 clarification #3; `null` means "use the kind's built-in default threshold," resolved at the service/scoring layer, not the DB).
2. Run `pnpm db:generate` from `server/`. Verify the emitted SQL contains only the two `ALTER TABLE eval_cases ADD COLUMN ...` statements. Rename the generated `.sql` to `0026_eval_case_kind.sql` and update the matching `meta/_journal.json` entry's `tag` field — do **not** rename `meta/NNNN_snapshot.json` (stays numeric-only, per the documented drizzle-kit renaming gotcha).
3. `contracts/eval-batch.ts`: add `export const EvalCaseKind = z.enum(['review_finding', 'intent', 'risk_brief_narrative']);` + inferred type. Add `case_kind: EvalCaseKind.default('review_finding')` and `passing_threshold: z.number().min(0).max(1).nullish()` to `EvalCaseCreateInput`. Add `case_kind: EvalCaseKind` and `passing_threshold: z.number().min(0).max(1).nullable()` to `EvalCaseListItem`. Document above `EvalCaseCreateInput`, in a comment, that `expected_output` is **reused** with a per-`case_kind` shape: `Expectation[]` for `'review_finding'` (unchanged), `{ in_scope: string[]; out_of_scope: string[] }` for `'intent'`, `{ key_points: string[] }` for `'risk_brief_narrative'` — the concrete realization of the spec's §9 conceptual `expected_intent_summary`/`expected_risk_brief_keypoints` fields, chosen to avoid two additional columns.
4. Do not touch `client/src/vendor/shared/contracts/eval-batch.ts` — Spec B (UI) owns mirroring this; no client code reads these fields yet.

**Verify:**
- [ ] `cd server && pnpm db:migrate` against the dev DB succeeds; every existing row backfills to `case_kind='review_finding'`
- [ ] A second `pnpm db:generate` reports "No schema changes" (confirms the renamed snapshot chain is intact)
- [ ] `cd server && pnpm typecheck`
- [ ] Existing eval-cases/eval-routes hermetic tests pass unmodified

**Commit:** `feat(server): add eval_cases.case_kind + passing_threshold (migration 0026) for intent/risk-brief eval cases (WS6)`

---

### Step 4: platform/feature-models.ts + resolveRoutedFeatureModel + onboarding import fix (WS3 foundation)

**Dependencies:** none
**Owned paths:** `server/src/platform/feature-models.ts` [new], `server/src/modules/onboarding/service.ts` [import path only], `server/test/settings-models.it.test.ts` [import path + new test cases]

**What to do:**
1. Create `server/src/platform/feature-models.ts`: move `DEFAULTS`, `defaultFeatureModel`, `getFeatureModelOverride`, `resolveFeatureModel` **verbatim** from `server/src/modules/settings/feature-models.ts` (same logic, same `container.db.select({key,value}).from(t.settings)...` shape). This is a platform-layer file — same layer as `model-router.ts` — so it may read `container.db` and `db/schema.js` directly, consistent with `platform/container.ts` already doing so.
2. In the same file, add:
   ```
   resolveRoutedFeatureModel(
     container: Container,
     workspaceId: string,
     featureModelId: FeatureModelId,
     task: TaskKind,
     provider: Provider,
   ): Promise<FeatureModelChoice>
   ```
   Logic: `getFeatureModelOverride(...)` first — if present, return it **verbatim**, ignoring the caller-supplied `provider` entirely (AC-13, an explicit override always wins). If absent, return `{ provider, model: routeModel(task, provider) }` using the **caller-supplied** `provider` (this is the critical design point: it preserves today's contextual provider selection at both call sites — `run-executor.ts` picks a provider from the queued agent, `brief-generator.ts` picks the registry default provider — rather than silently switching either to a fixed registry provider). Import `routeModel`/`TaskKind`/`Provider` from `./model-router.js` (same layer, no cross-module issue). This one function is the sole place `review_intent` (`task:'intent'`) and `risk_brief` (`task:'summary'`) resolution flows through — AC-14 holds by construction, since no other `FeatureModelId` calls it.
3. Do **not** delete `server/src/modules/settings/feature-models.ts` yet — `reviews/brief-generator.ts` still imports from it until Step 9 removes that import. Deleting it now would leave the repo non-compiling between this step's commit and Step 9's.
4. Update `server/src/modules/onboarding/service.ts`'s import from `'../settings/feature-models.js'` to `'../../platform/feature-models.js'` — no other change (onboarding keeps calling plain `resolveFeatureModel`, unaffected by cheap-tier routing per AC-14).
5. Update `server/test/settings-models.it.test.ts`'s import from `'../src/modules/settings/feature-models.js'` to `'../src/platform/feature-models.js'` (it tests `resolveFeatureModel`/`getFeatureModelOverride` directly — their behavior is unchanged, only their location moved). Add new integration test cases for `resolveRoutedFeatureModel`: no override → cheap-tier model for the given provider (AC-11 style); an active `review_intent`/`risk_brief` override in `settings.feature_models` → the override's provider+model, ignoring the passed-in provider (AC-13).

**Verify:**
- [ ] `cd server && pnpm typecheck`
- [ ] `cd server && pnpm exec vitest run --exclude '**/*.it.test.ts' test/onboarding-service.test.ts test/onboarding-routes.test.ts` (pass unmodified — only the import path moved)
- [ ] `settings-models.it.test.ts` (integration, needs Docker) passes with both the relocated assertions and the new `resolveRoutedFeatureModel` cases
- [ ] `server/src/modules/settings/feature-models.ts` still exists and is unmodified (brief-generator.ts's dependency until Step 9)

**Commit:** `refactor(server): relocate feature-model override resolution to platform/ and add cheap-tier-aware resolveRoutedFeatureModel (WS3 foundation)`

---

### Step 5: reviewer-core — token-budget map-reduce + cache accumulation in the engine (WS2, WS5)

**Dependencies:** Step 1, Step 2
**Owned paths:** `reviewer-core/src/review/run.ts`, `reviewer-core/src/index.ts` [add one export line], `reviewer-core/test/run.test.ts` [extend]

**What to do:**
1. `ReviewInput`: add `countTokens?: TokenCounter` (from `../tokens.js`) and `mapThresholdTokens?: number` (override, mirrors the existing `mapThresholdLines` pattern). Document: omitting `countTokens` preserves every existing behavior (line-count `selectMode`, one-chunk-per-file map-reduce) byte-for-byte — the backward-compatibility guarantee the spec's §7 Non-functional requires for the existing hermetic suite.
2. Add `export const DEFAULT_MAP_THRESHOLD_TOKENS = 6000;` beside the existing `DEFAULT_MAP_THRESHOLD_LINES = 400`, with a comment marking it as a seed value validated by the AC-20/AC-22 fixture measurements, not a number the spec itself pins.
3. Rewrite `selectMode`: when `countTokens` is provided, ignore line-counting for the `'auto'` branch — compute `totalTokens = countTokens(diff.raw)`, return `'map-reduce'` when `totalTokens > (input.mapThresholdTokens ?? DEFAULT_MAP_THRESHOLD_TOKENS) && diff.files.length > 1`, else `'single-pass'` (AC-21). Explicit `'single-pass'`/`'map-reduce'` strategy overrides are unchanged — AC-21 only reshapes the `'auto'` threshold decision.
4. Rewrite the map-reduce chunk-building step: when `countTokens` is provided and mode is `'map-reduce'`, replace the one-file-per-chunk mapping with a greedy bin-packer — iterate `diff.files` in order, accumulate into a "current chunk" while adding the next file stays within threshold; close and start a new chunk when it would exceed threshold; a file whose own tokens already exceed the threshold is flushed immediately as its own one-file chunk (AC-25 — never split, never dropped). Each chunk's `label` becomes its member file paths joined (e.g. `"a.ts, b.ts"`). When `countTokens` is omitted, keep the existing one-file-per-chunk behavior unchanged.
5. `ReviewOutcome`: add `cachedInputTokens: number | null`, `cacheControlApplied: boolean`, `mapReduceThresholdTokens: number | null` (the resolved threshold actually used — `null` when `countTokens` wasn't injected), `mapReduceChunkCount: number` (`chunks.length`; `1` for single-pass, matching §9's contract). Accumulate `cachedInputTokens` across the completion loop exactly like `tokensIn`/`tokensOut` today (sum when every chunk reports a number; `null` propagates as soon as any chunk reports `null`/`undefined` — same null-propagation style already used for `costUsd`). Accumulate `cacheControlApplied` as OR across chunks (`res.cacheControlApplied === true` on ANY chunk → `true`).
6. Extend `run.test.ts`: (a) `countTokens` omitted → identical mode/chunk-count to pre-this-step fixtures (regression guard for the Non-functional's backward-compat requirement — **this is the check the coordinator specifically called out**); (b) many small files under threshold + `countTokens` injected → fewer chunks than files (AC-22); (c) one file whose own tokens exceed threshold gets its own chunk even inside a bin-packed run (AC-25); (d) mocked `completeStructured` returning `cachedTokens: 120` on one chunk and `undefined` on another → `cachedInputTokens === null`; all chunks reporting `cachedTokens: 80` → `cachedInputTokens === 160`.

**Verify:**
- [ ] `cd reviewer-core && pnpm typecheck && pnpm test`
- [ ] Every pre-existing `run.test.ts` assertion passes with **zero modification** — only new cases were added (explicit confirmation of the Non-functional §7 constraint)
- [ ] `cd agent-runner && pnpm typecheck`

**Commit:** `feat(reviewer-core): token-budget map-reduce with bin-packing + cache/chunk-count accumulation in reviewPullRequest (WS2/WS5 engine core)`

---

### Step 6: LLM adapters — Anthropic cache_control + cached-token extraction (WS2)

**Dependencies:** Step 2
**Owned paths:** `server/src/adapters/llm/anthropic.ts`, `reviewer-core/src/llm/openrouter.ts`, existing adapter test files for both [extend]

**What to do:**
1. `anthropic.ts`'s `completeStructured` only (leave `doComplete`/`complete` untouched — only structured calls sit on the review/intent/risk-brief path): change the `system` param from a plain string to the content-block array form so the shared prefix is marked cacheable: `system: system ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : undefined` — apply inside the `createMessage` wrapper call too, including its retry path. Verify the installed `@anthropic-ai/sdk` version's system-param type accepts this shape; if the SDK names the block/cache-control type differently, adjust the literal import without changing the marked behavior. Extract the SDK's cache-hit usage field (`res.usage.cache_read_input_tokens` or the installed version's equivalent name) into `StructuredResult.cachedTokens`, preserving `undefined` (not reported) vs. a reported `0` (AC-7) — never coerce a missing field to `0`. Set `cacheControlApplied: true` unconditionally on every result this method returns (the marking is always applied; its effectiveness — whether a cache hit actually occurs — is what varies, and that's exactly what `cachedTokens` reports separately).
2. `reviewer-core/src/llm/openrouter.ts`'s `completeStructured`: extract a cache-usage field from `res.usage` the same way `apiCost` is already extracted (lines 96-98) — verify OpenRouter's actual field name at implementation time (likely `prompt_tokens_details.cached_tokens`, OpenAI-compatible shape); if the field is genuinely absent for a given model, `cachedTokens` correctly stays `undefined` (AC-7 satisfied by construction — never default to `0`). Do **not** set `cacheControlApplied` here — OpenRouter/OpenAI paths are left completely unchanged beyond this read-only extraction (AC-10).
3. Do not touch `server/src/adapters/llm/openai.ts` — direct-OpenAI cache_control is out of this spec's scope (R1's finding: confirmed available on one direct-provider path only).

**Verify:**
- [ ] `cd server && pnpm exec vitest run --exclude '**/*.it.test.ts'` — Anthropic adapter tests updated for the new array-shaped `system` param, not silently broken
- [ ] `cd reviewer-core && pnpm typecheck && pnpm test` — openrouter.ts changes covered
- [ ] New test: `cachedTokens` stays `undefined` (not `0`) when the mocked response omits the usage field entirely — AC-7
- [ ] `cd agent-runner && pnpm typecheck`

**Commit:** `feat(server,reviewer-core): Anthropic cache_control on system block + cached-token usage extraction on Anthropic/OpenRouter adapters (WS2)`

---

### Step 7: container.ts tokenizer swap — single canonical implementation (WS1, AC-5)

**Dependencies:** Step 1
**Owned paths:** `server/src/platform/container.ts`, `server/src/adapters/tokenizer/index.ts` [delete], `server/package.json` [remove js-tiktoken dependency, conditional on step 3 of "what to do"]

**What to do:**
1. In `container.ts`, replace the `tokenizer` getter's construction (currently `this._tokenizer ??= new TiktokenTokenizer();`) with `this._tokenizer ??= { count: countTokens };` where `countTokens` is imported `from '@devdigest/reviewer-core'` — mirrors the existing `OpenRouterProvider` import pattern in this exact file. Keep the small `Tokenizer` interface (`{ count(text: string): number }`) — move its definition inline into `container.ts` itself (a 3-line structural type, previously the only export of the file being deleted) rather than relocating it to `vendor/shared` for one consumer. `ContainerOverrides.tokenizer` keeps the same type — **no existing call site** (`context-docs/service.ts` ×3, `repo-intel/pipeline/{full,incremental}.ts` ×2, `run-executor.ts` ×3, `brief-generator.ts` ×1) changes, since `container.tokenizer.count(x)` still works identically.
2. Delete `server/src/adapters/tokenizer/index.ts`.
3. `grep -rn "js-tiktoken" server/src` — if the only remaining reference was the deleted file, remove `"js-tiktoken"` from `server/package.json` dependencies and run `pnpm install` in `server/`.

**Verify:**
- [ ] `cd server && pnpm typecheck`
- [ ] `cd server && pnpm exec vitest run --exclude '**/*.it.test.ts'` — every existing `container.tokenizer.count(...)` call site passes unmodified (interface shape unchanged)
- [ ] `grep -rn "adapters/tokenizer" server/src` returns nothing

**Commit:** `refactor(server): container.tokenizer now wraps reviewer-core's canonical token counter instead of a duplicate local implementation (WS1 AC-5)`

---

### Step 8: reviews/routes.ts + helpers.ts — intent-model consolidation (WS3, AC-13)

**Dependencies:** Step 4
**Owned paths:** `server/src/modules/reviews/routes.ts`, `server/src/modules/reviews/helpers.ts`

**What to do:**
1. In `reviews/helpers.ts`, add `resolveIntentModel(container: Container, workspaceId: string, provider: Provider): Promise<string>` = `(await resolveRoutedFeatureModel(container, workspaceId, 'review_intent', 'intent', provider)).model` (import `resolveRoutedFeatureModel` from `../../platform/feature-models.js`).
2. `routes.ts:244`: replace `const model = routeModel('intent', DEFAULT_PROVIDER);` with `const model = await resolveIntentModel(container, workspaceId, DEFAULT_PROVIDER);` — keep the existing `const DEFAULT_PROVIDER = 'anthropic' as const;` local constant (behavior-preserving for the no-override case; now override-aware). Import `resolveIntentModel` from `./helpers.js`. Remove the now-unused `routeModel` import if this file has no other use of it.

**Verify:**
- [ ] `cd server && pnpm typecheck`
- [ ] Existing intent-classification route test passes with the no-override case producing the same model as before (`routeModel('intent','anthropic')` = `'claude-haiku-4-5'`)
- [ ] New test: a workspace with an active `review_intent` override causes this route's classification to use the override's model — AC-13

**Commit:** `feat(server): wire the review_intent override into the intent classification route via resolveIntentModel (WS3, AC-13)`

---

### Step 9: reviews/brief-generator.ts — cheap-tier risk-brief routing + narrative extraction (WS3, AC-12)

**Dependencies:** Step 4
**Owned paths:** `server/src/modules/reviews/brief-generator.ts`, `server/src/modules/settings/feature-models.ts` [delete — now zero consumers], `server/test/brief-generator-service.test.ts` / `brief-routes.test.ts` [extend]

**What to do:**
1. Change the top-of-file import from `import { resolveFeatureModel } from '../settings/feature-models.js';` to `import { resolveRoutedFeatureModel, defaultFeatureModel } from '../../platform/feature-models.js';`.
2. Replace the existing `const { provider, model } = await resolveFeatureModel(container, workspaceId, 'risk_brief');` with `const { provider, model } = await resolveRoutedFeatureModel(container, workspaceId, 'risk_brief', 'summary', defaultFeatureModel('risk_brief').provider);` — one call, same destructured shape, now cheap-tier by default (AC-12) while preserving the existing override behavior (AC-13) and the existing `openai` provider selection for the no-override case (so the documented test gotcha about registering the mock LLM under the `openai` key stays valid).
3. Extract the LLM-calling block (build messages → `llm.completeStructured({model, schema: RiskBriefLlmResult, schemaName:'RiskBriefLlmResult', messages, ...})`) into `export async function generateRiskBriefNarrative(llm: LLMProvider, model: string, systemPrompt: string, input: string): Promise<StructuredResult<RiskBriefLlmResult>>`. `generate()`'s own call site becomes `const result = await generateRiskBriefNarrative(llm, model, systemPrompt, input);`, with the existing try/catch → `AppError('brief_generation_failed', ...)` wrapping kept at the **call site**, not inside the extracted function (Step 12's eval path needs the raw throw, mirroring how `run-orchestrator.ts`'s `runOneCase` catches its own errors).
4. Delete `server/src/modules/settings/feature-models.ts` — confirm zero remaining consumers first: `grep -rln "settings/feature-models" server/src` must return nothing after this step.

**Verify:**
- [ ] `cd server && pnpm typecheck`
- [ ] Existing `brief-generator-service.test.ts`/`brief-routes.test.ts` pass; update any assertion that hardcodes the resolved no-override model string (was `gpt-4.1`, now `gpt-4o-mini`) — the `openai` provider selection itself is unchanged
- [ ] New test: risk-brief generation with no workspace override resolves to the cheap-tier model — AC-12
- [ ] New test: risk-brief generation with an active `risk_brief` override still uses the override's provider+model — regression guard, AC-13
- [ ] `grep -rln "settings/feature-models" server/src` returns nothing

**Commit:** `feat(server): route risk-brief narrative generation to the cheap tier by default + extract generateRiskBriefNarrative for eval reuse (WS3, AC-12)`

---

### Step 10: run-executor.ts — consolidated studio wiring (WS1/WS2/WS3/WS4/WS5)

**Dependencies:** Step 1, Step 2, Step 5, Step 6, Step 7, Step 8
**Owned paths:** `server/src/modules/reviews/run-executor.ts`, `server/src/modules/reviews/smart-diff-rules.ts` [delete], `server/src/modules/reviews/service.ts` [import path only], `server/test/smart-diff-rules.test.ts` [delete], `server/test/run-executor*.test.ts` [extend]

**What to do:**
1. Replace `import { classifyFile } from './smart-diff-rules.js';` in both `run-executor.ts` and `service.ts` with `import { classifyFile, excludeBoilerplateFiles, countPromptAssemblyBlocks, DEFAULT_MAP_THRESHOLD_TOKENS } from '@devdigest/reviewer-core';` (only the symbols each file actually uses). Delete `smart-diff-rules.ts` and its dedicated test file — fully superseded by Step 1.
2. Replace the intent-model call (`routeModel('intent', firstProvider)`, ~line 233) with `await resolveIntentModel(this.container, workspaceId, firstProvider)` (import `resolveIntentModel` from `./helpers.js`, added in Step 8). Remove the now-unused `routeModel` import if nothing else in this file uses it.
3. In `runOneAgent`, immediately before the existing `const budgetedDiff = this.budgetDiff(diff, agent.model, runLog);`, insert: `const { diff: unboilerplatedDiff, excludedFiles, excludedTokensEstimate } = excludeBoilerplateFiles(diff, this.container.tokenizer.count.bind(this.container.tokenizer));` — then feed `unboilerplatedDiff` (not `diff`) into `this.budgetDiff(...)`. Log via `runLog.info(...)`, mirroring `budgetDiff`'s own style: non-zero exclusions → `` `boilerplate filter: ${excludedFiles.length} file(s) excluded (~${excludedTokensEstimate} tokens avoided)` ``; zero exclusions → an explicit zero-count line too (AC-17 — always emitted, never conditional).
4. Add `countTokens: this.container.tokenizer.count.bind(this.container.tokenizer)` to the `reviewPullRequest({...})` call's options object (unconditional spread — `container.tokenizer` always exists, unlike the optional `callers`/`repoMap`/`skills` slots).
5. After `reviewPullRequest(...)` returns, capture `outcome.cachedInputTokens`, `outcome.cacheControlApplied`, `outcome.mapReduceThresholdTokens`, `outcome.mapReduceChunkCount` alongside the existing `tokensIn`/`tokensOut` captures. Compute `const blockTokens = countPromptAssemblyBlocks(outcome.assembly, this.container.tokenizer.count.bind(this.container.tokenizer));` — this is AC-1's per-block breakdown, a caller-side call exactly matching the §7 Non-functional constraint (no new engine-internal call site).
6. In the `trace: RunTrace = {...}` object, add: `cost_report: { block_token_counts: blockTokens, cached_input_tokens: outcome.cachedInputTokens, cache_control_applied: outcome.cacheControlApplied, excluded_boilerplate_files: excludedFiles, excluded_boilerplate_tokens: excludedTokensEstimate, map_reduce_threshold_tokens: outcome.mapReduceThresholdTokens, map_reduce_chunk_count: outcome.mapReduceChunkCount }`.
7. In `traceFromBuffer` (the catch-path fallback trace built before a full review outcome exists), do **not** synthesize a `cost_report` — leave the field absent (`.nullish()` on `RunTrace` makes this valid; a run that failed before computing cost data shouldn't fabricate it).

**Verify:**
- [ ] `cd server && pnpm typecheck`
- [ ] `cd server && pnpm exec vitest run --exclude '**/*.it.test.ts'` — full `reviews` module hermetic suite green
- [ ] New test: a diff containing a `package-lock.json` change is excluded before `budgetDiff` runs even though the whole diff is comfortably under the model's token budget — AC-15, the core "unconditional, not only-when-over-budget" behavior change
- [ ] New test: a run's persisted `RunTrace.cost_report.block_token_counts` has one entry per present prompt slot — AC-1
- [ ] New test: `excluded_boilerplate_files: []` / `excluded_boilerplate_tokens: 0` are present (not omitted) on a run with zero boilerplate files — AC-17
- [ ] `grep -rn "smart-diff-rules" server/src server/test` returns nothing

**Commit:** `feat(server): wire boilerplate exclusion, per-block token trace, cache/map-reduce trace fields, and override-aware intent routing into run-executor (WS1/WS2/WS3/WS4/WS5 studio wiring)`

---

### Step 11: agent-runner — CI parity (WS1/WS2/WS4/WS5)

**Dependencies:** Step 1, Step 2, Step 5, Step 6
**Owned paths:** `agent-runner/src/run.ts`, `agent-runner/src/artifact.ts`, `agent-runner/src/run.test.ts` [extend], new fixture-based tests as needed

**What to do:**
1. In `run.ts`, immediately after `const diff = parseUnifiedDiff(stripIgnoredFiles(rawDiff));`, add: `const { diff: unboilerplatedDiff, excludedFiles, excludedTokensEstimate } = excludeBoilerplateFiles(diff, countTokens);` — import `excludeBoilerplateFiles`, `countTokens`, `countPromptAssemblyBlocks` from `@devdigest/reviewer-core`. This mirrors the studio's ordering exactly: boilerplate exclusion runs once, before the engine call; CI has no separate over-budget trim step today, so this is the only diff-shaping step in this pipeline.
2. Pass `unboilerplatedDiff` (not `diff`) and `countTokens` into the `reviewPullRequest({...})` call (the existing call at step 4 of `runCi`).
3. Extend `BuildResultArtifactInput` (in `artifact.ts`) with the new optional fields mirroring the studio's `cost_report`: `blockTokenCounts`, `cachedInputTokens`, `cacheControlApplied`, `excludedBoilerplateFiles`, `excludedBoilerplateTokens`, `mapReduceThresholdTokens`, `mapReduceChunkCount`. In `buildResultArtifact`, map them onto `CiResultArtifact`'s new nullish fields (Step 2), following this file's existing `candidate`-object convention (camelCase in, snake_case out).
4. After `reviewPullRequest` returns, compute `countPromptAssemblyBlocks(outcome.assembly, countTokens)` and pass it plus `excludedFiles`/`excludedTokensEstimate`/`outcome.cachedInputTokens`/`outcome.cacheControlApplied`/`outcome.mapReduceThresholdTokens`/`outcome.mapReduceChunkCount` into the `buildResultArtifact({...})` call.
5. Add a `console.log` line summarizing the exclusion (mirroring the studio's `runLog.info`), e.g. `` `[agent-runner] boilerplate filter: ${excludedFiles.length} file(s) excluded (~${excludedTokensEstimate} tokens avoided)` `` — printed even when the count is zero.

**Verify:**
- [ ] `cd agent-runner && pnpm typecheck && pnpm test`
- [ ] Existing `run.test.ts` fixtures (stubbed LLM, no network) pass unmodified where they don't involve boilerplate/tokens
- [ ] New test: a fixture diff containing a lock-file change produces an artifact whose `excluded_boilerplate_files` contains that path and whose findings never reference it — AC-15/AC-19 (CI reach)
- [ ] New test: many small files + a low injected threshold produces `map_reduce_chunk_count < files.length` — AC-22/AC-24 (CI reach)
- [ ] `cd server && pnpm typecheck` (sanity check — server doesn't consume agent-runner, confirms no accidental coupling)

**Commit:** `feat(agent-runner): boilerplate exclusion + token-budget map-reduce + cost/cache artifact fields reach CI (WS1/WS2/WS4/WS5 CI parity)`

---

### Step 12: eval module — WS6 intent/risk-brief-narrative orchestrator

**Dependencies:** Step 3, Step 4, Step 9
**Owned paths:** `server/src/modules/eval/scoring.ts`, `server/src/modules/eval/run-orchestrator.ts`, `server/src/modules/eval/helpers.ts`, `server/src/modules/eval/service.ts`, `server/test/eval-*.test.ts` [extend]

**What to do:**
1. `scoring.ts` (stays zero-I/O per its own hard-rule comment): add `scoreIntentCase(actual: Intent, expected: { in_scope: string[]; out_of_scope: string[] }): { matched: number; total: number }` — an expected entry counts as matched via case-insensitive substring/overlap against the corresponding actual array (document the exact matching strictness chosen in a code comment, mirroring `matchesExpectation`'s own pragmatic-overlap precedent). `intentCasePassed(result, threshold = 0.7): boolean` = `result.total === 0 || result.matched / result.total >= threshold`. Add `scoreRiskBriefCase(actual: RiskBriefLlmResult, expectedKeyPoints: string[]): { matched: number; total: number }` — a key point counts as matched when its normalized text appears as a substring in `` `${actual.what} ${actual.why} ${actual.risks.map(r=>r.explanation).join(' ')}` `` (mirrors skill-eval's `patternMatch` substring-presence convention, per §13 clarification #1). `riskBriefCasePassed(result, threshold = 1.0): boolean` = same ratio-vs-threshold shape. Both `0.7`/`1.0` are the built-in fallback defaults used only when the case's own `passingThreshold` column is `null` (§13 clarification #3).
2. `run-orchestrator.ts`'s `runOneCase`: branch at the top on `caseRow.caseKind ?? 'review_finding'` (defensive default even though the column is `NOT NULL`). `'review_finding'` → existing code, byte-for-byte unchanged. Add two new private methods:
   - `runOneIntentCase(agent, caseRow, batchId, workspaceId)`: parse `caseRow.inputMeta` for `{title, body, filesSummary}` (fall back to deriving `filesSummary` from `caseRow.inputFiles` when `inputMeta` lacks it); resolve the model via `resolveRoutedFeatureModel(this.container, workspaceId, 'review_intent', 'intent', agent.provider)` (Step 4); call `classifyIntent({title, body, filesSummary, llm, model, sessionId: \`eval:${batchId}:${caseRow.id}\`})` (already an existing reviewer-core export — zero new LLM call TYPE, per the spec's Inputs table); parse `caseRow.expectedOutput` as `{in_scope, out_of_scope}`; score via `scoreIntentCase` + `intentCasePassed(result, caseRow.passingThreshold ?? undefined)`; persist an `eval_runs` row with `actualOutput` = the classify result (minus token/cost fields), `pass`, `recall: result.matched / result.total` (reusing the existing generic `recall` column to carry the match ratio — document this reuse in a code comment; `precision`/`citationAccuracy` don't apply to this case kind and stay `null`), `costUsd`, `durationMs`.
   - `runOneRiskBriefCase(agent, caseRow, batchId, workspaceId)`: resolve the model via `resolveRoutedFeatureModel(this.container, workspaceId, 'risk_brief', 'summary', agent.provider)`; load the risk-brief system prompt the same way `brief-generator.ts` does (reuse `loadPromptTemplate`/its loader, don't duplicate); build the LLM `input` string directly from `caseRow.inputDiff` (skip the full live-PR fact-gathering pipeline — the case's stored diff text is proportionate eval input, not a live PR); call `generateRiskBriefNarrative(llm, model, systemPrompt, input)` (Step 9's extracted helper); parse `caseRow.expectedOutput` as `{key_points}`; score via `scoreRiskBriefCase` + `riskBriefCasePassed`; persist the same way (`actualOutput` = the `RiskBriefLlmResult`, `recall` = match ratio).
   Wrap both new branches in the same try/catch → `'error'`-status outcome shape `runOneCase` already uses, so `executeBatch`'s existing degraded/error aggregation logic (AC-30) needs zero changes.
3. `helpers.ts`: `batchCaseOutcome()` needs no change (already reads generic `run.recall`/`run.costUsd`/`run.errorMessage`). Extend `caseListItem()` to surface `case_kind`/`passing_threshold` on the returned `EvalCaseListItem` (Step 3's contract fields).
4. `service.ts`'s `createCaseManual`: accept `case_kind`/`passing_threshold` from `EvalCaseCreateInput` (Step 3) and pass through to `repo.insertCase({...})` — no repository signature change needed (`insertCase` already accepts the full generic `EvalCaseInsert` type). Add a guard: `if (input.case_kind !== 'review_finding' && ownerKind === 'skill') throw new ValidationError('intent/risk_brief_narrative cases are agent-owned only');` — skill-eval owns its own separate scoring pipeline entirely and this new dimension doesn't apply there.
5. No route shape changes — `POST /agents/:id/evals` already passes `req.body` (now widened by Step 3) straight to `service.createCaseManual`.

**Verify:**
- [ ] `cd server && pnpm typecheck`
- [ ] `cd server && pnpm exec vitest run --exclude '**/*.it.test.ts'` — new hermetic tests for `scoreIntentCase`/`scoreRiskBriefCase`/`intentCasePassed`/`riskBriefCasePassed` (pure, zero-I/O, same style as existing `scoring.test.ts`)
- [ ] New test: creating an `intent`-kind case then running the batch produces a `passed`/`failed` outcome derived from a mocked `classifyIntent` output vs. `expected_output` — AC-26, AC-28
- [ ] New test: creating a `risk_brief_narrative`-kind case then running it produces a scored outcome from a mocked `generateRiskBriefNarrative` output — AC-27, AC-28
- [ ] New test: a case scoring below `passing_threshold` (or the kind's default) surfaces as `'failed'` in batch detail, and a batch containing it seals `'degraded'` — AC-30
- [ ] New test: `case_kind: 'intent'` with `owner_kind: 'skill'` is rejected with `ValidationError`
- [ ] Documented manual query check (no new code): grouping `agent_runs` by `model`/session over a multi-week window ranks the top-3 cost items using only existing columns — AC-3

**Commit:** `feat(server): intent + risk-brief-narrative eval case kinds with deterministic scoring, gated by the cheap-tier routing path (WS6)`

---

## 6. Acceptance Criteria

### Workstream 1 — Cost & token instrumentation
- [ ] AC-1: `RunTrace.cost_report.block_token_counts` records system/skills/specs/callers/repo_map/pr_description/diff separately, per run, in both studio (Step 10) and CI (Step 11) — Step 1's `countPromptAssemblyBlocks`.
- [ ] AC-2: map-reduce's shared/system portion + each chunk's diff portion are visible via `mapReduceThresholdTokens`/`mapReduceChunkCount` (Step 5) plus the per-chunk `tool_calls` trace entries (unchanged mechanism, now token-labeled).
- [ ] AC-3: satisfied by existing `agent_runs.cost_usd`/`tokens_in`/`tokens_out`/`model` columns — no implementation step; verified via a documented query in Testing Plan.
- [ ] AC-4: a per-block counting failure yields `'unavailable'` for that block only, never fails the run — Step 1's `countPromptAssemblyBlocks` try/catch.
- [ ] AC-5: one function (`countTokens`, reviewer-core-exported) computes every token count in both studio and CI — Steps 1, 5, 7, 10, 11.

### Workstream 2 — Cache visibility + cache directive
- [ ] AC-6: `cached_input_tokens` captured separately from total input tokens — Steps 2, 5, 6, 10, 11.
- [ ] AC-7: a reported zero is distinguishable from "not reported at all" (`null` vs `0`) — Step 6's `undefined`-preserving extraction.
- [ ] AC-8: the map-reduce shared system prefix is marked cacheable — Step 6's unconditional `cache_control` on the Anthropic system block.
- [ ] AC-9: the marking is additive metadata only, no prompt content change — Step 6 (same text, new wrapper shape).
- [ ] AC-10: non-cache-supporting providers (OpenAI, OpenRouter) send requests unchanged — Step 6 explicitly leaves them untouched.

### Workstream 3 — Cheap-tier routing
- [ ] AC-11: intent classification defaults to cheap tier unless overridden — Step 8.
- [ ] AC-12: risk-brief narrative defaults to cheap tier unless overridden — Step 9.
- [ ] AC-13: an active `review_intent`/`risk_brief` override is honored — Step 4's `resolveRoutedFeatureModel`, exercised by Steps 8, 9, 12.
- [ ] AC-14: only intent + risk-brief are affected; the primary review call's model resolution is untouched — no step edits the review call's own model resolution.

### Workstream 4 — Boilerplate filter
- [ ] AC-15: boilerplate excluded regardless of under/over budget — Steps 10, 11 run exclusion unconditionally, before `budgetDiff`.
- [ ] AC-16 / AC-17: a structured exclusion event (files, count, tokens avoided) is emitted every run, including zero-count — Steps 10, 11's trace/artifact fields + log lines.
- [ ] AC-18: Dockerfile/GHA workflow/`.env.example` never classified as boilerplate — Step 1's verbatim-relocated `classifyFile`.
- [ ] AC-19: one shared classification rule, studio and CI — Step 1 (reviewer-core), consumed by Steps 10, 11.
- [ ] AC-20: before/after token counts recorded for a designated large multi-file lock-file diff — Step 1's dedicated fixture test.

### Workstream 5 — Map-reduce token-budget + bin-packing
- [ ] AC-21: token-count threshold replaces the line-count rule — Step 5.
- [ ] AC-22: small files bin-packed into shared chunks — Step 5.
- [ ] AC-23: one centrally defined threshold (`DEFAULT_MAP_THRESHOLD_TOKENS`), studio and CI — Step 5, consumed by Steps 10, 11.
- [ ] AC-24: the same counting function is directly available to CI — Step 1's reviewer-core export, imported by Step 11.
- [ ] AC-25: a single oversized file still gets its own chunk — Step 5's bin-packer.

### Workstream 6 — Eval regression capability
- [ ] AC-26: intent-kind eval cases definable — Step 3 (schema/contract) + Step 12 (`createCaseManual`).
- [ ] AC-27: risk-brief-narrative-kind eval cases definable — Step 3 + Step 12.
- [ ] AC-28: deterministic pass/fail/scored result, not a raw transcript — Step 12's `scoreIntentCase`/`scoreRiskBriefCase`.
- [ ] AC-29: batches run against the (now-default) cheap-tier-routed model, reporting whether quality held — Step 12 resolves the model via the same `resolveRoutedFeatureModel` production call path.
- [ ] AC-30: a below-threshold case surfaces as failed, degrading the batch — Step 12, reusing the existing `executeBatch` sealing logic unchanged.

### §13 Amendment resolutions
- [ ] Canonical token-counter home = reviewer-core, injected pure function — Steps 1, 5, 7, 10, 11.
- [ ] Canonical boilerplate-classifier home = reviewer-core — Step 1, consumed by Steps 10, 11 (server's `smart-diff-rules.ts` deleted in Step 10).
- [ ] Review-intent override ownership = `platform/`, one exercise point — Step 4, consumed by Steps 8, 9, 12; the `reviews → settings` cross-module import is fully closed (Step 9 deletes `settings/feature-models.ts`).
- [ ] Cache-control marking is adapter-only, no new engine request-contract field — Step 6 (no `ReviewInput` field added for this).

## 7. Testing Plan

**Server:** hermetic (`.test.ts`, mocked LLM/db) for everything except the one true integration touch (`settings-models.it.test.ts`, Docker-backed, Step 4).
**reviewer-core:** hermetic only (`Vitest`, stubbed `LLMProvider`, no network) — this package has no integration-test tier.
**agent-runner:** hermetic only (stubbed LLM, fixture diffs, no GitHub/network calls).

| Test | Type | Covers |
|---|---|---|
| `reviewer-core/test/tokens.test.ts` | hermetic | `countTokens` correctness + fallback |
| `reviewer-core/test/classify.test.ts` | hermetic | AC-18 (relocated, byte-identical to the old `smart-diff-rules.test.ts`) |
| `reviewer-core/test/boilerplate.test.ts` | hermetic | AC-15, AC-17, **AC-20's before/after fixture** |
| `reviewer-core/test/token-report.test.ts` | hermetic | AC-1, AC-4 |
| `reviewer-core/test/run.test.ts` (extended) | hermetic | AC-2, AC-6, AC-21, AC-22, AC-25 — **plus an explicit regression case asserting every pre-existing fixture's mode/chunk-count is unchanged when `countTokens` is omitted** (the coordinator's third called-out check) |
| `server/test/*` — Anthropic/OpenRouter adapter tests (extended) | hermetic | AC-7, AC-8, AC-9, AC-10 |
| `server/test/settings-models.it.test.ts` (extended) | integration | AC-11, AC-12, AC-13 (real DB-backed override lookup) |
| `server/test/run-executor*.test.ts` (extended) | hermetic | AC-1, AC-4, AC-15, AC-16, AC-17, cache/map-reduce trace fields |
| `agent-runner/src/run.test.ts` (extended) | hermetic | AC-15, AC-19, AC-22, AC-24 (CI reach) |
| `server/test/eval-scoring.test.ts` (extended) | hermetic | AC-28 |
| `server/test/eval-run-orchestrator.test.ts` (extended) | hermetic | AC-26, AC-27, AC-29, AC-30 |
| Manual SQL check (documented in the Step 12 PR description, not a new test file) | query-level | AC-3 — `SELECT model, SUM(cost_usd) ... GROUP BY model ORDER BY 2 DESC LIMIT 3` against `agent_runs` over a multi-week window, confirmed to work on existing columns with no schema change |

## 8. Out of Scope

- Any UI surface (Agent Performance page, Skill/Agent Stats tabs, cost dashboards) — Spec B.
- A new billing-analytics integration against the OpenRouter dashboard API.
- Changing the primary structured review call's model resolution (AC-14).
- A new persistent token/cache/exclusion analytics table (studio uses `run_traces.trace`; CI uses the `devdigest-result.json` artifact only — never `ci_runs`).
- A new in-process caching layer beyond sending the existing provider's cache directive and capturing what it reports.
- Per-agent-configurable map-reduce token threshold — one centrally shared default only (`AgentManifest` gets no new field).
- Multi-agent fan-out cost accounting or cross-agent cost comparison.
- Mirroring any of this spec's new fields into `client/src/vendor/shared/` — no client code reads them yet; that is Spec B's concern.
- Persisting WS1/WS2/WS4 CI data (`cost_report`-equivalent fields) into the `ci_runs` table or any new column there.
- Removing the dead `review_intent` Settings control from the client UI (the spec's §13 clarification #2 resolution is "wire it," not "remove it" — a client change, out of this backend-only spec).
