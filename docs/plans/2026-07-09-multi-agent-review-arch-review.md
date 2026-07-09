# Pre-plan Architecture Review — Multi-Agent Review (SPEC-2026-07-09)

> Structural/contract gate BEFORE the plan (no code exists yet). Input for
> implementation-planner. Verdict: approach is architecturally sound — reuses
> existing patterns/primitives; no new architecture invented. **Simple enough to plan.**

## Constraints (MUST — the plan honors each)

1. **Concurrency = a distinct code path, NOT an edit to the shared loop.** `run-executor.ts:204-231` is the one `for…of` used by single-agent, `all:true`, and `review-all`'s inner loop. AC-44 keeps those sequential. `jobs.length` can't distinguish `all:true` from `agentIds:[...]` — thread an explicit signal (new method e.g. `executeRunsConcurrent`, or a `concurrent` flag only from the new call site). Never touch lines 204-231 unconditionally.
2. **Concurrency orchestration stays server-side; `reviewer-core` untouched** (side-effect-free charter). Scheduling wraps the already-pure per-agent `reviewPullRequest()`; loop stays in `run-executor.ts`.
3. **Reuse the existing bounded-concurrency shape** — `eval/run-orchestrator.ts:394-414` `runWithConcurrencyCap` (await-all variant) or `p-queue`. Do NOT invent a 4th primitive. Semantics needed = await-all (wall-clock ≈ slowest).
4. **Per-agent failure isolation survives the worker pool** (AC-17/AC-44). `runBus.complete(runId)` must fire unconditionally per item; the `runOneAgent` internal guards are unaffected. Use allSettled semantics, not all.
5. **`agentIds: string[]` is a TWO-file edit** — `server/src/vendor/shared/contracts/platform.ts:250-254` AND the byte-identical client mirror `client/src/vendor/shared/contracts/platform.ts:250-254` (no sync script). Real exception to "never define a type twice". Implies a `:3001` restart.
6. **`multi_agent_runs` linkage strictly additive** — no rename/retype of any existing column on `agent_runs`/`multi_agent_runs`/`run_traces`. FK-column vs join-table both OK if additive.
7. **Migration number ≥ 0024** (latest applied = `0022`; Feature B reserved `0023`). NOTE: real migrations live at `server/src/db/migrations/` per `drizzle.config.ts:8-9` — `server/src/db/AGENTS.md:7`'s `server/drizzle/` path is STALE; don't get misdirected.
8. **Every new `agent_runs`/`multi_agent_runs` read filters by `workspace_id`** (schema already `.notNull()`; carry the filter through the new repository read-path).
9. **Response contract frozen + one gap:** `observability.ts:23-86` is the sole correct source. `ConflictTake.note` is non-nullable `z.string()` — matcher must always emit a real string (`''` when no reasoning). Do NOT add nullability (do-not-touch file).
10. **New module imports only its own files + `@devdigest/shared` + `../../platform/container`.** `ReviewService`/`ReviewRunExecutor`/`ReviewRepository` are NOT container-exposed — a sibling module can't reach `../reviews/service.js`. (See Placement #2.)
11. **Routes thin, Zod-driven, `AppError`/`NotFoundError`, `getContext` scoping** — mirror `reviews/routes.ts`.
12. **Rate-limit config in `reviews/constants.ts`** (like `BRIEF_GENERATE_RATE_LIMIT` at `constants.ts:64`), reusing the 10/min + 2/min precedents — not literals in the route.
13. **Client:** picker (replacing `RunReviewDropdown`) inherits cross-route placement in `client/src/components/`; the Configure-run flow + results page = a new top-level App-Router segment with its own `_components/`; hooks follow `use<Domain><Action>` (`useStartMultiAgentRun`, `useMultiAgentRun`); `apiFetch`-only, vendored UI.

## Placement decisions (settled by the review)

- **Cross-agent matcher (AC-37) → server module `modules/reviews/conflict-matcher.ts`** (pure, zero-I/O, `@devdigest/shared` types only) — NOT `reviewer-core` (no 2nd consumer; CI is non-goal). Precedent: `eval/scoring.ts`.
- **Multi-run → `modules/reviews/multi-run.routes.ts` (+ service)**, registered in `modules/index.ts` mirroring `smartDiff` — same-folder sibling free to import `run-executor.ts`/`repository.ts`. NOT a new `modules/multi-run/`.

## Risks / watch-items (plan should mitigate)

- `Container.llm()` cache race under concurrency (`container.ts:213-221`) — wasted work, not a correctness bug.
- Concurrent FS reads on the same git clone (`run-executor.ts:624-727` `buildContextDocs`) — `SimpleGitClient` concurrency-safety UNVERIFIED; confirm before assuming safe.
- `total_duration_ms`/`total_cost_usd` on `MultiAgentRun` are computed, not stored, and non-nullable — define "duration so far" for a still-running group on GET.
- Use `agentIds` (camelCase) for the request field (matches `agentId`); the `{agent_ids}` snake_case doc snippet is stale.
- Don't conflate `scheduleNext` (fire-and-forget, `routes.ts:312-325`) with the new await-all pool — the wrapper must gate on "all agents settled".
- Two rate-limited paths to the same fan-out — ensure no combined-budget bypass if both old + new routes stay reachable.

## Green-lights (already sound — planner shouldn't second-guess)

- Frozen contracts (`observability.ts:23-86`) — build directly against; zero runtime producers/consumers today.
- `ReviewService.runReview` already fans an arbitrary `AgentRow[]` into per-agent `agent_runs` (`service.ts:111-146`) — picker needs zero change here.
- `RunBus` (`sse.ts:19-21`) + `RunLogger.forRun()` (`run-logger.ts:45-47`) already isolate per-run streams — concurrent `runOneAgent` across `runId`s is safe; SSE `GET /runs/:id/events` reused as-is.
- `RunTraceDrawer` + `LiveLogStream` reuse for "View trace" — zero new viewer code (`TraceBody` sections already cover AC-35).
- Accept/Dismiss + "Turn into eval case" — server-change-free (`POST /findings/:id/action`, `POST /findings/:id/evals/case`).
- `multiAgentRuns.workspaceId` already `.notNull()` cascade FK — AC-39 scoping pre-enforced.
- Capped-concurrency primitives already exist (`p-queue`, `eval/run-orchestrator.ts:398-414`) — nothing new to invent.

_Scope note: this was a structural/contract audit only — no security or runtime-bug review (that's `code-review`/`pr-self-review`, in the /implement gates)._
