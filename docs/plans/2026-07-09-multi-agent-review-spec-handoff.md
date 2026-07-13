# Session handoff — Multi-Agent Review (Feature A): SPEC + RESEARCH done (APPROVED) → PLAN next (2026-07-09)

> Open this in the next session to run the **PLAN** stage. Dialogue in Ukrainian,
> artifacts in English. Never commit yourself (user commits). Never restart the
> user's `:3001`/`:3000`. Worktree: `F:/Data/Neoversity_ai/devdigest-review`,
> branch `feat/multi-agent-review`. (Parallel sibling worktree `../devdigest-ci`
> builds Feature B — Export to CI — do NOT touch it.)

---

## Pipeline position

`spec ✅(approved) → researcher ✅ → **plan ⬅ NEXT** → implement → test → verify`

Each stage runs in a **separate session** by design → this doc must let a
cold-start session resume with no prior context.

## Stages 1–2 done — what exists

- **Spec (APPROVED):** [docs/feature-requirements/2026-07-09-multi-agent-review.md](../feature-requirements/2026-07-09-multi-agent-review.md)
  - ID `SPEC-2026-07-09-multi-agent-review` · status **`approved`** · full-stack
  - **44 acceptance criteria** (EARS). §-map: §1 Problem, §2 Goals/Non-goals,
    §3 Stories, §4 Workflow, §5 ACs, §6 Edge Cases, §7 NFR, §8 Inputs,
    §9 Contracts, §10 Untrusted Inputs, §11 Open Items.
  - README index row updated to `(approved)`.
- **Researcher report** fully folded into the spec (citations in §4/§8/§9). Key
  facts below are load-bearing for the plan.

### Capability groups (AC ranges)
1. Agent picker replacing single-or-all run control — AC-1–5
2. Pre-run estimation (avg last-3 successful; MAX time / SUM cost; no-history) — AC-6–9
3. **Execution model — multi-agent concurrency (NEW)** — AC-44
4. Page entry points + Configure-run flow — AC-10–14
5. Live Columns view (running/done/failed, failure isolation, score banding) — AC-15–19
6. Columns/Tabs toggle + Tabs finding detail (actions) — AC-20–26
7. "Where agents disagree" (location grouping, "did not flag", Show-only-conflicts) — AC-27–32
8. Economics legibility + trace/log reuse — AC-33–36
9. Deterministic zero-LLM cross-agent matching (net-new) — AC-37
10. Grouping/workspace scoping, rate limiting, seed data, security — AC-38–43

## Decisions locked (all folded into ACs — do not re-litigate)

| Decision | AC |
|---|---|
| Estimate = **avg of agent's last 3 successful runs**; no history → "—" + marker | AC-6, AC-7 |
| **Any** picker-started run (even 1 agent) → Multi-Agent Review page + grouped multi_agent_run | AC-3 |
| Detail actions: **Accept/Dismiss + Turn-into-eval-case functional**; **Learn / Reply-to-author = stubs** | AC-24–26 |
| Seed demo data (see finding D) | AC-41 |
| **§11 RESOLVED — make ONLY multi-agent runs concurrent** (`Promise.allSettled` + concurrency cap); single-agent + review-all unchanged; wall-clock ≈ slowest agent → AC-8's MAX estimate holds | **AC-44** + NFR (§7) |

## Research findings (verified, `file:line`) — read before planning

- **A. No cross-agent match rule exists** → grouping is **net-new deterministic
  logic** (AC-37). Closest analogs are NOT it: `matchesExpectation`
  (`server/src/modules/eval/scoring.ts:35-38`, finding-vs-expectation) and
  `reduceReviews` (`reviewer-core/src/review/run.ts:195-213`, within-agent chunks).
- **B. Execution is SEQUENTIAL today** (`server/src/modules/reviews/run-executor.ts:204-231`
  — `for…of` with blocking `await runOneAgent`, no `Promise.all`). Diff + PR-intent
  load **once**, shared across agents (`run-executor.ts:146-202`). Failure isolation
  is 2-layer (loop try/catch + per-run try/catch with guaranteed `runBus.complete`).
  **RESOLVED by AC-44**: planner implements a concurrency wrapper (capped
  `Promise.allSettled`) for the multi-agent path only — leaving single-agent and
  `review-all` sequential. This is within Feature A's boundary (reviews/ module).
- **C. Frozen shared contracts, zero runtime consumers** — build against as-is,
  do NOT alter (`server/src/vendor/shared/contracts/observability.ts:23-86`):
  `AgentColumn.status = 'done'|'failed'|'running'`; `ConflictTake.verdict =
  Severity | 'ignored'` (**"did not flag" = `'ignored'`**); `MultiAgentRun` carries
  `columns`, `conflicts`, `total_duration_ms`, `total_cost_usd`. Any shared-contract
  edit needs a `:3001` restart warning.
- **D. Seed** (`server/src/db/seed.ts`): PR **#482 already seeded** (`:189-212`);
  **Security + Performance agents already exist** (`:328,339`). **ADD 3 missing
  personas**: Junior Mentor, Customer-Facing, Architecture (idempotent upsert-by-name,
  non-colliding IDs/slugs). AC-41 reflects this.
- **E. Route shape gap**: `POST /pulls/:id/review` accepts only `agentId` OR
  `all:true` (`RunRequest`, `server/src/vendor/shared/contracts/platform.ts:250-254`;
  route `server/src/modules/reviews/routes.ts:36-53`). Needs a NEW `agentIds:
  string[]` field + a `resolveTargets` branch (`service.ts:54-65`). But
  `service.runReview` **already accepts an arbitrary `AgentRow[]`** and fans each
  into its own `agent_runs` row (`service.ts:111-146`) — service supports N agents;
  only route validation + the concurrency wrapper are new.
- **F. `multi_agent_runs` is an inert stub** (`server/src/db/schema/runs.ts:43-52`)
  — no link to `agent_runs`, zero runtime references. Linkage (additive FK column
  on `agent_runs` vs a join table) is a PLAN/HOW decision under the add-only DB rule.
- **G. Upstream reference impl** exists at commit `8e587ed` (NOT an ancestor of HEAD)
  — context only; the implementation path is the planner's call.

## Reuse surfaces (cite in the plan; do NOT rebuild)
- Run control being replaced: `RunReviewDropdown` (`client/src/components/run-review-dropdown/`).
- Trace drawer to reuse for per-agent "View trace": `RunTraceDrawer`
  (`client/src/app/repos/[repoId]/pulls/[number]/_components/RunTraceDrawer/`) — tabs
  `trace`/`log`; `TraceBody` sections Configuration / Stats / Findings / Context docs /
  Prompt assembly / Tool calls / Raw output + footer "Copy Raw Output"; live log via
  `LiveLogStream` (`client/src/vendor/ui/LiveLogStream.tsx`); SSE `GET /runs/:id/events`
  (`server/src/modules/reviews/routes.ts:57-101`) via `useRunEvents`.
- "Turn into eval case": server-change-free — `POST /findings/:id/evals/case`
  (`server/src/modules/eval/routes.ts:73-76`) + `useCreateEvalCaseFromFinding` +
  `FindingCard` FlaskConical button.

## Scope boundaries (worktree A) — unchanged
- **Do NOT touch:** `ci/`, `agent-runner/`, the "Compose Review drawer".
- Concurrency change is scoped to the **multi-agent path in reviews/** — in bounds.

## Cross-worktree constraint (shared with Feature B / `devdigest-ci`)
Both worktrees share one Postgres + `:3001`/`:3000`. Safe in parallel: typecheck,
hermetic tests, `*.it.test.ts` (testcontainers). NOT safe in parallel: live dev
servers (one at a time), `db:migrate`/`db:seed` (shared DB). **Feature B reserved
migration `0023`** → Feature A must pick a DISTINCT number (verify next-free in
`server/drizzle/`). Use non-colliding seed IDs/slugs for the 3 new personas.

## NEXT SESSION — kickoff for the PLAN stage
Run **implementation-planner** with the spec + this handoff. Planner must decide/produce:
1. `multi_agent_runs`↔`agent_runs` linkage (additive FK column vs join table; add-only rule) + a **migration number ≠ 0023**.
2. Concurrency wrapper for the multi-agent path (AC-44): capped `Promise.allSettled` around `runOneAgent`, single-agent/review-all untouched.
3. Route/contract change: add `agentIds: string[]` to `RunRequest` + `resolveTargets` branch.
4. The net-new deterministic cross-agent matcher (AC-37) — same file + line-range overlap + essence.
5. Pre-run estimate service (avg last-3, MAX time / SUM cost, no-history).
6. Seed: add the 3 missing personas idempotently.
7. Client: picker (replacing RunReviewDropdown) + Configure-run page + Multi-Agent Review page (Columns/Tabs) + "Where agents disagree" + `RunTraceDrawer` reuse.
8. Ask the user: single-agent vs multi-agent (parallel implementers) for the implement stage.
- Output: `docs/plans/2026-07-09-multi-agent-review.md` (plan only, no code).

## Commit (SPEC stage — user runs this, not the agent)
Files: the spec + the README index row. Suggested message:

```
docs(spec): add Multi-Agent Review feature spec (SPEC-2026-07-09)

Feature A of the Lesson 07 parallel-implementation demo. EARS spec, 44 ACs,
status approved. Covers: agent picker, pre-run time/cost estimation (avg last-3,
MAX time / SUM cost), a NEW multi-agent concurrency requirement (AC-44 — only the
multi-agent path runs its agents concurrently; single-agent and review-all stay
sequential), the Multi-Agent Review page (live Columns + Tabs detail), net-new
deterministic "Where agents disagree" cross-agent grouping (AC-37), trace/log
reuse, and demo seed data. Reuses the frozen @devdigest/shared observability
contracts and the existing demo PR #482; adds three missing reviewer personas.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

The PLAN stage can be opened in a **fresh session** — it needs only the two paths
above (spec + this handoff), both re-readable from disk.
