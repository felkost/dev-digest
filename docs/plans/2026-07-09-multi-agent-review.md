# Development Plan: Multi-Agent Review

**Date:** 2026-07-09
**Requirements:** [docs/feature-requirements/2026-07-09-multi-agent-review.md](../feature-requirements/2026-07-09-multi-agent-review.md) (SPEC-2026-07-09-multi-agent-review, status `approved`, 44 ACs) — pre-vetted by [docs/plans/2026-07-09-multi-agent-review-arch-review.md](2026-07-09-multi-agent-review-arch-review.md) (13 MUST-constraints, 2 placement decisions) and [docs/plans/2026-07-09-multi-agent-review-spec-handoff.md](2026-07-09-multi-agent-review-spec-handoff.md) (research citations)
**Execution mode:** multi-agent — **HARD CAP = 3 parallel `implementer` agents per wave** (see §6)
**Scope:** full-stack (server, client)
**Affects modules:** `server/src/modules/reviews/`, `server/src/db/`, `server/src/vendor/shared/`, `client/src/vendor/shared/`, `client/src/lib/hooks/`, `client/src/components/`, `client/src/app/multi-agent-review/`, `client/src/app/repos/[repoId]/pulls/`

---

## 1. Context

Today a workspace member can run exactly one agent or every enabled agent on a pull request — there is no way to pick a subset, and no way to compare several agents' results side by side. This feature adds: an agent picker (replacing the existing single-agent-or-all run control everywhere it appears) that lets a member choose any subset of enabled agents with pre-run time/cost estimates; a **grouped multi-agent run** record that ties those agents' individual runs together; genuine **concurrent execution** of a multi-agent run's participating agents (bounded by a cap) so wall-clock time approximates the slowest agent, not the sum; a results page with live Columns and detailed Tabs views; and a deterministic, zero-LLM **cross-agent disagreement detector** ("Where agents disagree"). The review pipeline itself (diff analysis, model calls, grounding, live streaming, persistence, trace viewing) is entirely reused, unchanged — this feature only adds selection, grouping, concurrent scheduling, and comparison on top of it.

The shared response contracts (`MultiAgentRun`, `AgentColumn`, `AgentColumnFinding`, `Conflict`, `ConflictTake`) already exist in `@devdigest/shared` (`contracts/observability.ts`), frozen, with zero runtime producers or consumers today. This plan is what finally fills them in.

## 2. Architecture Fit

- **Server:** all new server code lands as **sibling files inside the existing `server/src/modules/reviews/` module** — no new top-level module folder. This mirrors the module's own precedent (`smart-diff.routes.ts` registered as a peer plugin alongside `routes.ts`, both instantiating `ReviewService` identically). New files: `multi-run.service.ts`, `multi-run.routes.ts`, `conflict-matcher.ts`, `repository/multi-run.repo.ts`. Existing files gain additive edits: `run-executor.ts` (a new concurrent execution path, the sequential path untouched in behavior), `service.ts` (`resolveTargets` gains an `agentIds` branch), `repository.ts` + `repository/run.repo.ts` (`createAgentRun` gains an optional linkage field + a new estimate query), `constants.ts` (two new named constants), `index.ts` (one new registry entry).
- **Database:** one new additive migration linking `agent_runs` to the already-inert `multi_agent_runs` table via a new nullable FK column `agent_runs.multi_agent_run_id`. No existing column is renamed or retyped.
- **Client:** the agent picker is promoted directly to `client/src/components/multi-agent-picker/` (cross-route reuse from day one — it replaces control surfaces on both the PR list row and the PR detail header, so there are two real consumers immediately, satisfying the promotion rule without an interim feature-scoped stop). The Configure-run flow and results page are a **new top-level App-Router segment**, `client/src/app/multi-agent-review/` (route `/multi-agent-review` = Configure-run; `/multi-agent-review/[runId]` = results page), with its own `_components/`. New hooks live in `client/src/lib/hooks/multi-agent-review.ts`.
- **Reused as-is (zero new code):** `RunTraceDrawer` + `LiveLogStream` (per-agent "View trace"), `FindingCard` (full finding detail + Accept/Dismiss/Turn-into-eval-case), `useRunEvents` (already accepts an array of run ids — one independent SSE subscription per run, exactly the NFR's requirement), `CircularScore` (score banding ≥75/≥50/else, already the product-wide convention — reused directly for AC-19, no new threshold logic), `usePrReviews` cache-join pattern (already established for `RunHistory`/`FindingsTab` — reused here to source full per-finding detail for the Tabs view without a new endpoint).

## 3. Skills & Patterns Applied

**`backend-onion-architecture`:**
- R1 — every new/edited query in `repository/multi-run.repo.ts` and `repository/run.repo.ts` filters `workspace_id`.
- R2 — no concrete adapter class is imported in `multi-run.service.ts`; LLM access stays inside the existing `ReviewRunExecutor`/`container.llm()` path.
- R3 — all expected failures (`agentIds` referencing a non-existent/foreign agent, PR not found, group not found) throw `NotFoundError`/`ValidationError`, never raw `Error`.
- R6 — `multi-run.routes.ts`/`multi-run.service.ts` import only their own module's files (`./run-executor.js`, `./service.js`, `./repository/*.js`, `./constants.js`), `@devdigest/shared`, and `../../platform/container` — legal because they are **sibling files inside `reviews/`**, not a separate module reaching in (Import Matrix, R6/R10 in the arch review).
- R7 — one new import + one new registry entry in `modules/index.ts`.

**`fastify-best-practices` / `zod`:** every new route validates params via `IdParams`, body via a Zod schema (`RunRequest` extended with `agentIds`); one schema drives both validation and the TS type; no response is hand-serialized outside the schema-typed return value (matching the existing `reviews/routes.ts` convention of typed returns without a registered `schema.response`).

**`drizzle-orm-patterns` / `postgresql-table-design`:** the new `agent_runs.multi_agent_run_id` column is nullable, added via `ALTER TABLE ... ADD COLUMN`, referenced with `references(() => multiAgentRuns.id, { onDelete: 'cascade' })` (arrow-function reference — safe forward reference within the same file per the skill's circular-dependency guidance); a manual B-tree index is added on the new FK column (Postgres never auto-indexes FK columns).

**`react-best-practices` / `next-best-practices` / `frontend-architecture`:**
- Combined per-agent estimate math (AC-8/AC-9, `MAX(duration)` / `SUM(cost)`) is plain arithmetic over already-fetched data — computed inline during render, no `useMemo` (not an expensive computation).
- Server state (`useMultiAgentRun`, `useAgentEstimates`, `useStartMultiAgentRun`) lives entirely in TanStack Query hooks — no `useEffect` for data fetching.
- The Configure-run/results pages are Server Components at the route boundary only where no browser API is needed; `"use client"` is pushed to the leaf components that need state/handlers (mirroring every existing `repos/[repoId]/...` page in this codebase, which is `"use client"` at the page level via `useParams()` — follow that exact precedent, not the one-off async-RSC pattern used only by the Context page).
- The picker is promoted to `client/src/components/` on day one (frontend-architecture's promotion rule) because it has two real, simultaneous consumers (PRRow, PrDetailHeader) from the moment it ships.

**`security`:** every new route is workspace-scoped via `getContext()` (A01 — deny-by-default, enforced identically to every existing route in this product); no new secret handling; the disagreement section's per-agent "note" text is already-model-authored content of the same trust class as any other displayed finding text — no new trust boundary, no new sanitization surface (per spec §10).

## 4. Project Constraints

Numbered to match the arch review for direct cross-reference.

1. **Concurrency is a distinct code path — never edit the existing sequential loop unconditionally.** `run-executor.ts`'s `for (const { agent, runId } of jobs)` loop (`executeRuns`, current lines ~204-231) is shared by single-agent runs, `all:true` runs, and `review-all`'s inner loop. It must remain sequential and behaviorally identical after this change. The multi-agent path gets its own new public method (`executeRunsConcurrent`), reached only from the new `multi-run.service.ts` call site.
2. **Concurrency orchestration stays server-side; `reviewer-core` is untouched** (it stays side-effect-free — no DB, no file I/O, no env reads). The concurrency wrapper schedules calls to the already-pure `reviewPullRequest()`; the scheduling loop itself lives in `run-executor.ts`.
3. **Reuse the existing bounded-concurrency shape** — a worker-pool pattern structurally identical to `eval/run-orchestrator.ts`'s private `runWithConcurrencyCap` (`server/src/modules/eval/run-orchestrator.ts:398-414`): N workers pull from a shared cursor, `await Promise.all(workers)` (await-all semantics — resolves only once every job has settled, so wall-clock reflects the slowest agent). Do not introduce `p-queue` as a second concurrency primitive in this module; do not invent a third shape.
4. **Per-agent failure isolation must survive the worker pool** (AC-17, AC-44). `runBus.complete(runId)` must fire unconditionally per job, exactly as it already does in the sequential path's per-job try/catch. Each pooled job must never let a rejection escape past its own try/catch (mirrors today's loop body) — the pool wrapper itself therefore never needs `allSettled`; a plain `Promise.all(workers)` is safe because no worker's promise ever rejects. **Reconciliation with the arch review's "allSettled semantics, not all" wording:** the reused `runWithConcurrencyCap` literally calls `Promise.all(workers)`, not `Promise.allSettled(workers)` — this is correct, not a deviation, because each worker's unit of work is `runJob`, whose body inherits the existing try/catch-that-never-rethrows already present in `runOneAgent`'s call site (`run-executor.ts:210-230` in the current file — one agent's failure is caught, logged, and completes the run as `'failed'`, but the enclosing promise still resolves, never rejects). The arch review's "allSettled semantics" requirement is therefore satisfied **by the isolating try/catch inside each job**, not by swapping in a literal `Promise.allSettled` at the pool level — do not add `allSettled` on top of this; it would be redundant, and its rarely-used `{status,reason}` result shape adds no value here since every worker already resolves cleanly.
5. **`agentIds: string[]` is a two-file, single-step edit.** `server/src/vendor/shared/contracts/platform.ts` and the byte-identical client mirror `client/src/vendor/shared/contracts/platform.ts` must change together, in the same step — there is no sync script, and `client/insights.md`'s 2026-06-30/2026-06-26 entries document that a one-sided edit silently breaks client typecheck. **This is a documented, deliberate exception to "never define a type twice."** Any shared-contract change needs a `:3001` restart before the client can see it — flagged explicitly at the end of Step 1 and in the final report; **never restart the user's own dev server yourself** (see §5).
6. **`multi_agent_runs` linkage is strictly additive.** No rename or retype of any existing column on `agent_runs`, `multi_agent_runs`, or `run_traces`. The new column (`agent_runs.multi_agent_run_id`, nullable FK) needs no backfill — `multi_agent_runs` has zero real rows today.
7. **Migration number ≥ 0024.** Latest applied migration on this branch is `0022`; a parallel worktree (Feature B / `devdigest-ci`) has reserved `0023` for its own additive change on ITS branch — that file does not exist on this branch, so `pnpm db:generate` here will most likely propose `0023` again. The implementer must rename the generated `.sql` file, its `meta/NNNN_snapshot.json`, and its `_journal.json` entry to `0024` before running `pnpm db:migrate` (the exact renaming procedure is documented in `server/insights.md`'s 2026-07-03 "orphaned snapshot" Mistake entries — follow that, don't improvise). **Real migrations live at `server/src/db/migrations/`** per `drizzle.config.ts:8-9` — `server/src/db/AGENTS.md`'s `server/drizzle/` path is stale, do not get misdirected by it.
8. **Every new `agent_runs`/`multi_agent_runs` read filters by `workspace_id`.** Both tables' `workspace_id` columns are already `.notNull()`; carry the filter through every new repository function.
9. **Response contract is frozen; one deliberate gap.** `server/src/vendor/shared/contracts/observability.ts:23-86` is the sole source of truth for `MultiAgentRun`/`AgentColumn`/`AgentColumnFinding`/`Conflict`/`ConflictTake` — **do not edit this file.** `ConflictTake.note` is non-nullable `z.string()`; the matcher must always emit a real string (`''` when no reasoning is available), never `null`/`undefined`. `AgentColumn.status` only has `'done' | 'failed' | 'running'` — the DB's fourth status, `'cancelled'`, must be mapped to `'failed'` for column display (its `error` text already reads "Cancelled by user", which carries the distinction through).
10. **A `reviews/`-sibling file may import another sibling file's internals directly** (`./service.js`, `./run-executor.js`, `./repository.js`) — this is legal because they live in the same module folder, not because module-isolation is relaxed. No file **outside** `reviews/` may reach into it the same way; `ReviewService`/`ReviewRunExecutor`/`ReviewRepository` remain **not** container-exposed.
11. **Routes stay thin.** Zod-driven params/body, `AppError`/`NotFoundError` for expected failures, `getContext(container, req)` for workspace scoping on every handler — mirror `reviews/routes.ts` exactly.
12. **Rate-limit config lives in `constants.ts`, never as a route-local literal** — mirror `BRIEF_GENERATE_RATE_LIMIT` (`constants.ts:64`). Two rate-limited paths now reach the same underlying LLM fan-out capability (`POST /pulls/:id/review` with `all:true`, and the new `POST /pulls/:id/multi-agent-run`) — both remain independently reachable and independently rate-limited; this plan does not attempt a combined budget (out of scope; flagged as an accepted residual risk, not silently ignored).
13. **Client placement is fixed:** picker → `client/src/components/multi-agent-picker/`; Configure-run + results → a new top-level App-Router segment `client/src/app/multi-agent-review/` with its own `_components/`; hooks follow `use<Domain><Action>` naming (`useStartMultiAgentRun`, `useMultiAgentRun`, `useAgentEstimates`); `apiFetch`/`api.*` is the only HTTP entry point; only `src/vendor/ui/` primitives — no Shadcn/Radix.

**Additional constraints surfaced during this planning pass:**

- **`AgentColumnFinding` (the frozen compact type) has no `confidence`/`rationale`/`suggestion`/`accepted_at`/`dismissed_at`.** It is correct only for the Columns view's compact rows (AC-18/AC-22). The Tabs view's full finding detail (AC-23-26) is **not** built from it — it reuses the already-fetched `usePrReviews(prId)` cache (each `ReviewRecord` already carries `run_id` and full `findings: FindingRecord[]`), mapped `run_id → ReviewRecord`, feeding straight into the existing `FindingCard` component. **Zero new contract, zero new route** for full finding detail — this was a real gap between the frozen `AgentColumnFinding` shape and AC-23's requirements, resolved by re-using data the page already needs to fetch for other reasons.
- **"Show only conflicts" (AC-31) resolution.** The frozen `MultiAgentRun.conflicts: Conflict[]` field has no sibling field for "locations where every agent agreed" — and the do-not-touch file cannot gain one. Resolution: `conflict-matcher.ts` returns **every code location flagged by at least one done agent** (both agreeing and disagreeing groups) into the one `conflicts` array; the AC-29/AC-30 "is this actually a disagreement" predicate (`takes` not all sharing one verdict) is applied **client-side** as a display filter, defaulting to on. This keeps the disagreement computation in exactly one place (server, deterministic, zero LLM calls — AC-37 intact) while satisfying AC-31 without touching the frozen file.
- **`total_cost_usd` null semantics are asymmetric with `total_duration_ms`.** Per the spec's own contract table: `total_cost_usd` is `null` when cost is unknown for **at least one** column (not only when all are unknown) — sum only when every column has a known `cost_usd`. `total_duration_ms` has no such gap-marking; while any column is `'running'`, compute it as `Date.now() - group.ran_at`; once every column has settled, compute it as `max(column.ran_at + column.duration_ms) - group.ran_at` across all columns (not "elapsed since start to now", which would keep growing after completion).
- **`agentIds` is camelCase** on the wire (matches the existing `agentId` field) — the spec's own `{agent_ids}` snake_case doc snippet is stale; do not follow it.
- **`SimpleGitClient` concurrent-read risk is not new.** `review-all`'s existing 3-way concurrent fan-out (`reviews/routes.ts:308-327`, `scheduleNext`) already produces concurrent `git.readFile`/repo-intel reads against the same clone directory whenever multiple open PRs from one repo are reviewed together. AC-44 does not raise this risk beyond what already ships today — no new verification gate is required, but Step 4's implementer should read `adapters/git/simple-git.ts` once to confirm `readFile`/`clonePathFor` are non-mutating before relying on this reasoning.
- **Do not touch:** `ci/`, `agent-runner/`, the Compose Review drawer, `server/src/vendor/shared/` files other than `platform.ts`, any applied migration file, `reviewer-core/src/grounding.ts`.

**Code-quality principle (governs every step below, and the `/implement` architecture-reviewer + bug/code-review gates):**

- **No load-bearing workarounds.** If a workaround needs a paragraph of justification to explain why it's OK, the code is wrong — fix it properly instead of shipping the workaround.
- **Fix the process, not the symptom.** When something goes wrong during implementation (a failing test, a type error, an awkward seam), fix the root cause — or the step that generates the code — do not patch over the symptom with a local hack.
- The architecture-reviewer and code-review gates should **reject** justified-workaround code on sight and require a root-cause fix before sign-off.

## 5. Runtime Isolation & Merge Compatibility

This worktree (`../devdigest-review`, branch `feat/multi-agent-review`) is developed **in parallel** with a sibling worktree (`../devdigest-ci`, branch `feat/export-to-ci`, Feature B). Both worktrees share one Postgres instance and contend for the same default ports (client 3000, API 3001, Postgres 5432) unless deliberately isolated at the OS/Docker level. This section is binding on every implementer step in §6.

**Merge-safety constraints (hard, code-level):**

- **Never hardcode** worktree-specific ports, database names, Docker Compose project names, or URLs into application code, tests, shared contracts, or committed docs. No new step in this plan introduces a new port, service, or Docker Compose entry — the feature needs none.
- All configuration continues to flow through the existing `server/src/platform/config.ts` (`EnvSchema`, already environment-driven with safe defaults: `DATABASE_URL` → `postgres://devdigest:devdigest@localhost:5432/devdigest`, `API_PORT` → `3001`, `WEB_PORT` → `3000`) and `client/src/lib/api.ts` (`NEXT_PUBLIC_API_BASE`, default `http://localhost:3001`). No step in this plan adds a new config surface; if any step's testing needs a value, it reads from these existing mechanisms — never a new literal.
- The committed `docker-compose.yml` (`name: devdigest`, container `devdigest-postgres`, DB `devdigest`/`devdigest`, port `5432`) is the only tracked runtime profile. **Do not commit** `.env.local`, `.env.*.local`, generated runtime profiles, temporary Docker Compose overrides, or any machine-specific config — this repository does not currently track any of these, and this feature must not start.
- No branch-specific assumptions anywhere in shared code, **including the `platform.ts` contract mirrors edited in Step 1** — those files must read identically regardless of which worktree or branch they are viewed from.

**Local runtime profile (this session only — untracked, never committed):** `CLIENT_PORT=3000`, `API_PORT=3001`, `POSTGRES_PORT=5432`, `DATABASE_NAME=devdigest_review`, `DATABASE_URL=postgres://postgres:postgres@localhost:5432/devdigest_review`, `DOCKER_COMPOSE_PROJECT_NAME=devdigest_review` (`docker compose -p devdigest_review up -d` / `... down`). This profile is **local-only context for whoever runs commands in this worktree** — it must never appear inside any file this plan's steps write or edit. The merged feature must run correctly against the tracked defaults above with zero code changes.

**Pre-change checklist (every implementer's first steps, before touching any file):**
1. Confirm current working directory is this worktree.
2. Confirm current branch is `feat/multi-agent-review`.
3. Skim `AGENTS.md`, the relevant module's `package.json` scripts, `.env.example` (does not currently exist in this repo — do not create one as part of this feature), and `docker-compose.yml` to (re-)confirm which ports/DB/Docker resources this worktree uses.
4. Do not assume — verify.

**Server/runtime safety (binding on every step, and repeated in §8):**
- **Never start a server or Docker service as part of implementing a step.** Before any manual smoke-test against a running API (only if truly necessary — most verification here is `pnpm typecheck` + hermetic/integration tests, which need no running dev server), check whether ports 3000/3001/5432 are already occupied. If occupied by another process/worktree, **stop and report the conflict** — do not silently test against a server that may not belong to this worktree, and do not assume `localhost:3001` is this worktree's own instance.
- **Never restart the user's own `:3001`/`:3000`** — not even after the Step 1 shared-contract edit that technically requires a restart to take effect. Flag the need for a restart in the step's own report and in the final summary; the user restarts it themselves.
- If runtime isolation for a given verification step is ever unclear, **stop before touching servers/e2e and report exactly what is ambiguous** rather than guessing.

**Pre-finalize grep (part of every step's own verification, restated in §8):** after making changes, run `git diff --name-only` against the tracked files touched by that step, then grep those files for `3010|3011|5442|devdigest_ci|devdigest_review`. Any such value found in tracked application code, tests, shared config, or docs must be removed or replaced with env-driven config before the step is reported done. (Untracked, clearly-local files are exempt — but no step in this plan should be creating any.)

**Test order (every step, before reporting done):** run the smallest check first — `pnpm typecheck` (package-specific: `cd server && pnpm typecheck` / `cd client && pnpm typecheck`), then the package's own test script (`pnpm exec vitest run --exclude '**/*.it.test.ts'` for server hermetic, `pnpm test` for client). Do not guess a script name — read the package's `package.json` first. `*.it.test.ts` (Testcontainers) and any e2e suite run only if this worktree's own ports/DB are confirmed free per the checklist above; if Docker is unavailable or ports are contended, report that rather than skipping silently.

**Implementer final-report format (every step in §6 ends its report this way):**
1. Summary of changes.
2. Files changed (owned paths actually touched).
3. Tests run + results (typecheck, hermetic, integration/e2e if applicable).
4. Runtime resources used (ports/DB/Docker project, if any — expected to be "none" for most steps in this plan).
5. Confirmation that **no** worktree-specific runtime value is hardcoded in any changed application file.
6. Confirmation that the change is compatible with the default runtime (client 3000 / API 3001 / Postgres 5432 / DB `devdigest`).
7. Known risks.
8. Confirmation that no other worktree's files were used or modified.

---

## 6. Implementation Steps

**Parallelization map** (≤3 concurrent `implementer` instances per wave; the `/implement` pipeline's own architecture-reviewer and code-review gates run around each wave per its standard cycle — not enumerated as separate steps here):

```
Wave 1 (3, independent — foundation):
  Step 1  Shared contracts (both vendor/shared mirrors)
  Step 2  DB migration + schema + multi-run repository (read/write path)
  Step 3  Cross-agent conflict-matcher (pure, + hermetic tests)
        │
        ▼ (Wave 2 depends on Wave 1; within Wave 2, Step 6 depends only on Step 1)
Wave 2 (3, depends on Wave 1):
  Step 4  Concurrency wrapper + multi-run service/routes + estimate route  (needs 1, 2, 3)
  Step 5  Seed data: 3 personas + prior multi-agent run w/ a genuine disagreement (needs 2, 3 — Step 5's own Verify feeds its seeded columns through Step 3's computeConflicts)
  Step 6  Client hooks: useStartMultiAgentRun / useMultiAgentRun / useAgentEstimates (needs 1 only)
        │
        ▼ (Wave 3 depends on Step 6 only — not on Steps 4/5's server code, see note below)
Wave 3 (2, depends on Step 6):
  Step 7  Picker component — replaces RunReviewDropdown at both call sites  (needs 6)
  Step 8  Multi-Agent Review App-Router segment (Configure-run + results page)  (needs 6)
```

**Why Wave 3's client steps don't wait on Wave 2's server steps (4/5):** client TypeScript compiles against `@devdigest/shared` types (landed in Step 1) and the client's own hooks (Step 6) — never against server source files. Steps 7/8 code against the exact route paths and response shapes fixed by this plan (below), not against Step 4's actual implementation; hermetic client tests mock `fetch`, so no running server is needed either. Runtime correctness across the whole stack is verified once in the Step 4/8 integration coverage and in a final smoke pass, not by making the client wait.

---

### Step 1: Shared contracts — `agentIds`, start-response, estimate shape

**Dependencies:** none
**Owned paths:** `server/src/vendor/shared/contracts/platform.ts`, `client/src/vendor/shared/contracts/platform.ts`
**What to do:**
1. In **both** files, extend the existing `RunRequest` schema (currently `{ agentId?: string, all?: boolean }`, at `platform.ts:250-254`) with one new optional field: `agentIds: z.array(z.string()).optional()`. Purely additive — existing `{agentId}`/`{all:true}` callers (`POST /pulls/:id/review`) are unaffected.
2. In **both** files, immediately below `RunRequest`, add two new exports (import `ReviewRunTarget` from `./review-api.js` — it already exists in both mirrors):
   ```ts
   export const MultiAgentRunStartResponse = z.object({
     multi_agent_run_id: z.string(),
     pr_id: z.string(),
     runs: z.array(ReviewRunTarget),
   });
   export type MultiAgentRunStartResponse = z.infer<typeof MultiAgentRunStartResponse>;

   export const AgentEstimate = z.object({
     agent_id: z.string(),
     avg_duration_ms: z.number().nullable(),
     avg_cost_usd: z.number().nullable(),
     sample_size: z.number().int(), // 0-3; 0 means "no history" (AC-7)
   });
   export type AgentEstimate = z.infer<typeof AgentEstimate>;
   ```
3. Do **not** touch `contracts/observability.ts` in either package — it is frozen and already exports everything else this feature needs (`MultiAgentRun`, `AgentColumn`, `AgentColumnFinding`, `Conflict`, `ConflictTake`).
4. Confirm both files re-export cleanly through each package's `index.ts` barrel (no action needed if the barrel already does `export * from './contracts/platform.js'`, which it does in both packages).

**Verify:**
- [ ] `cd server && pnpm typecheck` passes
- [ ] `cd client && pnpm typecheck` passes
- [ ] `server/test/contracts.test.ts` (or equivalent) still passes — a required-field addition to an existing schema can break an existing fixture; `agentIds` is optional so it should not, but confirm
- [ ] The two files are byte-identical for the newly added exports (diff them)
- [ ] Report explicitly: "this change requires a `:3001` restart to take effect on the running API — do not restart it yourself; flag it to the user"

**Commit:** `feat(shared): add agentIds, MultiAgentRunStartResponse, AgentEstimate to RunRequest contracts`

---

### Step 2: DB migration + schema + multi-run repository (read/write path)

**Dependencies:** none
**Owned paths:** `server/src/db/schema/runs.ts`, `server/src/db/migrations/0024_multi_agent_run_linkage.sql` (+ its `meta/0024_snapshot.json` + `_journal.json` entry), `server/src/modules/reviews/repository/multi-run.repo.ts` (new)
**What to do:**
1. In `server/src/db/schema/runs.ts`, add a new nullable column to the existing `agentRuns` table definition (do not alter any existing column):
   ```ts
   multiAgentRunId: uuid('multi_agent_run_id')
     .references(() => multiAgentRuns.id, { onDelete: 'cascade' }),
   ```
   (Forward reference to `multiAgentRuns`, declared later in the same file, is safe — it's inside an arrow function, evaluated lazily, same pattern already used for `agentId`/`prId` in this same table.)
2. Run `pnpm db:generate` from `server/`. Per Constraint 7, drizzle-kit will likely propose `0023_<random>.sql` (this worktree's branch doesn't see Feature B's `0023` file). **Rename** the generated `.sql`, its `meta/NNNN_snapshot.json`, and its `_journal.json` entry to `0024` (three artifacts, all three renamed together — see `server/insights.md`'s 2026-07-03 "orphaned snapshot" entries for the exact failure mode if you rename only one). The final migration filename must be `0024_multi_agent_run_linkage.sql`.
3. Manually confirm the generated SQL is exactly: add the nullable `multi_agent_run_id uuid` column with its FK to `multi_agent_runs(id)` (`ON DELETE CASCADE`), plus a manual `CREATE INDEX` on `agent_runs (multi_agent_run_id)` (Postgres never auto-indexes FK columns — add it explicitly if drizzle-kit doesn't). No other statement should appear in this migration.
4. Run `pnpm db:migrate` against your local dev DB (per §5, this is your own worktree's local DB — never assume you're pointed at another worktree's instance).
5. Create `server/src/modules/reviews/repository/multi-run.repo.ts` (new file, following the exact pattern of the sibling `repository/pull.repo.ts`/`run.repo.ts` — plain exported async functions taking `db: Db` as the first parameter, not a class):
   - `createGroup(db, values: { workspaceId: string; prId: string }): Promise<string>` — insert into `multiAgentRuns`, return the new id.
   - `getGroupScoped(db, workspaceId, groupId): Promise<{ id: string; prId: string; prNumber: number | null; ranAt: Date } | undefined>` — the group row, workspace-scoped directly on `multi_agent_runs.workspace_id` (no join needed — already `.notNull()`), left-joined to `pull_requests` for `pr_number`.
   - `listAgentRunsForGroup(db, groupId): Promise<AgentRunRow[]>` — all `agent_runs` rows where `multi_agent_run_id = groupId`, ordered by `ran_at` ascending (selection order).
   - `findingsAndReviewsForRuns(db, runIds: string[]): Promise<Map<string, { review: ReviewRow; findings: FindingRow[] }>>` — for each run id, its `reviews` row (there is at most one `review` per `run_id`) plus that review's `findings` rows, keyed by `run_id`. Model this on the existing `reviewRepo.reviewsForPull` query shape (join `reviews` → `findings`, group in memory) but filter by `reviews.run_id IN (runIds)` instead of `prId`.
6. Do **not** wrap these functions in the `ReviewRepository` class — import them as a namespace (`import * as multiRunRepo from './repository/multi-run.repo.js'`) exactly like `routes.ts` already does for `pullRepo`/`reviewRepo`. This avoids editing the shared `repository.ts` class file in this step (Step 4 edits it separately, for the `createAgentRun` linkage field).

**Verify:**
- [ ] `pnpm db:generate` produces a clean, minimal diff (one column + one index; nothing else) — review it before renaming
- [ ] `pnpm db:migrate` applies cleanly against your own local DB
- [ ] `cd server && pnpm typecheck` passes
- [ ] New hermetic test `server/test/multi-run-repo.test.ts` (mock `db`, following the existing "sniff by requested column keys" hermetic-fake-db convention documented in `server/insights.md`) covering: `createGroup` inserts and returns an id; `getGroupScoped` returns `undefined` for a foreign `workspaceId`; `listAgentRunsForGroup` filters correctly
- [ ] Runtime-isolation grep (§5) on the diff: no `3010|3011|5442|devdigest_ci|devdigest_review`

**Commit:** `feat(db): add agent_runs.multi_agent_run_id linkage (migration 0024) + multi-run repository`

---

### Step 3: Cross-agent conflict-matcher (pure, deterministic, zero LLM calls)

**Dependencies:** none
**Owned paths:** `server/src/modules/reviews/conflict-matcher.ts` (new), `server/test/conflict-matcher.test.ts` (new)
**What to do:**
1. Create `conflict-matcher.ts` exporting one pure function:
   ```ts
   export interface MatcherFinding {
     file: string;
     start_line: number;
     severity: Severity;
     title: string;
     rationale: string | null;
   }
   export interface MatcherColumn {
     agent_id: string;
     agent_name: string;
     status: 'done' | 'failed' | 'running';
     findings: MatcherFinding[];
   }
   export function computeConflicts(columns: MatcherColumn[]): Conflict[]
   ```
   `Severity` and `Conflict` import from `@devdigest/shared`. Note `MatcherFinding` deliberately carries the **full** `rationale` (unlike the frozen, compact `AgentColumnFinding` wire type) — the caller (Step 4's service) passes it the richer `FindingRow`/`FindingRecord` data it already has, not the compact projection it separately builds for `AgentColumn.findings`.
2. Algorithm (exact — this resolves the AC-31 "Show only conflicts" gap noted in §4; do not narrow the output to disagreements only):
   - Consider only columns with `status === 'done'`. A `'running'`/`'failed'` column contributes no take at all for any location (not even `'ignored'`) — it has not produced a trustworthy verdict yet.
   - If fewer than 2 done columns exist, return `[]` immediately (matches AC-32 — the caller uses this to omit the whole section; the function itself must also be correct if called anyway).
   - Build the set of distinct `(file, start_line)` locations that at least one done column's `findings` contains — **exact match on `file` and `start_line`**, not a line-range overlap (follow the spec's literal AC-27 wording, not the arch-review's looser paraphrase).
   - For each location, build one `ConflictTake` per done column: if that column has a finding at this exact location, `{ agent_id, persona: agent_name, verdict: finding.severity, note: finding.rationale ?? '' }`; otherwise `{ agent_id, persona: agent_name, verdict: 'ignored', note: '' }`. **Never emit `null`/`undefined` for `note`** (Constraint 9).
   - `title`: the `title` of the first take (in column order) whose `verdict !== 'ignored'`.
   - Emit **every** such location as a `Conflict` — both ones where all takes share one verdict (agreement) and ones where they don't (AC-29's actual disagreement rule: at least one take differs from another, either one flagged/one didn't, or two flagged at different severities). Do not filter here.
3. Add a short doc comment on `computeConflicts` explaining the "returns agreement AND disagreement groups; the disagreement/agreement split is a client-side display filter (AC-31), not this function's job" decision, so a future reader isn't confused by the function name vs. its full output.

**Verify:**
- [ ] `cd server && pnpm typecheck` passes
- [ ] Hermetic unit tests (no DB, no container) covering: two done agents, one flags a location the other doesn't → one `Conflict` with one `'ignored'` take; two done agents, both flag the same location at different severities → one `Conflict`, both non-ignored takes; two done agents, both flag the same location at the same severity → still emitted (the "agreement" case — asserted present, not filtered here); a `'running'` column's own finding never contributes a take, and never counts toward the ≥2-done gate; fewer than 2 done columns → `[]`; a done column's finding with `rationale: null` → `note: ''`, never `null`
- [ ] `pnpm exec vitest run --exclude '**/*.it.test.ts'` passes

**Commit:** `feat(reviews): add deterministic cross-agent conflict-matcher`

---

### Step 4: Concurrency wrapper + multi-run service/routes + pre-run estimate route

**Dependencies:** Step 1 (contracts), Step 2 (repository, schema), Step 3 (matcher)
**Owned paths:** `server/src/modules/reviews/run-executor.ts` (edit), `server/src/modules/reviews/service.ts` (edit), `server/src/modules/reviews/repository.ts` (edit), `server/src/modules/reviews/repository/run.repo.ts` (edit), `server/src/modules/reviews/constants.ts` (edit), `server/src/modules/reviews/multi-run.service.ts` (new), `server/src/modules/reviews/multi-run.routes.ts` (new), `server/src/modules/index.ts` (edit), `server/test/multi-run-concurrency.test.ts` (new), `server/test/multi-run-service.test.ts` (new), `server/test/multi-run.it.test.ts` (new)
**What to do:**

1. **`run-executor.ts`** — extract the per-job body currently inlined in `executeRuns`'s `for` loop into a new `private async runJob(job, pull, repo, diff, intent, runLog, logger)` method with **identical logic** (same try/catch, same logging, same call to `this.runOneAgent`). `executeRuns` now calls `runJob` from a plain sequential `for...of` — behavior, order, and timing must be unchanged (verify with the existing hermetic tests for this file, which must still pass unmodified). Add a private `runWithConcurrencyCap<T>(items, concurrency, fn)` helper structurally identical to `eval/run-orchestrator.ts:398-414`. Add a new public method:
   ```ts
   async executeRunsConcurrent(
     workspaceId: string, pull: PullRow, repo: typeof schema.repos.$inferSelect,
     jobs: { agent: AgentRow; runId: string }[], logger?: Logger,
   ): Promise<void>
   ```
   — identical pre-work (diff + intent load, shared `RunLogger`) to `executeRuns`, but runs `runJob` for each entry in `jobs` through `runWithConcurrencyCap` with a concurrency cap read from the new `MULTI_AGENT_CONCURRENCY_CAP` constant (Constraint 3/4 — see Constraint 4's reconciliation note on why `Promise.all`, not `Promise.allSettled`, is correct here).
2. **`constants.ts`** — add `export const MULTI_AGENT_CONCURRENCY_CAP = 3;` (mirrors `review-all`'s existing `CONCURRENCY = 3` literal in `routes.ts:308`) and `export const MULTI_AGENT_RUN_RATE_LIMIT = { max: 10, timeWindow: '1 minute' } as const;` (mirrors the existing `/pulls/:id/review` route's inline `{ max: 10, timeWindow: '1 minute' }`, since the new route is the direct multi-agent-capable successor of that same trigger point).
3. **`service.ts`** — extend `ReviewService.resolveTargets`'s `opts` parameter with `agentIds?: string[]`. When present and non-empty: resolve each id via `this.agents.getById(workspaceId, id)`, `throw new NotFoundError('Agent not found: ' + id)` if any is missing, return the resolved `AgentRow[]` in input order. Leave the existing `all`/`agentId` branches untouched.
4. **`repository.ts` + `repository/run.repo.ts`** — extend `createAgentRun`'s `values` parameter with an optional `multiAgentRunId?: string | null`, threaded into the INSERT (`.values({ ..., multiAgentRunId: values.multiAgentRunId ?? null })`). Add one new function to `run.repo.ts`: `lastSuccessfulRuns(db, { workspaceId, agentId, repoId, limit }): Promise<{ durationMs: number; costUsd: number | null }[]>` — `agent_runs` joined to `pull_requests` on `pr_id` (to filter by `repoId`), `WHERE workspace_id = ws AND agent_id = agentId AND status = 'done'`, `ORDER BY ran_at DESC LIMIT limit`. Wrap it on `ReviewRepository` as `lastSuccessfulRuns(...)`.
5. **`multi-run.service.ts`** (new) — a `MultiRunService` class constructed the same way `ReviewService` is (`new ReviewRepository(container.db)`, `new ReviewRunExecutor(container, repo, container.agentsRepo)`), with:
   - `startRun(workspaceId, prId, agentIds, logger?)`: load the PR + repo (reuse `this.repo.getPull`/`getRepo`, `NotFoundError` if missing), resolve targets via a `ReviewService` instance's `resolveTargets(workspaceId, { agentIds })`, create the group row (`multiRunRepo.createGroup`), then for each target agent create an `agent_runs` row via `this.repo.createAgentRun({ ..., multiAgentRunId: groupId })` (same up-front-row pattern as `ReviewService.runReview`, so a `runId` is available immediately), then fire-and-forget `this.executor.executeRunsConcurrent(...)` (never `executeRuns`). Returns `{ multi_agent_run_id, pr_id, runs }` matching `MultiAgentRunStartResponse`.
   - `getComposedRun(workspaceId, groupId): Promise<MultiAgentRun | undefined>`: `multiRunRepo.getGroupScoped` (404 via caller if `undefined`), `multiRunRepo.listAgentRunsForGroup`, `multiRunRepo.findingsAndReviewsForRuns` for the done ones. Build each `AgentColumn` (map DB `status` `'cancelled'` → `'failed'`, Constraint 9; `verdict`/`summary`/`score` from the joined review row, `null` if none yet; `findings` as the compact `AgentColumnFinding[]` projection). Compute `conflicts`: if fewer than 2 columns have `status === 'done'`, `[]`; else call `computeConflicts` (Step 3) with the **full** findings (including `rationale`) per done column. Compute `total_duration_ms`/`total_cost_usd` per the exact rules in §4 ("Additional constraints" bullet). Return the full `MultiAgentRun`.
   - `estimatesForPr(workspaceId, prId): Promise<AgentEstimate[]>`: load the PR (for `repoId`), list enabled agents (`this.agents.listEnabled`), for each call `this.repo.lastSuccessfulRuns(...)` with `limit: 3`, average `durationMs`/`costUsd` over the returned rows (average only over rows where `costUsd` is non-null, for cost; `sample_size = rows.length`; `avg_duration_ms`/`avg_cost_usd = null` when `sample_size === 0`). This is the SERVER-side data source AC-6/AC-7 depend on and the array-shape prerequisite AC-9's client-side combining depends on — see the new named test below.
6. **`multi-run.routes.ts`** (new) — a Fastify plugin, same shape as `smart-diff.routes.ts`:
   - `POST /pulls/:id/multi-agent-run` — `schema: { params: IdParams, body: RunRequest }`, `config: { rateLimit: MULTI_AGENT_RUN_RATE_LIMIT }`. Body must carry a non-empty `agentIds`; if empty/missing, `throw new AppError('invalid_run_request', 'Provide agentIds (non-empty)', 400)`. Calls `service.startRun(...)`.
   - `GET /multi-agent-runs/:id` — `schema: { params: IdParams }`. Calls `service.getComposedRun(...)`; `throw new NotFoundError('Multi-agent run not found')` if `undefined`.
   - `GET /pulls/:id/agent-estimates` — `schema: { params: IdParams }`. Calls `service.estimatesForPr(...)`.
   Every handler starts with `const { workspaceId } = await getContext(container, req)`.
7. **`modules/index.ts`** — add one import + one registry entry, e.g. `multiRun` (mirrors the existing `smartDiff` entry exactly).

**Verify:**
- [ ] `cd server && pnpm typecheck` passes
- [ ] Every **existing** hermetic test touching `run-executor.ts`/`service.ts`/`repository.ts`/`routes.ts` still passes unmodified — this is the strongest signal that the sequential path (single-agent, `all:true`, `review-all`) is unchanged
- [ ] New hermetic `multi-run-concurrency.test.ts`: mock `runOneAgent`-equivalent via a fake `LLMProvider`/`GitClient` and assert `executeRunsConcurrent` calls into all jobs, that one job's induced failure doesn't prevent the others from completing, and that `runBus.complete` fires for every job
- [ ] **New hermetic `multi-run-service.test.ts`** — directly exercises `estimatesForPr`/`lastSuccessfulRuns` (mock `db`/repo return values, no DB, no container beyond what's needed to construct `MultiRunService`), asserting: (a) the average is computed over exactly the last 3 rows with `status: 'done'` — a 4th-oldest successful run, and any `'failed'`/`'cancelled'` run, are excluded from the average; (b) an agent with zero successful runs on the given `repoId` → `avg_duration_ms: null`, `avg_cost_usd: null`, `sample_size: 0` (AC-7's server-side source of the "no history" marker); (c) in one `estimatesForPr` call covering several agents, one agent's zero-history result (all-null) does not affect or get conflated with another agent's real, non-null numbers in the same returned array — the array-shape guarantee AC-9's client-side MAX/SUM-with-missing-flag combining logic (Steps 7/8) depends on
- [ ] New integration `multi-run.it.test.ts` (Testcontainers, per §5's "check ports first, never assume `:3001` is yours" — this test spins up its own ephemeral Postgres, unrelated to any worktree's dev DB): (a) `POST /pulls/:id/multi-agent-run` with 2+ agentIds creates one group + N linked `agent_runs`; (b) **AC-44 wall-clock assertion** — using a small local (test-file-only, not `adapters/mocks.ts`) delayed `LLMProvider` wrapper around `MockLLMProvider` (e.g. `await new Promise(r => setTimeout(r, 300))` before delegating to `super.completeStructured`), run 3 agents and assert total elapsed time is well under 3× a single agent's duration (a generous bound, e.g. `< 2 ×`, to avoid flakiness) rather than asserting a tight ratio; (c) `GET /multi-agent-runs/:id` returns the composed shape with correct `conflicts` once all columns are done; (d) cross-workspace request for a foreign group id → 404; (e) rate limit: a burst of rapid `POST` triggers is throttled, not fully executed unmoderated (AC-40); (f) `GET /pulls/:id/agent-estimates` against real seeded run history returns correct averages end-to-end (a real-DB complement to `multi-run-service.test.ts`'s mocked unit coverage)
- [ ] Runtime-isolation grep (§5) on the diff
- [ ] Never start the dev server for this step's verification — hermetic + integration tests only

**Commit:** `feat(reviews): add multi-agent run concurrency, orchestration service, and routes`

---

### Step 5: Seed data — 3 missing personas + a genuine cross-agent disagreement

**Dependencies:** Step 2 (schema/migration must exist so `multi_agent_run_id` can be written), Step 3 (`computeConflicts` — this step's own Verify feeds the seeded columns through it to confirm a genuine disagreement is actually produced, not just plausible-looking fixture data)
**Owned paths:** `server/src/db/seed.ts` (edit), `server/src/db/seed-prompts.ts` (edit)
**What to do:**
1. In `seed-prompts.ts`, add three new exported prompt constants following the exact style/structure of the existing `GENERAL_REVIEWER_PROMPT`/`SECURITY_REVIEWER_PROMPT`/`PERFORMANCE_REVIEWER_PROMPT` (Role → stack context → what to look for → how to analyze → quality bar): `JUNIOR_MENTOR_REVIEWER_PROMPT` (a mentoring, tone-differentiated reviewer — explains *why*, encouraging tone, still flags real defects), `CUSTOMER_FACING_REVIEWER_PROMPT` (reviews customer-facing language/UX copy/error messages for clarity and tone, not code correctness), `ARCHITECTURE_REVIEWER_PROMPT` (module boundaries, layering, coupling — the kind of finding this very plan's own `backend-onion-architecture` skill would flag).
2. In `seed.ts`, extend the existing `seedAgents` array (`seed.ts:314-348`) with three more entries — same shape as the existing three (`name`, `description`, `provider: DEFAULT_PROVIDER`, `model: DEFAULT_MODEL`, `systemPrompt`, `enabled: true`, `version: 1`, `createdBy: userId`) — names: `'Junior Mentor Reviewer'`, `'Customer-Facing Reviewer'`, `'Architecture Reviewer'`. The existing idempotent upsert-by-name loop (`seed.ts:349-355`, "skip if a row with this `name` already exists in this workspace") already covers these — no new loop needed, just extend the array.
3. After the (already-idempotent) agent block, add a new idempotent block: seed one **grouped multi-agent run** against the existing demo PR (`pr` from `seed.ts:189-212`, PR #482), using the Security Reviewer, Performance Reviewer, and the new Architecture Reviewer (three done agents — satisfies AC-32's ≥2-done gate with room to spare). Guard the whole block on "does a `multi_agent_runs` row already exist for this PR" (select-before-insert, same idempotency style as the rest of this file) so re-running `pnpm db:seed` never duplicates it.
   - Insert one `multi_agent_runs` row (`workspaceId`, `prId: pr.id`).
   - For each of the 3 agents: insert an `agent_runs` row (`status: 'done'`, realistic `durationMs`/`tokensIn`/`tokensOut`/`costUsd`, `multiAgentRunId` set to the new group's id) and a `reviews` row (`runId` = that run's id, plausible `verdict`/`summary`/`score`).
   - Construct findings so that **at least one genuine disagreement exists** (AC-29, consumed by AC-42): pick one `file`/`startLine` from the PR's existing `pr_files` (e.g. `src/api/public/webhooks.ts`) and give it a finding from the Security Reviewer (e.g. `severity: 'CRITICAL'`, category `security`, an SSRF-shaped title) while the Performance Reviewer's review has **no** finding at that exact `file`+`startLine` — this is the "one flagged, one silently didn't" case the conflict-matcher (Step 3) is built to detect. Optionally also add one location where two agents flag the same spot at **different** severities, for a second, richer disagreement example.

**Verify:**
- [ ] `cd server && pnpm typecheck` passes
- [ ] `pnpm db:seed` run twice in a row produces **no duplicate rows** (idempotency) — verify with a `SELECT COUNT(*)` before/after the second run
- [ ] Manually confirm (via a hermetic test or a one-off query, not a running server) that feeding the seeded columns through `computeConflicts` (Step 3) yields at least one non-empty `Conflict`
- [ ] Runtime-isolation grep (§5) on the diff

**Commit:** `feat(seed): add 3 missing reviewer personas and a demo multi-agent run with a genuine disagreement`

---

### Step 6: Client hooks — start / read / estimate

**Dependencies:** Step 1 (contracts only)
**Owned paths:** `client/src/lib/hooks/multi-agent-review.ts` (new), `client/src/lib/hooks/multi-agent-review.test.ts` (new)
**What to do:**
1. Create `multi-agent-review.ts` following the exact conventions in `client/src/lib/hooks/reviews.ts` (React Query, `api` from `../api`, QueryKey `[domain, id?, ...]`):
   - `useAgentEstimates(prId: string | null | undefined)` — `useQuery`, `queryKey: ["agent-estimates", prId]`, `queryFn: () => api.get<AgentEstimate[]>(\`/pulls/${prId}/agent-estimates\`)`, `enabled: !!prId`.
   - `useStartMultiAgentRun()` — `useMutation`, `mutationFn: ({ prId, agentIds }: { prId: string; agentIds: string[] }) => api.post<MultiAgentRunStartResponse>(\`/pulls/${prId}/multi-agent-run\`, { agentIds })`. No cache invalidation needed here (the caller navigates to the results page on success, which fetches fresh via `useMultiAgentRun`).
   - `useMultiAgentRun(groupId: string | null | undefined)` — `useQuery`, `queryKey: ["multi-agent-run", groupId]`, `queryFn: () => api.get<MultiAgentRun>(\`/multi-agent-runs/${groupId}\`)`, `enabled: !!groupId`, `refetchInterval: (query) => (query.state.data?.columns ?? []).some(c => c.status === 'running') ? 4000 : false` — same poll-while-running pattern as `usePrRuns`/`usePrActiveRuns` (`reviews.ts:43-51`, `31-38`).
2. Import `AgentEstimate`, `MultiAgentRunStartResponse`, `MultiAgentRun` from `@devdigest/shared` (all now available after Step 1).
3. Do not implement live SSE status here — that's `useRunEvents` (already exists, unmodified, consumed directly by Step 8's results page with the group's own `runs[].run_id` list).

**Verify:**
- [ ] `cd client && pnpm typecheck` passes
- [ ] `pnpm test` — hermetic tests with `fetch` mocked (mirror `useRunEvents.test.ts`'s style) covering: `useAgentEstimates` fetches and returns the array; `useStartMultiAgentRun` posts `{ agentIds }` to the right path; `useMultiAgentRun` re-polls only while some column is `'running'` and stops once all are settled
- [ ] Runtime-isolation grep (§5) on the diff

**Commit:** `feat(client): add multi-agent-review hooks (start, read, estimates)`

---

### Step 7: Picker component — replaces `RunReviewDropdown` at both call sites

**Dependencies:** Step 6 (hooks)
**Owned paths:** `client/src/components/multi-agent-picker/` (new: `MultiAgentPicker.tsx`, `index.ts`, `MultiAgentPicker.test.tsx`), `client/src/app/repos/[repoId]/pulls/_components/PRRow/PRRow.tsx` (edit), `client/src/app/repos/[repoId]/pulls/[number]/_components/PrDetailHeader/PrDetailHeader.tsx` (edit); **delete** `client/src/components/run-review-dropdown/` and `client/src/app/repos/[repoId]/pulls/[number]/_components/RunReviewDropdown/` (both fully superseded — confirm no other importer first, per the grep already done during planning: only `PRRow.tsx` and `PrDetailHeader.tsx` import them)
**What to do:**
1. Build `MultiAgentPicker` (`prId: string` prop; same size/kind/`onRunsStarted`-style callback props as the old `RunReviewDropdown` it replaces, so both call sites need minimal edits) as a **new, hand-rolled portaled panel** — the existing `Dropdown` primitive (`vendor/ui/kit/Dropdown.tsx`) only supports a flat `items: DropdownItemDef[]` list, it cannot render checkboxes + a footer button, so do not force-fit it. Reuse its `createPortal(..., document.body)` + `getBoundingClientRect()`-based positioning technique (viewport-edge flip logic already documented in `client/insights.md`'s 2026-06-29 Dropdown entry) rather than re-deriving it from scratch.
2. Panel contents: a "Select all" / "Clear" control (AC-2); one checkbox row per **enabled** agent (`Checkbox` from `vendor/ui/kit`) showing `Icon.Cpu`, `agent.name`, `agent.description` as the one-line summary (AC-1) — reuse `useAgents()` for the roster, matching `RunReviewDropdown`'s existing agent-loading call; each row also shows that agent's estimate from `useAgentEstimates(prId)` (duration/cost, or an explicit "no history" marker when `sample_size === 0`, AC-7); a combined-estimate line computed inline (no `useMemo` — trivial arithmetic) as `MAX` of selected agents' `avg_duration_ms` and `SUM` of their `avg_cost_usd`, flagging when any selected agent's estimate is missing (AC-9); a "Run Review" footer button, **disabled when zero agents are selected** (AC-4).
3. If the workspace has zero enabled agents, render the explicit empty state directing to `/agents` (AC-5) instead of an empty checkbox list — reuse the existing empty-state copy/pattern from `RunReviewDropdown`'s `agentItems` fallback.
4. On confirm: call `useStartMultiAgentRun().mutateAsync({ prId, agentIds: selected })`, then `router.push(\`/multi-agent-review/${res.multi_agent_run_id}\`)` (AC-3 — this applies even for a single selected agent).
5. Wire both call sites: `PRRow.tsx` (replace the `@/components/run-review-dropdown` import) and `PrDetailHeader.tsx` (replace its local `../RunReviewDropdown` import) to render `MultiAgentPicker` in place of `RunReviewDropdown`, preserving each site's existing `size`/`kind`/merged-PR-warning behavior where applicable.
6. Delete both old `RunReviewDropdown` directories entirely (component + styles/constants/index/test) once both call sites are switched over — do not leave dead code.
7. All user-facing strings via `next-intl` — extend the existing `prReview` namespace (`messages/en/prReview.json`) with the new picker's strings rather than hardcoding, following the existing `runReview.*` key convention already used by the old dropdown.
8. **Deliberate, accepted minor duplication:** Step 8 (parallel, same wave) implements its own agent-selection checkbox list for the Configure-run flow, independently. Do not attempt to extract a shared sub-component across these two parallel steps — the two pieces of UI are small, and forcing a shared dependency here would serialize two genuinely independent steps for a minor DRY gain.

**Verify:**
- [ ] `cd client && pnpm typecheck` passes
- [ ] `pnpm test` — new `MultiAgentPicker.test.tsx` covering: zero-selected disables Run; select-all/clear; empty-enabled-agents state; combined estimate math (MAX/SUM) with one agent missing history; navigates on success
- [ ] `PRRow.test.tsx` still passes after the swap (update its mocks if it currently mocks `run-review-dropdown` specifically)
- [ ] Grep the whole client tree for `RunReviewDropdown` after deletion — zero remaining references
- [ ] Runtime-isolation grep (§5) on the diff

**Commit:** `feat(client): replace RunReviewDropdown with the multi-agent picker`

---

### Step 8: Multi-Agent Review App-Router segment — Configure-run + results page

**Dependencies:** Step 6 (hooks)
**Owned paths:** `client/src/app/multi-agent-review/` (new: `page.tsx`, `[runId]/page.tsx`, `_components/**`), `client/src/vendor/ui/nav.ts` (edit), `client/messages/en/shell.json` (edit), `client/messages/en/multi-agent-review.json` (new)
**What to do:**
1. **Nav entry (AC-10):** add one `NavItemDef` to `NAV` in `nav.ts` (e.g. `{ key: "multi-agent-review", label: "Multi-Agent Review", icon: "Users", href: "/multi-agent-review", gKey: "m" }`) and a matching `shell.json` `nav["multi-agent-review"]` string — the command palette (`useShellCommands.ts`) resolves `t(\`nav.${it.key}\`)` and will crash the palette on mount if this key is missing (documented 2026-07-07 `client/insights.md` entry — do not skip this).
2. **`page.tsx`** (route `/multi-agent-review`) — the Configure-run flow (AC-10, AC-11): step 1 chooses a repo (`useRepos()`, defaulting to `useActiveRepo()`) then a PR within it (`usePulls(repoId)`); step 2 (agent selection + estimates, mirroring Step 7's picker logic independently per the accepted-duplication note) stays inert with an explicit "choose a PR first" prompt until a PR is chosen (AC-11). Confirm → `useStartMultiAgentRun` → `router.push` to the results route (AC-12), same as Step 7.
3. **`[runId]/page.tsx`** (route `/multi-agent-review/[runId]`) — the results page (AC-14: **always** this page for an existing run, regardless of entry point). `await params` per the Next 15 convention (`app/AGENTS.md`); page is `"use client"` at the page level via `useParams()` matching every other `repos/[repoId]/...`/`agents/[id]` page's established pattern (not the one-off async-RSC Context-page pattern).
   - `useMultiAgentRun(runId)` for the authoritative composed state (polls while running, Step 6).
   - `useRunEvents(data.columns.map(c => c.run_id))` for live per-agent status/log updates without waiting for the next poll tick (NFR: one independent SSE subscription per run — this hook already does exactly that, unmodified).
   - **Columns view** (default, AC-15): one column per `AgentColumn` — status (running/done/failed, AC-16), cost updating live, failure reason on `'failed'` (AC-17), compact finding rows (title + `file:startLine`, AC-18) from `AgentColumn.findings`, score via `CircularScore` (AC-19, same component = same banding automatically), a "View trace" link per column opening the existing `RunTraceDrawer` for that `run_id` (AC-34/35 — reuse verbatim, no new viewer).
   - **Tabs view** (AC-20-22): one tab per agent (name + score header), tab body = summary/verdict/duration/cost/trace-link, then that agent's findings as **expandable `FindingCard`s** sourced from `usePrReviews(prId)`'s cache mapped `run_id → ReviewRecord` (the established cache-join pattern, §2/§4) — this is where full finding detail + Accept/Dismiss + Turn-into-eval-case (AC-23-25, zero new server code, `FindingCard` unmodified) live; render "Learn"/"Reply to author" as visibly disabled stub buttons (AC-26).
   - **"Where agents disagree" section** (AC-27-32): omit entirely when fewer than 2 columns have `status === 'done'` (AC-32). Otherwise render `data.conflicts`, applying the AC-29/30 "not all takes share one verdict" predicate as the default filter; a "Show only conflicts" toggle (default on, AC-31) flips between the filtered and full (agreement-included) view of the same already-fetched `conflicts` array — no re-fetch on toggle.
   - **Economics** (AC-33/36): per-column `duration_ms`/`cost_usd` always visible (never collapsed), plus `total_duration_ms`/`total_cost_usd` from the composed response.
   - A "Configure run" link back to `/multi-agent-review` (AC-13).
4. All user-facing strings in the new `messages/en/multi-agent-review.json` namespace (auto-loaded by `i18n/request.ts`'s directory scan — no registry edit needed beyond creating the file).

**Verify:**
- [ ] `cd client && pnpm typecheck` passes
- [ ] `pnpm test` — RTL coverage per component: Configure-run flow's PR-gate (AC-11), Columns view failure isolation rendering (AC-17), score banding consistency between Columns and Tabs (same `CircularScore` thresholds), disagreement section omitted below the 2-done threshold (AC-32), "Show only conflicts" toggling without a new fetch, trace-drawer open call wiring (mock `RunTraceDrawer`, assert it receives the right `runId`)
- [ ] Grep for any hardcoded English string that should be a translation key
- [ ] Runtime-isolation grep (§5) on the diff

**Commit:** `feat(client): add Multi-Agent Review page (Configure-run flow, Columns/Tabs results, disagreement section)`

---

## 7. Acceptance Criteria

| AC | Delivered by |
|---|---|
| AC-1–5 (picker: list, select-all/clear, grouped-run-on-confirm, disabled-when-empty, zero-agents empty state) | Step 7 (also independently in Step 8's Configure-run flow) |
| AC-6–9 (pre-run estimates: avg-last-3, no-history marker, MAX/SUM combined, missing-estimate flag) | Step 4 (`estimatesForPr`, `multi-run-service.test.ts`), Step 6 (`useAgentEstimates`), Step 7/8 (UI) |
| AC-44 (multi-agent concurrency, isolation preserved, single/all-agents unchanged) | Step 4 |
| AC-10–14 (page entry points, Configure-run flow, PR-gate, navigate-on-confirm, reopen-shows-results) | Step 8 |
| AC-15–19 (Columns view: default, live status, failure isolation, compact findings, score banding) | Step 4 (data), Step 8 (UI) |
| AC-20–22 (Columns/Tabs toggle, no re-fetch, compact-vs-full split) | Step 8 |
| AC-23–26 (finding detail: full fields, Accept/Dismiss, Turn-into-eval-case, Learn/Reply stubs) | Step 8 (reuses existing `FindingCard`/routes — zero new server code) |
| AC-27–32 (disagreement section: grouping, per-agent take incl. "did not flag", conflict rule, exclude full-agreement by default, Show-only-conflicts toggle, <2-done omission) | Step 3 (computation), Step 4 (wiring), Step 8 (UI + client-side filter) |
| AC-33–36 (economics legibility, trace reuse, no cost collapsing) | Step 4 (data), Step 8 (UI, reuses `RunTraceDrawer`) |
| AC-37 (deterministic, zero-LLM cross-agent matching) | Step 3 |
| AC-38–39 (grouping retrievable as a whole, workspace scoping) | Step 2, Step 4 |
| AC-40 (rate limiting) | Step 4 |
| AC-41–42 (seed roster + demo disagreement) | Step 5 |
| AC-43 (every new route authenticated + workspace-scoped) | Step 4 |

## 8. Testing Plan

**Server:** hermetic (`.test.ts`, `src/adapters/mocks.ts`) for pure/deterministic logic; integration (`.it.test.ts`, Testcontainers, real ephemeral DB — never the shared dev DB) for the new routes end-to-end.
**Client:** Vitest + RTL, `fetch` mocked — no running server needed for any client test in this plan.
**Runtime isolation (binding on all of the below, per §5):** never start a server/Docker service to run these tests; integration/e2e tests use their own ephemeral resources (Testcontainers spins up its own Postgres) and must never be pointed at another worktree's `:3001`/`:3000`/`:5432`; if port/DB availability is ambiguous, stop and report rather than guessing. After every step, `git diff --name-only` + grep the changed tracked files for `3010|3011|5442|devdigest_ci|devdigest_review`.

| Test | Type | Covers |
|---|---|---|
| `conflict-matcher.test.ts` | hermetic | AC-27–30, AC-37 — grouping exactness, "ignored" take, same/different severity, running/failed exclusion, note never null |
| `multi-run-repo.test.ts` | hermetic | AC-38–39 — workspace scoping on every new query |
| `multi-run-concurrency.test.ts` | hermetic | AC-17, AC-44 — per-job failure isolation survives the worker pool; `runBus.complete` always fires |
| `multi-run-service.test.ts` | hermetic | AC-6, AC-7, AC-9 (server-side) — `estimatesForPr`/`lastSuccessfulRuns`: average of exactly the last 3 successful runs; no-history → all-null + `sample_size: 0`; one agent's zero-history entry never corrupts another agent's real numbers in the same response |
| `multi-run.it.test.ts` | integration | AC-3, AC-6 (end-to-end against real seeded run history), AC-38–40, AC-44 (wall-clock: elapsed time for N agents ≈ slowest, not sum — generous bound), cross-workspace 404 |
| existing `run-executor`/`service`/`routes` hermetic tests, re-run unmodified | hermetic | Regression guard — the sequential single-agent/`all:true`/`review-all` path is provably unchanged |
| `multi-agent-review.test.ts` (hooks) | hermetic (fetch mocked) | AC-6, AC-14 poll-while-running behavior |
| `MultiAgentPicker.test.tsx` | RTL | AC-1–5, AC-8–9 (client-side MAX/SUM combining + missing-estimate flag, built on the server-side guarantee `multi-run-service.test.ts` establishes) |
| Configure-run + results page component tests | RTL | AC-11, AC-16–19, AC-27–32 (incl. the 2-done omission and the toggle-without-refetch), AC-34 (trace drawer wiring) |

## 9. Out of Scope

- Any change to the review engine's analysis quality, prompt content, or grounding logic (`reviewer-core` untouched).
- The pre-publish "Compose Review" curation drawer — not touched.
- Any CI export or CI runner wiring (`ci/`, `agent-runner/`) — untouched, and this worktree does not coordinate with the parallel `devdigest-ci` worktree beyond the migration-number reservation already resolved in §4/Constraint 7.
- Making "Learn" and "Reply to author" functional — stubs only (AC-26).
- Changing single-agent or `review-all` execution — both remain exactly as they are today (Constraint 1).
- A workspace-wide history/list view of every multi-agent run ever started.
- A combined rate-limit/quota budget across `POST /pulls/:id/review` (`all:true`) and `POST /pulls/:id/multi-agent-run` — both stay independently rate-limited; a shared budget is an accepted residual gap, not silently ignored (Constraint 12).
- Any new port, Docker service, or Compose profile — none is needed, and none may be added per §5.
