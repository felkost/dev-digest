# L08 Cost Surgery — SDD session journal

- **Date:** 2026-07-11
- **Branch:** `feat/lesson_08`
- **Pipeline:** researcher → spec → architecture-reviewer → plan → plan-verifier → implement → test → verify
- **Language:** dialog/journal in Ukrainian; artifacts (spec/plan/code) in English.

## Two components (both in scope)

1. **Task (Cost Surgery):**
   - Ч.1 read the bill — 7-week OpenRouter spend, top-3 cost items; dissect one expensive run's prompt-block token split (system/skills/specs/diff); look for silent cache miss.
   - Ч.2 wire model routing to intent + naive summary (cheap-tier); re-measure; prove no eval regression (L06).
   - Ч.3 boilerplate filter — Smart Diff (L03 `classifyFile`) before prompt assembly; honest "excluded N files, −X tokens" log; mega-PR before/after; bonus: map-reduce token-threshold + bin-packing.
2. **UI mockups (3 surfaces):**
   - Agent Performance page (workspace fleet) — scaffolded (i18n + nav), NOT built.
   - Agent → Stats tab (per-agent drill-down) — planned (`AgentEditor.tsx:2`), NOT built.
   - Skill → Stats tab — BUILT (`StatsTab.tsx`); mockup delta = findings-by-category count→$.

## Grounded state already known (verify + extend, do not re-derive)

- Model routing: `server/src/platform/model-router.ts` `routeModel(task,provider)` (cheap=summary/intent/classify) + dead `PromptCache`. Intent already routed (`run-executor.ts:233`, `routes.ts:244`). Summary uses `resolveFeatureModel` (`settings/feature-models.ts`), NOT routeModel.
- Smart Diff L03: `server/src/modules/reviews/smart-diff-rules.ts` `classifyFile`. Used in `run-executor.ts` `budgetDiff` (line ~850) ONLY when over model budget; also in `brief-generator.ts`.
- Map-reduce: `reviewer-core/src/review/run.ts` `selectMode` = `totalLines>400 && files>1`, per-file chunks, no bin-packing. reviewer-core is side-effect-free + SHARED with `agent-runner/` (CI).
- Cost/tokens: `agent_runs` (tokens_in/out, cost_usd) + `run_traces` (prompt_assembly, stats, `config.source`). Pricing `adapters/llm/pricing.ts` + `platform/price-book.ts`. Tokenizer `container.tokenizer`.
- Evals L06: in-product `server/src/modules/eval/` + client Evals tab; harness pkg `evals/` (`eval:workflow`, `eval:compare`, `eval:delta`).
- UI data GAP: `MOST-PULLED MEMORY` has no source — `run-executor.ts` hardcodes `memory_pulled: []`, embeddings default OFF (`EMBEDDINGS_ENABLED`).
- Insight captured this session: `server/insights.md` (2026-07-11 Quirk — L08 cost-discipline half-wired).

## Scope decisions (user, 2026-07-11)

- **Q1 → TWO separate specs.** Spec A = backend engine (Ч.1–3 + bonus). Spec B = UI dashboards. Sequence: A first (foundation — produces the per-block tokens / boilerplate excluded-tokens / cost-by-model data), then B.
- **Q2 → ALL 3 UI surfaces, fully.** That is Spec B's scope, incl. closing the MOST-PULLED MEMORY data gap (instrument or explicit empty-state).

**Session sequencing:** researcher (R1+R2, both feed both specs) → `spec-creator` for **Spec A (backend)** THIS session → handoff doc queues **Spec B (UI, all 3 surfaces)** with R2's research attached for the next session. Then A goes arch-review → plan → verify → implement in later sessions.

### Still-open (resolve inside spec-creator Q&A)
- Q3 `-$X` delta source: prior-period baseline (new snapshot table/migration) vs diff of two `agent_runs` windows? (Spec B)
- Q4 Part-1 boundary: 7-week/top-3 = manual OpenRouter read; product surfaces only the in-product window? (both)

## Stage log

### Researcher — LAUNCHED 2026-07-11
- R1 (backend/engine/cost/evals) — ✅ DONE.
- R2 (UI/data/design/architecture-placement) — ✅ DONE.

#### R2 findings (UI/data/design, verified with file:line)
- **Skill Stats** = BUILT (`StatsTab.tsx`, `GET /skills/:id/stats`). Deltas: donut shows `count` not `$` (`findings_by_category` has no cost); **NEW stale stub** — `accept_rate_pct` HARDCODED 0 (`skills/repository.ts:167,192,258`) though the accept-join already exists (`agents/repository.ts:298-317`). No test for StatsTab.
- **Agent Performance page** = SCAFFOLD ONLY. i18n `agentPerformance.json` is ORPHANED (no component uses the namespace); nav half-dead (`helpers.ts:37` maps active-key but `vendor/ui/nav.ts` NAV array + `shell.json` + SHORTCUTS have NO entry). i18n missing `avgDuration` key. `agent_runs.model` IS populated → cost-by-model query is accurate.
- **Agent Stats tab** = reserved, NOT built. i18n key `editor.tabs.stats` ALREADY present (`agents.json:55`, between evals+ci). `AgentStats` contract reserved (`observability.ts:116-139`) but `GET /agents/:id/stats` NOT registered — covers the 4 KPI cards, none of the other 5 panels.
- **BIG WIN — mature Recharts `charts/` layer already exists** (`client/src/vendor/ui/charts/`): `MetricCard` (KPI + signed delta + sparkline), `Sparkline`, `Donut` (**`$` is the DEFAULT**), `BarRow` (horizontal bars), `LineChart`. Maps ~1:1 to mockup KPI cards + cost donuts + skill/memory bars. Only NEED TO BUILD: **radial gauge** (extend `CircularScore`) + **weekly stacked-bar** (Recharts BarChart+stackId, use `SEV` token colors). StatsTab's hand-rolled StatCard/DonutChart should be REPLACED by these.
- **AGENTS.md stale:** `client/AGENTS.md:19` lists only React Flow as UI exception; Recharts is a de-facto 2nd exception (`charts/Donut.tsx:3`, `package.json:23`) — update it.
- **Data gaps (the hard part):** (1) MOST-PULLED MEMORY fully absent (`memory_pulled:[]`, no pull_count, `lastUsedAt` unused) → empty-state. (2) MOST-USED SKILLS = approximation (`agent_skills`×runs); real fix precedent = `specs_read` repurpose (`run-executor.ts:552-554`). (3) findings-by-category `$` = no per-finding cost → even-split `cost/findings_count` (modeling decision). (4) `-$` delta = NO baseline anywhere → compute read-time over two `ran_at` windows. (5) SOURCE badge: `agent_runs.source` always `'local'`; CI in SEPARATE `ci_runs` table (NO tokens column) → unified history = UNION of mismatched tables; naming collision with `CiRunSummary.source='gha'`.
- **Reuse:** `RunTraceDrawer` (move to `client/src/components/` for cross-route), `listRunsForPull`→template for `listRunsForAgent`, `formatCost`, `SEV`/`CAT` token maps.
- **Server home:** NEW `agent-performance` module (routes/service/repository) for fleet `GET /agents/performance` + singular `GET /agents/:id/stats`.
- **R2 decisions-for-Spec-B:** cost-per-category approximation Y/N; delta window (7d/30d) + live vs snapshot; run-history `agent_runs`-only vs `⋃ ci_runs`; MOST-USED-SKILLS approx vs retrofit; MOST-PULLED-MEMORY empty-state vs instrument; fix `accept_rate_pct` now?; naming vs `AgentCardStats`; move `RunTraceDrawer`; document Recharts in AGENTS.md.

### Spec stage — decisions RESOLVED (user, 2026-07-11)
- **Evals guard →** BUILD new intent/summary eval capability (extend in-product eval module). Real regression guard. (biggest scope add)
- **Cache →** BOTH: log `usage.cached_tokens` (visibility) + real Anthropic `cache_control` ephemeral on map-reduce system prefix (savings).
- **CI reach →** BOTH studio + CI: inject a pure token-counter into reviewer-core (stays side-effect-free) + wire budget into agent-runner (which has none today).
- Adopted recommendations (stated as spec assumptions): `routeModel` = default source of truth for intent+summary, `resolveFeatureModel` = override, FIX dead `review_intent` control; boilerplate = UNCONDITIONAL pre-assembly exclusion + honest "excluded N, −X tok" event + Dockerfile/.github/.env.example safety regression test; per-block tokens = additive `RunTrace` field, no migration.
- UI decisions (cost-per-category $, delta window, run-history union, memory panel, accept_rate fix) → deferred to Spec B.

### spec-creator — ✅ DONE 2026-07-11 (Spec A backend) — status: APPROVED
- Output: `docs/feature-requirements/2026-07-11-cost-surgery-backend.md` — 30 EARS ACs across 6 workstreams, 2 Mermaid diagrams, zero new LLM calls, Risks + Measurement-Acceptance (tied to lab self-check). Index updated in `docs/feature-requirements/README.md`.
- §13 clarifications RESOLVED (user): deterministic scoring · wire review_intent (backend-only) · per-case editable threshold. Status flipped draft→approved.
- spec-creator agentId (resumable if edits needed): a25536083832b313c.

## Handoff — NEXT SESSION(S)

**State:** researcher ✅ (R1+R2) · Spec A (backend) ✅ approved. Pipeline position: spec done → next is architecture-reviewer → implementation-planner → plan-verifier → /implement → test → /verify.

**Next actions (in order):**
1. **Architecture-reviewer on Spec A** — sanity-check the 6 workstreams against onion/reviewer-core-isolation contracts (esp. WS5 injected token-counter into reviewer-core, WS4/5 agent-runner parity). Then implementation-planner → docs/plans/2026-07-11-cost-surgery-backend-plan.md.
2. **Create Spec B (UI, all 3 surfaces)** with `spec-creator`, feeding R2's research (in this journal). Scope: Agent Performance page + Agent Stats tab + Skill Stats count→$. Resolve R2's 9 UI decisions (cost-per-category $ approximation, delta window 7d/30d live-vs-snapshot, run-history agent_runs-only-vs-⋃ci_runs, MOST-USED-SKILLS approx-vs-retrofit, MOST-PULLED-MEMORY empty-state-vs-instrument, fix accept_rate_pct now?, naming vs AgentCardStats, move RunTraceDrawer, document Recharts in client/AGENTS.md). KEY WIN for B: mature Recharts `charts/` layer already exists (MetricCard/Sparkline/Donut-$/BarRow) — only radial-gauge + weekly-stacked-bar need building.
3. Spec A depends on nothing from B; B consumes A's data (per-block tokens, excluded-tokens, cost-by-model). Build A first.

**Parallelizable next session:** architecture-reviewer(Spec A) ∥ spec-creator(Spec B) can run together.

#### R1 findings (backend, verified with file:line)
1. **Per-block tokens (Ч.1):** `PromptAssembly` (`vendor/shared/contracts/trace.ts:39-53`) stores raw strings, NO token counts. Only diff (conditionally, `budgetDiff`) + per-context-doc (`RunTraceContextDoc`, `trace.ts:62-68`) are counted today. **Precedent to copy = `RunTraceContextDoc`**: add per-slot `tokenizer.count()` in `run-executor.ts` AFTER `reviewPullRequest` returns `outcome.assembly`; server-side, additive to `RunTrace`, NO migration. reviewer-core has no tokenizer (stays pure).
2. **Cache (Ч.1):** `PromptCache` = 100% dead (0 call sites). NO provider caching anywhere — anthropic/openai/openrouter adapters send no `cache_control`, read no `cached_tokens`. Prefix unstable: `task` is FIRST in user msg (per-PR); `intentBlock` sits BEFORE `INJECTION_GUARD` in system msg. **Best exploitable case = within one map-reduce run** (identical system prefix per file-chunk, `run.ts:177`). Fixes: (a) log `usage.cached_tokens` from OpenRouter (already sends `usage:{include:true}`, zero behavior change); (b) `cache_control:{ephemeral}` on system block in `adapters/llm/anthropic.ts` (min 1024 tok, easily cleared).
3. **Routing (Ч.2):** intent live on cheap-tier (`run-executor.ts:233`, `routes.ts:244`). "naive summary" = **Risk Brief** (`brief-generator.ts:184` → `resolveFeatureModel('risk_brief')` → always capable gpt-4.1, ignores `routeModel`). **NEW BUG:** `FEATURE_MODELS` exposes `review_intent` in Settings UI (`SettingsModels.tsx`) but NO code path reads it — a **live user-facing DEAD control**. Must reconcile ownership (routeModel vs resolveFeatureModel) + fix/remove the dead setting.
4. **Boilerplate (Ч.3):** `budgetDiff` (`run-executor.ts:850-891`) trims ONLY when over model budget; under budget lock/generated ship in full. `classifyFile` safe — `Dockerfile`/`.github/workflows`/`.env.example` classify as `wiring`, not boilerplate. Unconditional pre-assembly filter = NEW behavior; keep server-side (agent-runner has NO tokenizer). Honest "excluded N, −X tok" = reuse `tokenizer.count` before greedy-pack, additive `RunTrace` field.
5. **Map-reduce (bonus):** `selectMode` (`run.ts:119`) line>400 && files>1, 1 file=1 call. Cost trap quantified: ~44K overhead sent N times. **agent-runner (CI) inherits, has NO tokenizer, threshold NOT configurable** (no `AgentManifest` field; `run.ts:165`). Token-budget map-reduce needs an INJECTED token counter into reviewer-core (keep pure) OR a studio/CI divergence decision.
6. **Evals L06 (⚠️ CRITICAL CORRECTION):** in-product eval module grades ONLY review-**findings** (`reviewPullRequest`), NOT intent/summary. `evals/` harness pkg grades the **Claude Code dev harness**, not the product. So **NEITHER can assert "intent/summary no regression" today** — the lab's "evals confirm no regression" premise needs NEW eval-case + scoring infra for intent/summary, OR the routing is scoped to the review model, OR regression is proven manually. Name this as an explicit risk.
7. **Migrations/arch:** latest = 0025. No migration for per-slot tokens / excluded-file metrics (fit in `run_traces` JSON). Migration only if a persisted cost-baseline snapshot for the −$ delta is wanted (else compute delta at read-time from `agent_runs`). All backend changes are server/adapter-side; only bonus map-reduce touches reviewer-core.

**R1 decisions-for-spec:** (D1) routeModel vs resolveFeatureModel ownership + fix `review_intent` dead control; (D2) cache = visibility-only vs real `cache_control` vs both; (D3) boilerplate unconditional vs budget-conditional-with-honest-log; (D4) does boilerplate/token-budget reach CI (agent-runner has no tokenizer); (D5) bin-packing agent-runner-compatible day 1 or studio-only first; (D6) new intent/summary eval infra in scope or manual/deferred; (D7) persisted cost baseline (migration) vs read-time delta.
