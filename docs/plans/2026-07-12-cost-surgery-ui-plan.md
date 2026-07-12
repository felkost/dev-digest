# Development Plan: Cost Surgery — UI/Dashboards (Spec B)

**Date:** 2026-07-12
**Requirements:** [docs/feature-requirements/2026-07-11-cost-surgery-ui.md](../feature-requirements/2026-07-11-cost-surgery-ui.md) (SPEC-2026-07-11-cost-surgery-ui, status: approved) — 29 EARS ACs
**Execution mode:** multi-agent (9 steps / 3 waves — see rationale in §5)
**Scope:** full-stack (client-primary; one small, read-only server addition)
**Affects modules:** `server/src/modules/agents/`, `server/src/modules/skills/`, `server/src/vendor/shared/contracts/{trace,eval-ci,eval-batch,productionize,observability,knowledge}.ts`, `client/src/vendor/shared/contracts/*` (mirror), `client/src/app/agent-performance/` (new), `client/src/app/agents/[id]/_components/AgentEditor/`, `client/src/app/skills/_components/SkillDetail/`, `client/src/components/RunTraceDrawer/` (relocated), `client/src/vendor/ui/`

---

## 1. Context

Spec A (backend cost instrumentation — model routing, boilerplate filter, per-block token accounting) is implemented and committed (`aed7464`). It produces new data — `RunTrace.cost_report` / `CiResultArtifact`'s 7 cost-surgery fields, `eval_cases.case_kind`/`passing_threshold` (migration `0026`) — but none of it, nor the pre-existing cost/accept-rate data the product already has, is visible in three UI surfaces that are only partially wired: a scaffolded "Agent Performance" fleet page (i18n drafted, no route/component), a reserved "Agent Stats" tab on the Agent editor (contract defined, never routed), and a live "Skill Stats" tab whose findings-by-category breakdown is a raw count (no cost) and whose accept-rate is a hardcoded `0`. This plan activates all three surfaces, consuming Spec A's data plus the product's existing `agent_runs`/`findings`/`reviews` tables, with zero new LLM calls and zero new migrations.

The client's copy of `@devdigest/shared` (`client/src/vendor/shared/`) is a hand-maintained mirror of the server's copy (`server/src/vendor/shared/`) — **not a symlink, no sync script exists** (confirmed: `diff -rq` between the two trees). It has drifted: `contracts/trace.ts`, `contracts/eval-ci.ts`, and `contracts/eval-batch.ts` are missing fields the server added for Spec A. `contracts/productionize.ts` differs by one unrelated line (an `openrouter` provider-enum drift, pre-existing, out of scope — do not touch). `contracts/observability.ts` and `contracts/knowledge.ts` are currently identical between client and server. Step 1 closes the trace/eval-ci/eval-batch drift; Step 2 then extends the (already-identical) `productionize.ts`/`observability.ts`/`knowledge.ts` with the new fields this spec's three reads need, in both copies at once, since no sync tooling exists to do it for you.

## 2. Architecture Fit

**Server — no new module.** Both new reads slot into the already-registered `agents` module (`server/src/modules/agents/{routes,service,repository}.ts` — already registered in `server/src/modules/index.ts`, no entry needed):
- `GET /agents/performance` — fleet-wide read (AC-1…AC-9)
- `GET /agents/:id/stats` — per-agent detail read, wiring up the reserved `AgentStats` contract (AC-10…AC-19)

Both are pure aggregation over `agent_runs` / `findings` / `reviews` / `agent_skills` — zero LLM calls, zero adapter use, workspace-scoped, following the exact 3-layer pattern already used by `runStatsByAgent`/`acceptanceByAgent`/`skillCountByAgent` in `server/src/modules/agents/repository.ts:271-325` and by the `blast` module (`server/src/modules/blast/{routes,service,repository}.ts`) as the canonical "read-only aggregation" precedent. The `skills` module (`server/src/modules/skills/repository.ts`) gets two in-place fixes (AC-20…AC-23) — no new routes.

Per `backend-onion-architecture` R6/AP-4 (module import isolation — no cross-module repository imports), the new agent-scoped run-history/weekly-severity queries do **not** import `reviews/repository/run.repo.ts`'s `listRunsForPull` — they are new, agent-scoped queries written directly in `agents/repository.ts`, following that function's *shape* as a style reference only.

**Client — three route surfaces, one shared relocation:**
- New route `client/src/app/agent-performance/page.tsx` + `_components/` (mirrors the existing `client/src/app/skills/` / `client/src/app/agents/` co-location convention per `client/src/app/AGENTS.md`)
- New tab inside the existing `client/src/app/agents/[id]/_components/AgentEditor/` tree (`constants.ts`'s `TABS` array + a render branch, both currently reserved-but-unwired)
- Extension of the existing, already-built `client/src/app/skills/_components/SkillDetail/StatsTab.tsx`
- `RunTraceDrawer` relocates from `client/src/app/repos/[repoId]/pulls/[number]/_components/RunTraceDrawer/` to `client/src/components/RunTraceDrawer/` — per `client/src/app/AGENTS.md`'s own rule ("`src/components/` is for UI shared across multiple routes only"), this is exactly that case now that a second route tree (Agent Stats tab) needs it.
- Chart primitives: `client/src/vendor/ui/charts/{Donut,MetricCard,BarRow,Sparkline,LineChart}` and `client/src/vendor/ui/primitives/CircularScore.tsx` already exist and are reused as-is; only a `WeeklyStackedBar` (new) and a small `CircularScore`/`MetricCard` extension are added.

## 3. Skills & Patterns Applied

**backend-onion-architecture:**
- R1 — every new/changed repository query filters `workspace_id` (via `agent_runs.workspaceId` or `reviews.workspaceId`, matching the existing `runStatsByAgent`/`acceptanceByAgent` pattern)
- R2 — N/A: zero adapter/LLM usage in this spec (verify: no `container.llm()`/`container.github()` call site is introduced)
- R3 — `NotFoundError` for an unknown/cross-workspace `:id` on `GET /agents/:id/stats`, matching the existing `GET /agents/:id` pattern (`routes.ts:94-99`)
- R6/AP-4 — no cross-module repository imports; new queries live in `agents/repository.ts` and `skills/repository.ts` respectively

**fastify-best-practices / zod:** route registration follows the exact existing pattern in `server/src/modules/agents/routes.ts` (`app.get('/agents/stats', ...)` at line 89-92, `app.get('/agents/:id', {schema:{params:IdParams}}, ...)` at line 94-99) — one Zod schema (`IdParams` from `../_shared/schemas.js`) drives both validation and typing.

**drizzle-orm-patterns:** conditional-window aggregation via `sql<...>` + `count(*) filter (where ...)` / `sum(...) filter (where ...)`, exactly as already used in `acceptanceByAgent` (`repository.ts:298-317`) and `runStatsByAgent` (`repository.ts:271-294`) — extended with a `ran_at >= :cutoff` / `BETWEEN :cutoff60 AND :cutoff30` predicate for the two trailing-30-day windows.

**react-best-practices / next-best-practices / frontend-architecture:** co-located `_components/`, TanStack Query for both new reads (no `useEffect` fetching), `"use client"` at the leaf, client-side sort on the fleet table (AC-4 — no extra request).

**typescript-expert:** additive Zod extension via `AgentStats.extend({...})` (mirrors the existing `EvalBatchDetail = EvalBatch.extend({...})` pattern in `eval-batch.ts:120-124`), nullable vs. nullish chosen per each field's real "unavailable" semantics (never a bare optional where "never happened" and "old data predates this" need to be distinguished).

**security:** every new read is a `GET`, path-param-only (`:id` validated as `z.string().uuid()` via `IdParams`), zero new untrusted free-text input (matches spec §10 "Untrusted Inputs: None"). The one real security check: `GET /agents/:id/stats` must 404 — not leak data — when `:id` belongs to another workspace, exactly like the existing `GET /agents/:id` (`routes.ts:94-99`) and `GET /agents/:id/skills` (`routes.ts:169-174`) do today.

## 4. Project Constraints

- **workspace_id on every query** — no exceptions, including the two new `agents/repository.ts` queries and the two changed `skills/repository.ts` queries.
- **Zero LLM calls, zero adapter usage** — this entire spec is mechanical aggregation over already-persisted data (§7 NFR). No `container.llm()`, no `container.github()`, no `container.secrets` call site anywhere in the new code.
- **No migration** — explicit non-goal. All new fields are either read directly from existing columns (`agent_runs.cost_usd/model/ranAt/agentId`, `findings.severity/category/acceptedAt/dismissedAt`, `reviews.agentId/createdAt`, `agent_skills.order`) or computed at read time. Do not add a column, table, or `server/drizzle/` (or `server/src/db/migrations/`) file.
- **Never alter an existing column or an applied migration.**
- **Shared types live only in `vendor/shared/`, manually mirrored** — every contract change in this plan is made in **both** `server/src/vendor/shared/contracts/*.ts` and `client/src/vendor/shared/contracts/*.ts`, kept byte-identical for the touched blocks. Do not touch the pre-existing, unrelated `productionize.ts` provider-enum drift or the `adapters.ts` drift (out of scope for this spec — leave as-is).
- **Client:** `apiFetch`/`api.*` from `src/lib/api.ts` only; TanStack Query for all new reads; all NEW user-facing strings via next-intl (`agentPerformance.json`, `agents.json`, `skills.json`) — never hardcoded. `StatsTab.tsx` (Skill Stats) currently hardcodes all its existing strings (pre-existing debt, confirmed zero `useTranslations` call in the file) — this plan does **not** retrofit those; only the new estimate-badge string this plan adds must be i18n'd, added under a new `skills.json` `"stats"` namespace (parallel to the existing `"evals"` section), consumed via `useTranslations("skills")` matching every sibling tab.
- **No Shadcn, no Radix.** Recharts (`client/src/vendor/ui/charts/Donut.tsx`, `LineChart.tsx`) is a de-facto second approved exception to the "no external component library" rule (alongside `@xyflow/react`, documented in `client/AGENTS.md:19`) — reuse it for the new `WeeklyStackedBar`; do not introduce a second charting library. Formally documenting this exception in `client/AGENTS.md` is an implementer follow-up (see §8), not a blocking step.
- **Non-fabrication convention (AC-3, AC-25, AC-27, AC-28):** never render a fabricated `0`/`$0.00` where the true state is "unavailable" or "unknown." Precisely: a zero-run agent shows `0` for counts but **null/unavailable** for accept-rate (AC-3); an older run missing a Spec A field shows unavailable, never `0` (AC-25); a **zero-cost prior window** is a legitimate `$0` baseline, not unavailable (AC-27) — but a window where **every** contributing run has unknown cost is unavailable, not `$0.00` (AC-28). These are different states and must not collapse into the same rendering.
- **CI-exclusion (AC-26) — defensive, not implicit.** `agent_runs.source` is an enum `['local','ci']` defaulting to `'local'`; CI runs are ingested exclusively into the separate `ci_runs` table today (`agent_runs.source = 'ci'` is never written anywhere in the codebase — confirmed by repo-wide grep). Every new query in this plan still explicitly filters `eq(agentRuns.source, 'local')` — do not rely on the current absence of `'ci'` rows as an implicit guarantee.
- **Deleted-agent handling is free (AC-29).** `agent_runs.agentId` has `onDelete: 'set null'` (`server/src/db/schema/runs.ts:15`) — a deleted agent's runs survive with `agent_id = NULL`. Workspace-wide totals (`total_runs_all_time`, `total_cost_usd_30d`) must **not** filter on `agentId`; per-agent breakdowns (`agent_rows`, per-agent detail) naturally exclude `agentId IS NULL` rows via the existing `GROUP BY`/map-skip pattern already used in `runStatsByAgent`/`acceptanceByAgent` (`if (!r.agentId) continue;`).
- **Estimate/approximation labeling is load-bearing, and scoped precisely.** Only two values in this whole spec need an "estimate"/"approximation" visual mark: the Skill Stats `findings_by_category` dollar breakdown (AC-20/21) and the Agent Stats `most_used_skills` ranking (AC-13). Fleet/Agent-Stats `cost_by_agent`, `cost_by_model`, `total_cost_usd_30d`, `cost_delta_usd_30d`, and every accept-rate are **real** aggregates (`SUM`/`COUNT` over actual `cost_usd`/`accepted_at`/`dismissed_at`) — do not apply the estimate badge to them.

---

## 5. Implementation Steps

**Parallelization map:**
```
Wave 1 (4 parallel — zero deps, fully disjoint paths):
  Step 1  Mirror stale shared-contract fields (client only)
  Step 2  Extend shared contracts with new Spec B fields (server + client)
  Step 3  New/extended shared chart primitives (client)
  Step 4  Relocate RunTraceDrawer (client)

Wave 2 (2 parallel — depend on Step 2):
  Step 5  Server: agents module — fleet + per-agent-detail reads
  Step 6  Server: skills module — accept-rate fix + $ conversion

Wave 3 (3 parallel — depend on Step 2 + their respective Wave-2/Wave-1 steps):
  Step 7  Client: Agent Performance page          (needs 2, 5)
  Step 8  Client: Agent Stats tab                  (needs 2, 3, 4, 5)
  Step 9  Client: Skill Stats tab extension         (needs 2, 6)
```

**Why multi-agent:** the 9 steps split into 4 genuinely independent Wave-1 steps (two contract edits touching disjoint file sets, one new UI-primitive file, one self-contained component move), 2 independent Wave-2 server steps (disjoint modules — `agents/` vs `skills/`), and 3 independent Wave-3 client steps (disjoint route trees/components). No two steps in the same wave share an owned path. This mirrors Spec A's own multi-agent execution (12 steps / 3 waves) and the wave widths here (4 → 2 → 3) are the maximum the real file-ownership boundaries allow — `GET /agents/performance` and `GET /agents/:id/stats` are **not** split into two steps despite both belonging to Wave 2, because both necessarily touch the same three existing files (`agents/routes.ts`, `service.ts`, `repository.ts`) and splitting them would guarantee a merge conflict, not genuine parallelism.

---

### Step 1: Mirror Spec A's stale shared-contract fields into the client (mechanical, zero design decisions)

**Dependencies:** none
**Owned paths:** `client/src/vendor/shared/contracts/trace.ts`, `client/src/vendor/shared/contracts/eval-ci.ts`, `client/src/vendor/shared/contracts/eval-batch.ts`
**What to do:**

1. In `client/src/vendor/shared/contracts/trace.ts`, mirror from `server/src/vendor/shared/contracts/trace.ts`:
   - Add the `BlockTokenCount` schema (server lines 70-75: `{ block: string; tokens: number | 'unavailable' }`) — insert after `RunTraceContextDoc` (client currently ends that section at line 67).
   - Add the `RunTraceCostReport` schema (server lines 77-87): `block_token_counts: BlockTokenCount[]`, `cached_input_tokens: number | null`, `cache_control_applied: boolean`, `excluded_boilerplate_files: string[]`, `excluded_boilerplate_tokens: number`, `map_reduce_threshold_tokens: number | null`, `map_reduce_chunk_count: number`.
   - Add `cost_report: RunTraceCostReport.nullish()` as a new field on `RunTrace` (server line 121), immediately after `context_documents` and before the closing of the object (client's `RunTrace` currently ends at `log: z.array(RunLogLine),` — add `cost_report` after it).
   - Bring the client's `PromptAssembly.repo_map` doc comment in line with the server's (server line 46-48 documents "Enables per-slot token attribution" — cosmetic, optional but keeps the two files identical).
2. In `client/src/vendor/shared/contracts/eval-ci.ts`:
   - Add `import { BlockTokenCount } from './trace.js';` to the import list (matches server line 4).
   - Add the 7 cost-surgery fields to `CiResultArtifact` (server lines 268-277, all `.nullish()`): `block_token_counts: z.array(BlockTokenCount).nullish()`, `cached_input_tokens: z.number().int().nullish()`, `cache_control_applied: z.boolean().nullish()`, `excluded_boilerplate_files: z.array(z.string()).nullish()`, `excluded_boilerplate_tokens: z.number().int().nullish()`, `map_reduce_threshold_tokens: z.number().int().nullish()`, `map_reduce_chunk_count: z.number().int().nullish()`. Insert them after `skipped_reason` (client's current last field before the closing brace), with the same doc comment the server carries (lines 268-270: these mirror `RunTraceCostReport`, are CI's own durable record, not persisted to any table, nullish because older CI runners omit them).
3. In `client/src/vendor/shared/contracts/eval-batch.ts`:
   - Add the `EvalCaseKind` enum (server lines 20-29: `z.enum(['review_finding', 'intent', 'risk_brief_narrative'])`) with its doc comment, placed before `Expectation` (matching server's file order).
   - Add `case_kind: EvalCaseKind` and `passing_threshold: z.number().min(0).max(1).nullable()` to `EvalCaseListItem` (server lines 66-70), after `notes`.
   - Add `case_kind: EvalCaseKind.default('review_finding')` and `passing_threshold: z.number().min(0).max(1).nullish()` to `EvalCaseCreateInput` (server lines 92-97), after `notes`.
4. Do **not** touch `productionize.ts`, `observability.ts`, or `knowledge.ts` in this step — those are Step 2.
5. Do **not** touch `adapters.ts` — its drift is large, pre-existing, and unrelated to Spec B (confirmed via `diff`: OpenRouter session-id, cache-control result fields, CI `commitFiles`/`sync`/`diffNameOnly` — all out of scope here).

**Verify:**
- [ ] `cd client && pnpm typecheck` passes
- [ ] `diff server/src/vendor/shared/contracts/trace.ts client/src/vendor/shared/contracts/trace.ts` shows no remaining differences other than none (files should be byte-identical after this step)
- [ ] Same for `eval-ci.ts` and `eval-batch.ts`

**Commit:** `chore(shared-contracts): mirror Spec A cost-surgery + eval-case-kind fields into client vendor/shared`

---

### Step 2: Extend shared contracts with Spec B's new fields (design + mirror, server + client)

**Dependencies:** none (parallel with Step 1 — disjoint files)
**Owned paths:** `server/src/vendor/shared/contracts/productionize.ts`, `client/src/vendor/shared/contracts/productionize.ts`, `server/src/vendor/shared/contracts/observability.ts`, `client/src/vendor/shared/contracts/observability.ts`, `server/src/vendor/shared/contracts/knowledge.ts`, `client/src/vendor/shared/contracts/knowledge.ts`
**What to do:**

These three files are currently **identical** between client and server (confirmed via `diff -rq`) except one unrelated line in `productionize.ts` (a `PluginAgent.provider` enum drift — do not touch it). Make every edit below in **both** copies, keeping them identical for the touched blocks.

1. **`contracts/productionize.ts` — redefine `AgentPerf`/`AgentPerfRow`/`PerfCostSegment`** (currently a reserved, zero-consumer scaffold for `GET /agents/performance` — lines 134-186 in both files):
   - `PerfCostSegment.value` — change from `z.number()` to `z.number().nullable()`. Null means every run contributing to that segment (agent or model) has unknown cost (AC-28) — distinct from the segment being absent from the list entirely.
   - `AgentPerfRow` — rename the existing `trend: z.array(z.number())` field to `cost_trend: z.array(z.number())` (recent per-run cost points, oldest→newest, for the row's sparkline — the field existed but was never populated or named for this purpose; §9 "agent_rows" calls for "a short recent-cost trend for a sparkline," not a findings-count trend). Keep every other existing `AgentPerfRow` field (`agent_id, agent_name, provider, model, runs, findings_total, accepted, dismissed, accept_rate, dismiss_rate, avg_findings_per_run, total_cost_usd, avg_cost_usd, avg_latency_ms, last_run_at, findings_by_severity`) unchanged — they already satisfy §9's "accept-rate, run count, findings count, cost" requirement for `agent_rows` and are harmless extras.
   - `AgentPerf.summary` — replace the object entirely with (matching spec §9 field-for-field):
     - `total_runs_all_time: z.number().int()`
     - `total_cost_usd_30d: z.number().nullable()`
     - `cost_delta_usd_30d: z.number().nullable()`
     - `avg_accept_rate_pct_30d: z.number().nullable()`
     - `most_active_agent: z.object({ agent_id: z.string(), agent_name: z.string(), runs_30d: z.number().int() }).nullable()`
   - Leave `AgentPerf.agents`, `AgentPerf.cost_by_agent`, `AgentPerf.cost_by_model` as-is (types already correct once `PerfCostSegment` above is updated).
2. **`contracts/observability.ts` — add an additive detail wrapper around the existing, unrouted `AgentStats`** (lines 116-139 in both files; do not modify `AgentStats` itself — it stays exactly as-is per spec §9 "reuses the existing...shape for its base metrics...unchanged"). Add, after `AgentStats`:
   - `AgentRunHistoryRow`: `{ run_id: string; ran_at: string; status: string | null; cost_usd: number | null; findings_count: number | null; pr_number: number | null }`
   - `WeeklySeverityPoint`: `{ week_start: string; CRITICAL: number (int); WARNING: number (int); SUGGESTION: number (int) }`
   - `AgentRankedUsageRow`: `{ id: string; name: string; usage_estimate: number }` (shared shape for both `most_used_skills` and `memory_pulled_summary`)
   - `AgentStatsDetail = AgentStats.extend({ cost_delta_usd_30d: z.number().nullable(); weekly_findings_by_severity: z.array(WeeklySeverityPoint); most_used_skills: z.array(AgentRankedUsageRow); memory_pulled_summary: z.array(AgentRankedUsageRow); run_history: z.array(AgentRunHistoryRow) })` — matches the `EvalBatchDetail = EvalBatch.extend({...})` pattern already used in `eval-batch.ts:120-124`.
3. **`contracts/knowledge.ts` — change `SkillStats.findings_by_category`** (line 158 in both files): from `z.array(z.object({ category: z.string(), count: z.number().int() }))` to `z.array(z.object({ category: z.string(), estimated_cost_usd: z.number().nullable() }))`. Null means every run contributing to that category has unknown cost (AC-28); this is distinct from AC-23's existing "zero findings in 30d" empty-state (which is a client-side "no data at all" branch, unchanged). Do **not** change `accept_rate_pct`'s type (`z.number()`, line 155) — it stays non-nullable; `0` becomes a real, meaningful value once Step 6 fixes the producer. **This is a breaking change to a live contract:** the sole client consumer, `client/src/app/skills/_components/SkillDetail/StatsTab.tsx`, reads the old `.count` field at lines 39, 54, and 78 and will fail to typecheck the moment this change lands — that break is deliberate and expected (a cross-wave transient, resolved only when Step 9 updates that file two waves later); do **not** touch `StatsTab.tsx` in this step — it is not in Step 2's owned paths.

**Verify:**
- [ ] `cd server && pnpm typecheck` passes
- [ ] `cd client && pnpm typecheck` passes EXCEPT for 3 pre-identified, expected errors in `client/src/app/skills/_components/SkillDetail/StatsTab.tsx` (lines 39, 54, 78 — `.count` references against the now-renamed `estimated_cost_usd` field). This is a deliberate, known cross-wave transient: `StatsTab.tsx` is Step 9's owned path, not Step 2's, and stays broken until Step 9 lands two waves later. Do not patch it here and do not report this as a Step 2 failure — confirm only that these are the *sole* 3 client typecheck errors (no other unexpected breakage introduced).
- [ ] `diff server/.../productionize.ts client/.../productionize.ts` shows only the pre-existing, untouched `provider` enum line as a difference
- [ ] `diff` for `observability.ts` and `knowledge.ts` shows no differences (fully identical)

**Commit:** `feat(shared-contracts): extend AgentPerf, AgentStats, SkillStats for Cost Surgery UI (Spec B)`

---

### Step 3: New/extended shared chart primitives

**Dependencies:** none
**Owned paths:** `client/src/vendor/ui/primitives/CircularScore.tsx`, `client/src/vendor/ui/charts/WeeklyStackedBar.tsx` (new), `client/src/vendor/ui/charts/index.ts`, `client/src/vendor/ui/charts/MetricCard.tsx`
**What to do:**

Keep every new/changed primitive's props **generic** (no import of `AgentStatsDetail`/`AgentPerf` types) so this step has zero dependency on Step 2 and stays truly parallel.

1. **Extend `CircularScore`** (`client/src/vendor/ui/primitives/CircularScore.tsx:3-11`) with an optional `color?: string` prop that, when provided, overrides the computed `score >= 75 ? ok : score >= 50 ? warn : crit` threshold color (keep the threshold logic as the default when `color` is omitted, so every existing caller — `RunHistory.tsx`, `VerdictBanner`, `PRRow.tsx`, `DocDetail.tsx` — is unaffected). This is the "radial/ring gauge" the spec's Implementation Notes call for (AC-10) — reused via extension, not rebuilt.
2. **Build `WeeklyStackedBar`** (new file, `client/src/vendor/ui/charts/WeeklyStackedBar.tsx`), Recharts-backed (`BarChart` + `Bar` per severity with `stackId="weekly"`), generic props: `{ data: Array<{ label: string; CRITICAL: number; WARNING: number; SUGGESTION: number }>; height?: number }`. Use the existing severity color tokens from `client/src/vendor/ui/primitives/tokens.ts` (`SEV.CRITICAL.c = "var(--crit)"`, `SEV.WARNING.c = "var(--warn)"`, `SEV.SUGGESTION.c = "var(--sugg)"`) for the three `Bar fill` colors — do not invent new colors. Export it from `client/src/vendor/ui/charts/index.ts` alongside the existing exports.
3. **Accessibility (§7 NFR — "expose the headline numeric value to assistive technology, not only as a visual shape"):** both the extended `CircularScore` usage and `WeeklyStackedBar` need a caller-visible headline number outside the SVG. Add a visually-hidden (e.g. `sr-only`-style absolute-positioned, zero-size) `<span>` sibling in each component that renders a plain-text summary (`CircularScore`: `"{score}%"` equivalent already renders as visible text inside the ring, so this one is likely already satisfied — verify; `WeeklyStackedBar`: add `aria-label` on the chart container summarizing total findings per severity across the 8 weeks, e.g. `"{critTotal} critical, {warnTotal} warning, {suggTotal} suggestion findings over the last 8 weeks"`).
4. **`MetricCard` cost-delta color fix:** add an optional `invertColor?: boolean` prop to `MetricCard` (`client/src/vendor/ui/charts/MetricCard.tsx:6-19`). Today `up = delta > 0` always maps to `var(--ok)` (green) — correct for "recall went up" but **wrong** for "cost went up" (spending more is bad). When `invertColor` is true, flip the color mapping (`up → var(--crit)`, `down → var(--ok)`) while leaving the numeric value/arrow-direction untouched. Every future cost-delta usage (Steps 7 and 8) must pass `invertColor`.

**Verify:**
- [ ] `cd client && pnpm typecheck` passes
- [ ] `cd client && pnpm test` passes (existing `Sparkline.test.tsx` and any `CircularScore` usage sites still pass unmodified)
- [ ] New: a smoke test for `WeeklyStackedBar` rendering 8 bars with correct per-severity heights and the `aria-label` summary present

**Commit:** `feat(ui-charts): add WeeklyStackedBar, extend CircularScore + MetricCard for Agent Stats/Performance`

---

### Step 4: Relocate `RunTraceDrawer` to a shared location

**Dependencies:** none
**Owned paths:** `client/src/components/RunTraceDrawer/**` (new), `client/src/app/repos/[repoId]/pulls/[number]/_components/RunTraceDrawer/**` (deleted), `client/src/app/repos/[repoId]/pulls/[number]/page.tsx` (import line only)
**What to do:**

1. Move the entire folder `client/src/app/repos/[repoId]/pulls/[number]/_components/RunTraceDrawer/` (9 files: `RunTraceDrawer.tsx`, `RunTraceDrawer.test.tsx`, `constants.ts`, `helpers.ts`, `index.ts`, `styles.ts`, `_components/{atoms.tsx, FindingsSection, PromptBlock, PromptModalBody, ToolCallRow, TraceBody, TraceSection}`) to `client/src/components/RunTraceDrawer/` — same internal structure. All internal relative imports (`../../styles`, `../../constants`, `../../helpers`) stay within the moved subtree and need no change. No co-located CSS to worry about (styles are JS objects in `styles.ts`).
2. Fix the two test files' relative imports to `messages/en/runs.json` (depth changes with the move):
   - `RunTraceDrawer.test.tsx` (top level of the moved folder): was `"../../../../../../../../messages/en/runs.json"` (8 levels, from the old nested PR-detail location) → becomes `"../../../messages/en/runs.json"` (3 levels: `RunTraceDrawer/ → components/ → src/ → client/`).
   - `_components/TraceBody/TraceBody.test.tsx`: was `"../../../../../../../../../../messages/en/runs.json"` (10 levels) → becomes `"../../../../../messages/en/runs.json"` (5 levels: `TraceBody/ → _components/ → RunTraceDrawer/ → components/ → src/ → client/`).
   - Recompute by counting directories at implementation time; do not copy these numbers blindly if the actual file tree differs from what's described here.
3. Update `client/src/app/repos/[repoId]/pulls/[number]/page.tsx:18` — change `import RunTraceDrawer from "./_components/RunTraceDrawer";` to `import RunTraceDrawer from "@/components/RunTraceDrawer";` (matches the existing `@/components/app-shell`, `@/components/repo-not-found`, `@/components/confirm-modal` import convention already used in the same file, lines 11-13). No other line in `page.tsx` changes — the component's prop usage (`runId`, `agentName`, `prNumber`, `findings`, `running`, `onClose`) is unaffected by the move.
4. Do not change the component's prop signature (`{ runId: string; agentName?: string | null; prNumber?: number | null; findings?: FindingRecord[]; running?: boolean; onClose: () => void }`) in this step — Step 8 (Agent Stats tab) is responsible for how it's invoked from the new call site, including which props it can supply (e.g. `findings` may be omitted there).

**Verify:**
- [ ] `cd client && pnpm typecheck` passes
- [ ] `cd client && pnpm test` — both relocated test files pass from their new location
- [ ] Manually confirm (via the PR-detail page, per the "use manual server/client" convention — do not start your own dev server) that clicking a run in the PR-detail timeline still opens the drawer exactly as before — this is a pure relocation, zero behavior change expected

**Commit:** `refactor(client): relocate RunTraceDrawer to src/components for cross-route reuse`

---

### Step 5: Server — Agent Performance fleet read + Agent Stats detail read

**Dependencies:** Step 2 (needs `AgentPerf`/`AgentStatsDetail` contracts)
**Owned paths:** `server/src/modules/agents/routes.ts`, `server/src/modules/agents/service.ts`, `server/src/modules/agents/repository.ts`
**What to do:**

Both endpoints live in the `agents` module (no cross-module import per R6/AP-4) and are implemented together because they share the same three files — see the parallelization-map note in §5 for why this isn't split further.

1. **Repository — new queries in `agents/repository.ts`** (all workspace-scoped, all filtering `eq(agentRuns.source, 'local')`):
   - `costWindowsByAgent(workspaceId)`: one query returning, per `agentId` (grouped, `agentId IS NOT NULL` only — AC-29), `{ cost30d: number|null, costPrior30d: number, runs30d: number }` using `sql`sum(cost_usd) filter (where ran_at >= now() - interval '30 days')`` for the current window and `sql`coalesce(sum(cost_usd) filter (where ran_at >= now() - interval '60 days' and ran_at < now() - interval '30 days'), 0)`` for the prior window (AC-27: a zero/no-run prior window is a legitimate `0`, never null) — follow the exact `sql<...>`/`.groupBy` idiom already used in `runStatsByAgent` (`repository.ts:271-294`).
   - `workspaceCostWindows(workspaceId)`: same shape as above but ungrouped (whole-workspace totals, no `agentId` filter — AC-29's workspace-total-includes-deleted-agents rule), for `AgentPerf.summary.total_cost_usd_30d`/`cost_delta_usd_30d`.
   - `mostActiveAgent30d(workspaceId)`: `agentId`, `agent_name` (join `agents`), `count(*)` filtered to `ran_at >= now() - interval '30 days'`, `agentId IS NOT NULL`, ordered desc, limit 1.
   - `avgAcceptRate30d(workspaceId)`: reuse `acceptanceByAgent`'s join shape (`findings → reviews`) but scope the whole workspace (no `groupBy agentId`) and filter `reviews.createdAt >= now() - interval '30 days'`; return `accepted/(accepted+dismissed)` as a percentage, null if `accepted+dismissed = 0`.
   - `costByAgent30d(workspaceId)` / `costByModel30d(workspaceId)`: `sum(cost_usd) filter (where ran_at >= now() - 30d)` grouped by `agentId`/`model` respectively; a group whose every run has `cost_usd IS NULL` returns `value: null` (AC-28) rather than being omitted or shown as `0`.
   - `weeklyFindingsBySeverity(workspaceId, agentId)`: `findings → reviews` join, `reviews.agentId = :agentId`, `reviews.workspaceId = :workspaceId`, `reviews.createdAt >= now() - interval '8 weeks'`, grouped by `date_trunc('week', reviews.created_at)` + `severity`. **Zero-fill in the service, not SQL**: the SQL query only returns weeks that actually have findings; the service must expand the result into exactly 8 ordered `WeeklySeverityPoint`s (oldest→newest), defaulting any missing (week, severity) combination to `0` — spec §9: "a week with zero findings of a given severity is 0, not omitted."
   - `runHistoryForAgent(workspaceId, agentId)`: `agent_runs` filtered `workspaceId`, `agentId`, `source='local'`, ordered `ranAt desc`, mapped to `AgentRunHistoryRow` (`run_id, ran_at, status, cost_usd, findings_count, pr_number`) — style-reference only from `reviews/repository/run.repo.ts:46`'s `listRunsForPull`, do not import it.
   - `mostUsedSkillsApprox(agentId)`: select `agent_skills` rows for `agentId` ordered by `order` asc, joined to `skills` for the name; every returned skill gets `usage_estimate` = that agent's own run count (from `runStatsByAgent`/a scoped count) — every linked skill is assumed present in every run (system-prompt inclusion), so this is intentionally a flat-magnitude, order-ranked approximation, exactly matching spec §8's "an agent's linked skills weighted against its run volume." Empty list when the agent has no linked skills (AC-13 edge case).
   - `memoryPulledSummary(agentId)`: return `[]` unconditionally — no write instrumentation exists (`run-executor.ts` hardcodes `memory_pulled: []`); this is an honest empty read, not a stub to fill in later within this spec (AC-14, Non-goal).
2. **Service — `AgentsService`:**
   - `async performance(workspaceId: string): Promise<AgentPerf>` — composes the queries above (parallel `Promise.all`, following the exact composition style of the existing `stats()` method at `service.ts:77-96`) into the `AgentPerf` shape from Step 2. For `agent_rows`: **every** agent in the workspace appears, including zero-run ones (AC-3) — start from `this.repo.list(workspaceId)` (existing) and left-join in the aggregates, defaulting missing entries to `{runs:0, findings_total:0, ..., accept_rate: null}` (never `0` for accept-rate on a zero-run agent).
   - `async statsDetail(workspaceId: string, agentId: string): Promise<AgentStatsDetail | undefined>` — first confirms the agent exists in this workspace via `this.get(workspaceId, agentId)` (existing, `service.ts:66-69`), returns `undefined` on miss (route throws `NotFoundError`, matching the existing `GET /agents/:id` pattern). Composes the existing base `AgentStats` fields (a new query analogous to today's card-stats aggregation, but scoped to one agent instead of grouped-by-all) plus the five additive fields from the repository queries above.
3. **Routes — `agents/routes.ts`:**
   - `app.get('/agents/performance', async (req) => { const { workspaceId } = await getContext(app.container, req); return service.performance(workspaceId); });` — place near the existing `app.get('/agents/stats', ...)` at line 89-92.
   - `app.get('/agents/:id/stats', { schema: { params: IdParams } }, async (req) => { const { workspaceId } = await getContext(app.container, req); const detail = await service.statsDetail(workspaceId, req.params.id); if (!detail) throw new NotFoundError('Agent not found'); return detail; });` — place near the other `/agents/:id/*` routes (after line 99).
   - Update the module's route-map doc comment (`routes.ts:25-41`) to list both new routes.

**Verify:**
- [ ] `cd server && pnpm typecheck` passes
- [ ] `cd server && pnpm exec vitest run --exclude '**/*.it.test.ts'` passes (no hermetic regressions)
- [ ] New integration tests (see §7) pass against Docker Postgres
- [ ] `GET /agents/:id/stats` returns 404 (not another workspace's data) for a cross-workspace id

**Commit:** `feat(agents): add GET /agents/performance and GET /agents/:id/stats (Cost Surgery UI, Spec B)`

---

### Step 6: Server — Skill Stats accept-rate fix + dollar conversion

**Dependencies:** Step 2 (needs the updated `SkillStats` contract)
**Owned paths:** `server/src/modules/skills/repository.ts`, `server/src/modules/skills/service.ts`
**What to do:**

1. **Fix the hardcoded `accept_rate_pct: 0`** at the 3 sites in `skills/repository.ts` (lines 167, 192, 258 — one per early-return branch plus the final return of `stats()`). Compute it the same way `agents/repository.ts`'s `acceptanceByAgent` does: over the skill's already-computed `recentFindings` set (the same 30-day, agent-linked finding set the category breakdown uses, lines 227-238) — `accepted / (accepted + dismissed)`, as a percentage. Since `accept_rate_pct`'s type stays non-nullable `z.number()` (Step 2, unchanged), return `0` when `accepted + dismissed === 0` — this is now a real, meaningful `0` (AC-22: "0 is now a real, possible value, not a placeholder"), not the old always-`0` placeholder.
2. **Convert `findings_by_category` from counts to an even-split dollar estimate** (lines 226-250):
   - Keep the existing category-grouping query/logic that produces `{category, count}` pairs (unchanged) as the finding-count denominator source.
   - Add a join from the same `recentFindings` set through `reviews.runId → agent_runs.id` to pull `cost_usd` for every contributing run.
   - Compute `totalKnownCost = sum(cost_usd) filter (where cost_usd is not null)` and `totalFindingsCount = sum(count)` across all categories.
   - If **no** contributing run has a known cost (`totalKnownCost` is null/every run's `cost_usd` is null), every category's `estimated_cost_usd` is `null` (AC-28) — do this check once, not per category.
   - Otherwise, for each category: `estimated_cost_usd = totalKnownCost * (category.count / totalFindingsCount)` — the even split described in spec §8/§9 ("contributing-run cost split by that category's share of the trailing-30-day finding count"). Do this arithmetic in the service layer (`skills/service.ts`), not raw SQL, for testability.
   - AC-23 (zero findings in 30d → existing empty state unchanged): if `recentFindings` is empty, `findings_by_category` stays `[]` exactly as it does today — no behavior change to that branch.

**Verify:**
- [ ] `cd server && pnpm typecheck` passes
- [ ] `cd server && pnpm exec vitest run --exclude '**/*.it.test.ts'` passes
- [ ] New tests (see §7) confirm: real accept-rate (not always 0), correct even-split arithmetic, `null` when all contributing runs have unknown cost, unchanged empty-state on zero findings

**Commit:** `fix(skills): compute real accept_rate_pct and convert findings_by_category to an even-split dollar estimate`

---

### Step 7: Client — Agent Performance page (fleet)

**Dependencies:** Step 2 (types), Step 5 (data)
**Owned paths:** `client/src/app/agent-performance/**` (new), `client/src/lib/hooks/agent-performance.ts` (new), `client/messages/en/agentPerformance.json`, `client/src/vendor/ui/nav.ts`, `client/messages/en/shell.json`
**What to do:**

1. **Hook** — new file `client/src/lib/hooks/agent-performance.ts`: `useAgentPerformance()` → `api.get<AgentPerf>('/agents/performance', {signal})` via TanStack Query, following the exact pattern of `useSkillStats` (`client/src/lib/hooks/skills.ts:119-125`) / `useBlast` (`client/src/lib/hooks/blast.ts:13-16`). A **new** file (not an addition to `client/src/lib/hooks/agents.ts`) so this step and Step 8 never touch the same hooks file.
2. **Route** — `client/src/app/agent-performance/page.tsx` (Server Component shell per `client/src/app/AGENTS.md`, delegating to a client component) + `_components/AgentPerformanceView/AgentPerformanceView.tsx` (`"use client"`), mirroring the `client/src/app/skills/` page-plus-`_components` layout.
3. **KPI summary (AC-1):** 4 `MetricCard`s — total runs (`summary.total_runs_all_time`, no delta), total cost 30d (`summary.total_cost_usd_30d`, `delta=summary.cost_delta_usd_30d`, `invertColor` from Step 3), blended accept-rate 30d (`summary.avg_accept_rate_pct_30d`, no delta), most-active agent (`summary.most_active_agent.agent_name` + `"{runs_30d} runs"` subtext, or an empty dash when null).
4. **Cost breakdowns (AC-2):** two `Donut` components (`client/src/vendor/ui/charts/Donut.tsx`) for `cost_by_agent` and `cost_by_model` — `Donut`'s `segments` prop expects `{label, value, color}`; assign colors from the existing `DONUT_COLORS`-style palette (`["#ef4444","#f59e0b","#3b82f6","#8b5cf6","#10b981","#6366f1"]`, cycling). A segment with `value: null` (AC-28) renders as "—"/unavailable in its legend row instead of being passed to the pie slice as `0`.
5. **Table (AC-3, AC-4, AC-5):** one row per `agent_rows` entry, including zero-run agents (`accept_rate: null` → render "—", not "0%"). Sort control (accept-rate / runs / cost — `agentPerformance.json`'s existing `sort.*` keys) reorders the already-fetched array **client-side**, no new request. Row click navigates to `/agents/:id?tab=stats` (AC-5) — coordinate the query-param/tab-selection contract with Step 8's `AgentEditor` tab wiring (both read the same `?tab=stats` convention the editor already uses for its other tabs, per `AgentEditor.tsx`'s existing tab-state handling).
6. **Empty/error/loading (AC-7, AC-8, AC-9):** `isLoading` → skeleton placeholders for the KPI row + table (reuse `Skeleton` from `@devdigest/ui`, matching `StatsTab.tsx`'s existing skeleton pattern at lines 135-144). No agent in the workspace has any run at all → the page's dedicated empty state (`agentPerformance.json`'s existing `empty.title`/`empty.body`) instead of KPI+table. Fetch error → `loadError` message only, **no retry control** (AC-8 is explicit about this).
7. **i18n additions** to `client/messages/en/agentPerformance.json`: add `summary.costDelta` (label for the delta chip) and `summary.mostActiveRuns` (e.g. `"{count} runs"` subtext) — the file otherwise already has everything needed (`title, subtitle, loadError, summary.{totalRuns,avgAcceptRate,totalCost,mostActive}, costByAgent, costByModel, noCost, sort.*, table.*, empty.*`). Do **not** add an `avgDuration` key — not required by any AC.
8. **Navigation (AC-6):** `client/src/components/app-shell/helpers.ts:37` already maps `/agent-performance` → active key `"agent-performance"`. Add the missing pieces: an entry in `client/src/vendor/ui/nav.ts`'s `NAV` array (pick the appropriate section — WORKSPACE or GLOBAL, matching how `agents`/`skills` are categorized there) and a `"agent-performance"` key in `client/messages/en/shell.json`'s `nav` object (alongside the existing `pulls, agents, skills, ...` keys).

**Verify:**
- [ ] `cd client && pnpm typecheck` passes
- [ ] `cd client && pnpm test` passes, including new RTL tests (§7)
- [ ] Manually confirm the nav entry appears and routes correctly (use the user's own :3000, do not start a new dev server)

**Commit:** `feat(client): Agent Performance fleet page (Cost Surgery UI, Spec B)`

---

### Step 8: Client — Agent Stats tab

**Dependencies:** Step 2 (types), Step 3 (WeeklyStackedBar, extended CircularScore/MetricCard), Step 4 (relocated RunTraceDrawer), Step 5 (data)
**Owned paths:** `client/src/app/agents/[id]/_components/AgentEditor/**` (constants.ts + AgentEditor.tsx + new `StatsTab/` subfolder), `client/src/lib/hooks/agents.ts` (add one hook), `client/messages/en/agents.json`
**What to do:**

1. **Hook** — add `useAgentStatsDetail(agentId: string)` to the existing `client/src/lib/hooks/agents.ts` (the sole addition to that file — Step 7 does not touch it): `api.get<AgentStatsDetail>(`/agents/${agentId}/stats`, {signal})`, same TanStack Query pattern as `useAgentStats()` (lines 16-22, which stays completely unchanged — it still targets `/agents/stats` for `AgentCardStats[]`, unrelated to this new endpoint).
2. **Wire the tab:** in `AgentEditor`'s sibling `constants.ts`, add `"stats"` to the `TABS` array (currently `[config, skills, context, evals, ci]` with a comment "Stats added in a later lesson" — remove that comment). In `AgentEditor.tsx`'s render-branch switch (lines 27-37), add `stats → StatsTab`.
3. **Build `StatsTab/StatsTab.tsx`** (new, co-located under `AgentEditor/`), consuming `useAgentStatsDetail(agent.id)`:
   - **Base KPIs (AC-10):** runs, findings totals, accepted/dismissed/pending counts, accept-rate as the extended `CircularScore` (score = `Math.round(accept_rate * 100)`; when `accept_rate` is `null` — an agent with runs but zero accepted/dismissed actions — render a muted "—" in place of the ring, never a fabricated `0%` ring), dismiss-rate, avg findings/run, total cost, avg cost, avg latency — all straight off `AgentStatsDetail`'s base `AgentStats` fields.
   - **Cost delta (AC-11):** `MetricCard` with `delta=cost_delta_usd_30d`, `invertColor` (from Step 3), alongside `total_cost_usd`.
   - **Weekly severity (AC-12):** `WeeklyStackedBar` (Step 3) fed by `weekly_findings_by_severity`, shown in addition to the existing all-time `findings_by_severity` totals (both stay visible — the weekly chart does not replace the totals).
   - **Most-used skills (AC-13):** `BarRow`-based ranked list from `most_used_skills`, visually labeled "approximation" (new i18n key, see below) — empty list renders as an empty list, not an error (AC-13 edge case).
   - **Most-pulled memory (AC-14):** `memory_pulled_summary` is always `[]` today — render the panel's dedicated empty state (new copy, e.g. "No memory pulls recorded yet"), never an empty chart shape.
   - **Run history (AC-15, AC-16):** a table/list from `run_history` (studio-only, per Step 5's `source='local'` filter). Clicking a row opens the relocated `RunTraceDrawer` (Step 4) via `import RunTraceDrawer from "@/components/RunTraceDrawer"`, passing `runId` (required), `agentName={agent.name}`, `prNumber={row.pr_number}`; `findings` may be omitted (the drawer fetches its own trace/log data independently by `runId`) — verify this doesn't break the drawer's rendering before assuming it's fully optional.
   - **Empty/error/loading (AC-17, AC-18, AC-19):** an agent with zero runs ever (`runs === 0` on the base `AgentStats`) → a dedicated "no runs yet" empty state for the whole tab instead of zeroed-out charts. Fetch error → error message, no retry control. Loading → skeleton placeholders, matching `StatsTab.tsx`'s (Skill Stats) existing skeleton pattern as the visual reference.
4. **i18n:** add a new top-level `"stats"` section to `client/messages/en/agents.json` (parallel to the existing `"evals"` section), covering all new labels (KPI labels, "approximation" badge text, empty states, run-history column headers). Every string in this new tab goes through `useTranslations("agents")` — do not hardcode.

**Verify:**
- [ ] `cd client && pnpm typecheck` passes
- [ ] `cd client && pnpm test` passes, including new RTL tests (§7)
- [ ] Manually confirm: opening an agent with runs shows real data; opening a never-run agent shows the empty state; clicking a run-history row opens the (relocated) drawer with no console errors

**Commit:** `feat(client): Agent Stats tab — wires the reserved AgentStats contract end-to-end (Cost Surgery UI, Spec B)`

---

### Step 9: Client — Skill Stats tab extension

**Dependencies:** Step 2 (types — also carries the client-consumer half of Step 2's `SkillStats.findings_by_category` breaking change: `StatsTab.tsx`'s `.count` references at lines 39/54/78 are left deliberately broken by Step 2 as a cross-wave transient, see Step 2's Verify block — this step is what restores full client typecheck green), Step 6 (data)
**Owned paths:** `client/src/app/skills/_components/SkillDetail/StatsTab.tsx`, `client/messages/en/skills.json`
**What to do:**

1. **`DonutChart` → dollar values (AC-20):** change the hand-rolled `DonutChart` component (`StatsTab.tsx:38-84`) to render `estimated_cost_usd` instead of `count` — update the `total` reduction (`data.reduce((s,d) => s + d.count, 0)` → sum `estimated_cost_usd ?? 0`, but see the null-handling note below), the per-slice `sweep` angle calculation, and the legend's right-aligned value (currently `{s.count}` at line 78 → format as currency, e.g. `$${estimated_cost_usd.toFixed(2)}`).
   - When a category's `estimated_cost_usd` is `null` (AC-28), exclude it from the pie's angle math (do not treat as `0`, which would visually vanish it) but still list it in the legend with an "unavailable"/"—" value — do not silently drop the category from the list.
   - AC-23 (zero findings in 30d) stays exactly as today: `data` is `[]`, the existing "No findings yet" branch (line 40-46) is unchanged.
2. **Estimate badge (AC-21):** add a small, visually distinct label/icon next to the "Findings by category" panel header (`StatsTab.tsx:223-224`, currently `<Icon.Tag size={13} /> Findings by category`) reading something like "estimated" — this is the one new string in this file that **must** go through next-intl (see i18n below); every other string in this file stays hardcoded (pre-existing, out of scope — see §4 Constraints).
3. **Real accept-rate (AC-22):** no client code change needed beyond what already exists (`StatCard label="Accept rate" value={stats.accept_rate_pct} unit="%"`, line 154) — the value now reflects Step 6's real computation instead of the old hardcoded `0` automatically, since the type didn't change.
4. **i18n:** add a new `"stats"` section to `client/messages/en/skills.json` (parallel to the existing `"evals"` section already used by sibling tabs via `useTranslations("skills")`) with at minimum `stats.estimated: "Estimated"`. Wire `StatsTab.tsx` to call `const t = useTranslations("skills")` and use `t("stats.estimated")` for the new badge only — do not retrofit the file's other hardcoded strings in this step.

**Verify:**
- [ ] `cd client && pnpm typecheck` passes
- [ ] `cd client && pnpm test` passes, including new RTL tests (§7)
- [ ] Manually confirm the donut now shows dollar amounts with the "Estimated" badge, and a skill with zero 30-day findings still shows the unchanged "No findings yet" state

**Commit:** `feat(client): Skill Stats tab — dollar-denominated findings-by-category + real accept-rate (Cost Surgery UI, Spec B)`

---

## 6. Acceptance Criteria

| AC / Contract field | Satisfied by |
|---|---|
| AC-1 (fleet KPI summary) | Step 5 (`AgentPerf.summary`), Step 7 (`MetricCard`s) |
| AC-2 (cost-by-agent/model) | Step 5 (`costByAgent30d`/`costByModel30d`), Step 7 (`Donut`s) |
| AC-3 (zero-run agent row, accept-rate unavailable) | Step 5 (`performance()` composition), Step 7 (table render) |
| AC-4 (client-side sort, no network) | Step 7 |
| AC-5 (row click → Stats tab) | Step 7 (navigation), Step 8 (tab target) |
| AC-6 (nav reachability) | Step 7 (nav.ts/shell.json) |
| AC-7 (empty state, no runs anywhere) | Step 7 |
| AC-8 (load-error, no retry) | Step 7 |
| AC-9 (loading skeletons) | Step 7 |
| AC-10 (Agent Stats base KPIs incl. ring gauge) | Step 5 (`statsDetail`), Step 3 (`CircularScore`), Step 8 |
| AC-11 (Agent Stats cost delta) | Step 5 (`costWindowsByAgent`), Step 8 |
| AC-12 (weekly severity stacked bar) | Step 5 (`weeklyFindingsBySeverity`), Step 3 (`WeeklyStackedBar`), Step 8 |
| AC-13 (most-used skills, labeled approximation) | Step 5 (`mostUsedSkillsApprox`), Step 8 |
| AC-14 (most-pulled memory, empty state) | Step 5 (`memoryPulledSummary`), Step 8 |
| AC-15 (run-history, studio-only) | Step 5 (`runHistoryForAgent`, `source='local'`), Step 8 |
| AC-16 (run-history row → drawer) | Step 4 (relocation), Step 8 (wiring) |
| AC-17 (zero-runs-ever empty state) | Step 8 |
| AC-18 (load-error, no retry) | Step 8 |
| AC-19 (loading skeletons) | Step 8 |
| AC-20 (findings-by-category → $) | Step 6 (repository/service), Step 2 (contract), Step 9 (`DonutChart`) |
| AC-21 (estimate visual mark) | Step 9 |
| AC-22 (real accept_rate_pct) | Step 6 |
| AC-23 (zero-findings empty state unchanged) | Step 6 (no behavior change), Step 9 (no behavior change) |
| AC-24 (every new read workspace-scoped) | Step 5, Step 6 (§4 constraint, R1) |
| AC-25 (unavailable, not fabricated 0, for pre-Spec-A runs) | Step 1 (`.nullish()` fields) + Step 7 `cost_by_model` null→"—" (AC-28 handling). **Resolved 2026-07-12 (user): no surface renders Spec A's per-block/cache/boilerplate token fields (not in the mockups; AC-25 is a conditional non-fabrication guard). The only displayed Spec A field — cost-by-model — handles unavailable via "—". Per-block token display is descoped to a follow-up (see §8).** |
| AC-26 (CI runs excluded everywhere) | Step 5, Step 6 (`source='local'` filter, §4 constraint) |
| AC-27 (zero prior window = legitimate $0) | Step 5 (`coalesce(...,0)` prior-window logic) |
| AC-28 (all-unknown-cost estimate = unavailable, not $0.00) | Step 5 (`PerfCostSegment.value: null`), Step 6 (`estimated_cost_usd: null`) |
| AC-29 (deleted agent: counts in workspace total, excluded per-agent) | Step 5 (`workspaceCostWindows` vs `costWindowsByAgent`, §4 constraint — free via `onDelete: 'set null'`) |
| §7 NFR — zero LLM calls | Step 5, Step 6 (§4 constraint, code-review verify) |
| §7 NFR — 2s p95 render | Step 7 (manual browser-trace verify — see §7 Testing Plan) |
| §7 NFR — estimate/approximation visually marked | Step 9 (AC-21), Step 8 (AC-13) |
| §7 NFR — a11y headline number exposed | Step 3 (`aria-label`s on `CircularScore`/`WeeklyStackedBar`) |
| §9 Fleet contract (all fields) | Step 2 (`AgentPerf`), Step 5 |
| §9 Per-agent Stats contract (all fields) | Step 2 (`AgentStatsDetail`), Step 5 |
| §9 Skill Stats contract (2 changed fields) | Step 2 (`SkillStats`), Step 6 |

## 7. Testing Plan

**Server:** integration (`.it.test.ts`, Testcontainers, real DB — required for the date-window/GROUP BY aggregation correctness) vs. hermetic (`.test.ts`, workspace-scoping/route-wiring only). Follows the existing flat `server/test/` convention (e.g. `server/test/agents-stats.it.test.ts` — note: that existing file tests the *old* `/agents/stats` fleet-card endpoint, not this plan's new routes; do not confuse the two).

**Client:** Vitest + RTL, fetch mocked via `vi.mock("@/lib/hooks/...")` — no running server needed. Follow `client/src/app/evals/_components/AgentCard/AgentCard.test.tsx`'s pattern (renders real chart primitives, doesn't mock them) and `client/src/app/skills/_components/SkillDetail/EvalsTab.test.tsx`'s pattern (mocks hooks, wraps in a `renderWithIntl` helper with real `messages/en/*.json`).

| Test | Type | Covers |
|---|---|---|
| `server/test/agent-performance.it.test.ts` | integration | AC-1/2/3/24/26/27/28/29 — fleet aggregation, zero-run agent inclusion, CI exclusion, cost-delta window logic, deleted-agent workspace-vs-per-agent split |
| `server/test/agent-stats-detail.it.test.ts` | integration | AC-10/11/12/13/14/15/24/25/26/27 — per-agent detail composition, weekly zero-fill, most-used-skills approximation, empty memory panel, run-history studio-only filter |
| `server/test/agent-performance-routes.test.ts` | hermetic | route wiring, `GET /agents/:id/stats` 404 on cross-workspace id (mocked service) |
| `server/test/skills-stats.it.test.ts` (new or extends existing skills test) | integration | AC-20/22/23/28 — real accept-rate, even-split arithmetic, all-unknown-cost → null, unchanged zero-findings empty state |
| `client/src/app/agent-performance/_components/AgentPerformanceView/AgentPerformanceView.test.tsx` | RTL | AC-4/5/7/8/9 — sort reorders without a mocked second fetch call, row-click navigation, empty/error/loading states |
| `client/src/app/agents/[id]/_components/AgentEditor/StatsTab/StatsTab.test.tsx` | RTL | AC-16/17/18/19 — drawer opens on row click (mock `RunTraceDrawer`), zero-runs empty state, error/loading states, memory-pulled empty state |
| `client/src/app/skills/_components/SkillDetail/StatsTab.test.tsx` (new — none exists today) | RTL | AC-20/21/22/23 — dollar donut render, estimate badge presence, empty-findings state unchanged |
| `client/src/vendor/ui/charts/WeeklyStackedBar.test.tsx` | RTL/unit | §7 a11y — `aria-label`/accessible summary text present and correct |

**Not automated in this plan (manual/follow-up):**
- §7 NFR "2s p95 render for tens of agents" — browser performance trace against seeded demo data, a manual check, not a unit test.
- §7 NFR "manual screen-reader spot check" — explicitly a human QA step per the spec's own verify clause; the automated half (accessible-name presence) is covered by the `WeeklyStackedBar` test above.

## 8. Out of Scope

- Everything in the spec's own Non-goals (§2): no external billing-analytics integration, no cross-workspace comparison, no CSV export, no alerting, no per-user dashboard customization, no historical backfill of pre-Spec-A fields, no changes to the review engine or CI runner, no unified studio+CI run history, no real most-used-skills/memory-pull instrumentation (both stay labeled approximation/empty-state), no new cost-baseline snapshot table or migration, no change to `AgentCardStats`, no click-to-filter on cost breakdowns.
- Fixing `StatsTab.tsx`'s (Skill Stats) pre-existing hardcoded-string debt beyond the one new "Estimated" badge this plan adds (§4 Constraints) — a larger, separate i18n-retrofit task.
- The `adapters.ts` and `productionize.ts` provider-enum drift between client/server `vendor/shared` — pre-existing, unrelated to Spec B, confirmed via `diff` but explicitly not touched by any step here.

**Implementer follow-ups (flagged, not blocking, per spec §12):**
1. Document the Recharts exception formally in `client/AGENTS.md` (currently only lists `@xyflow/react`) — a doc-only change, outside this plan's write boundary but should be done alongside or immediately after Step 3/7/8/9 land.
2. After Step 4, do a final regression pass confirming the PR-detail page's `RunTraceDrawer` usage is pixel-identical to before the move — the plan verifies this via typecheck + existing tests, but a human visual check is worth the two minutes given it's a load-bearing, frequently-used component.
3. **Per-block token display (AC-25 tail), descoped 2026-07-12, then IMPLEMENTED 2026-07-12 (follow-up).** Spec A's `cost_report` per-block/cache/boilerplate fields were mirrored into the client contracts (Step 1) but no Spec B surface rendered them. Added a "Cost breakdown" `TraceSection` to `client/src/components/RunTraceDrawer/_components/TraceBody/TraceBody.tsx` (icon `DollarSign`, widened on `TraceSection`'s icon union), between Stats and Findings: per-block tokens as a sorted (biggest-first) bar list reusing the existing Prompt-assembly i18n labels (`trace.prompt.*`) so "diff" (the `user` block) visibly tops the list when it does; cache row (`cached_input_tokens`, `cache_control_applied`); boilerplate exclusion ("N files excluded, −X tokens" + the file list — matches the server's own `run-executor.ts:465-467` log line); map-reduce (`chunks`/`threshold`, or a "single-pass" line when `chunk_count <= 1`). Non-fabrication (AC-25) honored throughout: `cost_report` absent (older runs) → one muted unavailable line, never fabricated zeros; a per-block `'unavailable'` token value → "—", excluded from the bar-width scale. New i18n under `runs.json`'s `trace.costBreakdown.*`. 3 new tests in `TraceBody.test.tsx` (unavailable state, full cost_report render, single-pass map-reduce) — 8/8 pass in the full `RunTraceDrawer` suite, client typecheck clean.
