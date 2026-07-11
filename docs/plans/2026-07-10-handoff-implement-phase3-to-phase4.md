# Handoff — Feature B "Export to CI": Implementation DONE + Phase 3 DONE → Phase 4 (2026-07-10)

> Open this at the start of the next `/implement`-continuation session. Dialogue with the user in
> **Ukrainian**; artifacts (code, commits) stay **English**. The user commits — never commit
> yourself. **Runtime isolation is mandatory** — never assume `:3001`/`:3000`/`5432` is this
> worktree's.

Worktree: `F:\Data\Neoversity_ai\devdigest-ci`, branch `feat/export-to-ci`.
Plan being executed: `docs/plans/2026-07-09-export-to-ci-plan.md` (11 steps, 4 waves, ≤5 parallel), driven via the `implement` skill. Original plan→implement handoff (superseded by this one, kept for history): `docs/plans/2026-07-09-handoff-export-to-ci-plan-to-implement.md`.

---

## 1. Pipeline status

| Phase | Status |
|---|---|
| Phase 1 — Implementation (4 waves, 11 steps) | ✅ DONE — all steps implemented, all owned-path files present |
| Phase 2 — Full local gate (typecheck + hermetic) | ✅ GREEN (re-run 3×, after Wave 2/3/4) |
| Phase 3 — Completeness gate (plan-verifier pass 1) | ✅ DONE — see §3 below |
| **Phase 4 — Architecture review ∥ test coverage** | **⏳ NEXT — not started** |
| Phase 5 — Architecture fix iterations | ⏳ pending |
| Phase 6 — Bug review (`/code-review`) | ⏳ pending |
| Phase 7 — Final verification (plan-verifier final pass) | ⏳ pending |
| Phase 8 — Closeout (insights + final report) | ⏳ pending |

**Model routing (user directive, apply throughout the rest of the pipeline):** implementer subagents → **Sonnet** (`claude-sonnet-5`); the **final Architect (architecture-reviewer) + Reviewer/bug-review gate (`/code-review`) → Opus** (`claude-opus-4-8`). Intermediate gates (completeness/test-coverage) → default/Sonnet. Spawn every agent with the explicit `model` param — it overrides the agent-definition frontmatter.

---

## 2. What's actually in the working tree (all UNCOMMITTED — user commits manually)

All 11 steps landed. New/modified surface, in one place so a fresh session doesn't have to rediscover it:

**Server** (`server/src/modules/ci/` — new module):
`routes.ts` (7 endpoints) · `export-service.ts` · `ingest-service.ts` · `helpers.ts` (slugify/dedupeSlug/composeCiFiles/`CI_RESULT_ARTIFACT_NAME`) · `manifest.ts` (agentManifestYaml) · `workflow.ts` (generateWorkflowYaml) · `ingest-helpers.ts` (parseResultArtifact/mapGithubRunToStatus) · `repository/installations.repo.ts` · `repository/runs.repo.ts`.

Plus: `server/src/adapters/runner-bundle/ncc.ts` (new, `NccRunnerBundler`) · `server/src/db/schema/ci.ts` (extended) · `server/src/db/migrations/0023_bitter_changeling.sql` (applied to this worktree's dev DB) · `server/src/vendor/shared/{adapters.ts,contracts/eval-ci.ts}` (extended, byte-identical client mirror) · `server/src/adapters/github/octokit.ts` + `mocks.ts` (4 new `GitHubClient` methods + `MockRunnerBundler`) · `server/src/platform/container.ts` (`runnerBundler` getter) · `server/src/modules/index.ts` (`ci` registered).

Test files: `server/test/ci-{export-service,helpers,ingest-helpers,ingest-service,installations-repository,manifest,runs-repository,workflow}.test.ts` (hermetic) + `server/test/ci-routes.it.test.ts` (integration, 10 scenarios) + `server/test/container.test.ts` + `server/test/adapters.test.ts` (extended).

**Client:** `client/src/lib/hooks/ci.ts` (new, 7 hooks) · `client/messages/en/ci.json` (extended additively) · `client/src/vendor/ui/nav.ts` + `client/messages/en/shell.json` (CI Runs nav entry) · `client/src/app/agents/[id]/_components/AgentEditor/{AgentEditor.tsx,constants.ts}` (CI tab wired) · `client/src/app/agents/[id]/_components/AgentEditor/_components/CITab/**` (new folder: `CITab.tsx`, `_components/{InstallationRow,BulkUpdateResults}.tsx`, `_components/ExportWizard/**` — split into `useExportWizardFlow.ts` + `_steps/{TargetStep,PreviewStep,ConfigureStep,InstallStep}.tsx` + `WizardFooter.tsx`, all under react-best-practices' 200-line rule) · `client/src/app/ci-runs/**` (new: `page.tsx` + `_components/CiRunsView/**`) · `client/src/vendor/shared/{adapters.ts,contracts/eval-ci.ts}` (mirrored).

---

## 3. Phase 3 completeness result (already resolved — do not re-litigate)

plan-verifier pass 1 found **56 ✅ / 3 ⚠️ / 0 ❌** across 59 rows (11 steps + 48 ACs). The 3 ⚠️ (Step 7, AC-1, AC-47) were all the SAME underlying pair of real gaps:

1. **AC-1** — `exportInstallation` used client-supplied `input.repo` instead of the server-validated `repoRow.fullName` for GitHub calls + persistence (a real "arbitrary string" gap). **Fixed**: now uses `repoRow.fullName` throughout, mirroring `previewFiles`'s already-correct pattern. Proven by a new test in `ci-export-service.test.ts` (mismatched `input.repo` never reaches GitHub calls or the persisted row).
2. **AC-47** — `InstallationsRepository.upsertPublished`'s `ON CONFLICT ... DO UPDATE SET` never cleared `disconnected_at`, undercounting a reconnected installation as inactive. **Fixed**: `disconnectedAt: null` added to the SET clause. Proven by a new test in `ci-installations-repository.test.ts` (disconnect → re-publish round trip clears the flag, `workflowVersion` still increments normally).

Re-verified via the SAME plan-verifier instance (continued via `SendMessage`, not respawned) with direct file:line evidence — both closed, Step 7 flipped back to ✅. **Completeness loop used: 1/2.** Do not re-open AC-1/AC-47/Step-7 in Phase 4/7 unless you find a genuinely NEW angle on them.

**One pre-existing note, not a defect:** AC-43 (run history columns) is ✅ but implemented as visually-paired cells (repo+agent one cell, cost+duration one cell) rather than 8 separate headers — a deliberate, disclosed choice by the Step 10 implementer (`ci.json`'s `runs.table` only drafted 6 header keys). Don't flag this as incomplete.

---

## 4. Phase 2 gate — last confirmed-green numbers (re-run before trusting if much time has passed)

- Server typecheck: clean
- Server hermetic (`--exclude '**/*.it.test.ts'`): **789/797** passed. The 8 failures are `conventions-extractor.test.ts`/`indexer-pipeline.test.ts`'s pre-existing Windows-only `ENOENT` temp-path issue (documented `server/insights.md` 2026-07-02) — confirmed via `git diff` those files are 100% untouched by this plan. Not a regression, don't investigate further.
- Server integration (`.it.test`): `ci-routes.it.test.ts` **10/10** passed (Docker daemon only, Testcontainers' own ephemeral Postgres — never this worktree's dev container). One pre-existing, confirmed-unrelated flake in `test/reviews.it.test.ts` (a map-reduce grounding trace assertion) — `reviews/` module has zero diff against this plan, don't investigate.
- Client typecheck: clean
- Client tests: **288/288** passed

---

## 5. Runtime isolation — still mandatory, re-verify don't assume

This worktree prefers, if free: `CLIENT_PORT=3010 · API_PORT=3011 · POSTGRES_PORT=5442 · DATABASE_NAME=devdigest_ci`, Postgres container `devdigest-postgres-ci` (standalone `docker run`, **not** `docker compose` — this repo's compose file isn't parameterized). `server/.env` / `client/.env` were already created earlier this session (gitignored, still on disk unless the user removed them) pointing at this profile. Sibling worktree `../devdigest-review` may hold the **default** ports (3000/3001/5432) — never assume those are yours.

**As of the end of the prior session:** the container was confirmed running with data intact (1 workspace, 6 agents, 0 ci_installations — migration 0023 + seed both applied). **Do not assume it's still running now** — significant time may have passed. Pre-flight before anything that needs it:
```sh
docker ps --filter name=devdigest-postgres-ci   # check if Up
docker start devdigest-postgres-ci              # if Exited — container + volume persist, no re-migrate/seed needed
```
Phase 4 (architecture-reviewer + test-writer) needs **no live infra** for the review itself; test-writer may run hermetic tests (no DB) and, if it adds integration coverage, needs only the **Docker daemon** (Testcontainers), never the dev container above. The dev container matters again only for the eventual end-of-plan manual smoke test (`pnpm dev` on :3011 / `next dev -p 3010`) — **not done yet, still pending**, and per project rule the AI never starts that server itself — pause and hand the user the runbook when that point is reached.

**Hard rule, unchanged:** never hardcode `3010`/`3011`/`5442`/`devdigest_ci`/`devdigest_review` into committed code — every step so far has passed its grep sweep clean; keep enforcing this in Phase 4's fixes too.

---

## 6. What Phase 4 actually is (per the `implement` skill)

Spawn IN PARALLEL (one message, two `Agent` calls):

- **`architecture-reviewer`** (model: `opus`), scoped to `server/src/modules/ci/**`, the 2 adapter files (`octokit.ts`/`mocks.ts`/`runner-bundle/ncc.ts`/`container.ts`), and the client CI surfaces (`CITab/**`, `ci-runs/**`, `hooks/ci.ts`). **Explicitly instruct it to enforce P1 (no load-bearing workarounds) and P2 (fix the generator, not the symptom) as REJECT-worthy gate criteria, not just notes** — this is the plan's own explicit framing (plan §4). Give it the plan file path and this handoff for context; it has Read/Glob/Grep, it can look things up itself.
- **`test-writer`**, one instance per `docs/plans/2026-07-09-export-to-ci-plan.md` §8 Testing Plan row group (29 rows total — plan-verifier's pass-1 report confirmed test files structurally exist for all of them already, e.g. `ci-helpers.test.ts`, `ci-workflow.test.ts`, `CITab.test.tsx`, `ExportWizard.test.tsx`, `CiRunsView.test.tsx` — the task is to verify/fill actual assertion coverage against §8's table, not necessarily create new files from scratch). Split by server-hermetic / server-integration / client-RTL if one instance per Testing Plan row group is too fine-grained — use judgement, cap reasonable parallelism.

They cannot conflict (reviewer is read-only; test-writer only writes test files).

**After Phase 4:** Phase 5 fixes Critical/High findings (implementer, Sonnet) → re-review via `SendMessage` to the SAME architecture-reviewer instance, scoped to touched files only (loop cap 2). Then Phase 6 (`/code-review` skill on the working diff, Opus) → fix confirmed bugs (loop cap 2). Then Phase 7 (plan-verifier final pass, Opus, this time INCLUDING the Testing Plan §8 grades). Then Phase 8 (engineering-insights Mode B + final report + remind the user to flip the spec's Status → `implemented` via spec-creator).

---

## 7. Task tracking

Recreate this task list at the start of the new session (`TaskCreate` ×11, mark #1–6 `completed`, #7 `in_progress` when you start Phase 4):

1. Wave 1/Step 1 — ✅ completed
2. Wave 2/Steps 2-6 — ✅ completed
3. Wave 3/Steps 7-10 — ✅ completed
4. Wave 4/Step 11 — ✅ completed
5. Phase 2 full local gate — ✅ completed
6. Phase 3 completeness gate — ✅ completed
7. Phase 4 architecture review ∥ test coverage — ⏳ **start here**
8. Phase 5 architecture fix iterations — pending
9. Phase 6 bug review — pending
10. Phase 7 final verification — pending
11. Phase 8 closeout — pending

---

## 8. Notable implementer self-corrections worth knowing (context, not action items)

- Step 3 added a missing `actions/checkout@v4` step to the generated workflow (plan never mentioned it; workflow can't function without it).
- Step 4 replaced the plan's literal `ON CONFLICT (workspace_id, user_id, key)` SQL (would never match — Postgres treats NULL as distinct from NULL) with a read-then-write, same external behavior.
- Step 8 broadened "artifact not found by name → null" to "any resolution failure → null" (list/download failures too) — disclosed, reasoned, matches `parseResultArtifact`'s own never-throw contract.
- Step 9 self-caught and fixed its own files exceeding react-best-practices' 200-line limit during its own self-review (before this handoff was written) — already reflected in the file list in §2.
- This implementation survived one 5-hour session-usage-limit interruption mid-Step-11 (routes.ts done, integration tests not yet started) — fully recovered via `SendMessage`-resume of the same cut-off agent. See memory `session-limit-recovery-technique.md` if it happens again.

## 9. Related memory

`lesson07-parallel-implementation-demo`, `session-limit-recovery-technique`, `worktree-runtime-isolation`, `engineering-principle-fix-the-process`, `ci-agent-runner-wiring-gap`.
