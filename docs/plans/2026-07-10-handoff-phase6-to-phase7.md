# Handoff — Feature B "Export to CI": Phase 6 (bug review) DONE → Phase 7 (2026-07-10)

> Open this at the start of the next `/implement`-continuation session. Dialogue with the user in
> **Ukrainian**; artifacts (code, commits) stay **English**. The user commits — never commit
> yourself. **Runtime isolation is mandatory** — never assume `:3001`/`:3000`/`5432` is this
> worktree's. Supersedes `docs/plans/2026-07-10-handoff-implement-phase3-to-phase4.md` (kept for
> history — it covers Phases 1–3; this doc covers Phases 4–6 and picks up at Phase 7).

Worktree: `F:\Data\Neoversity_ai\devdigest-ci`, branch `feat/export-to-ci`.
Plan being executed: `docs/plans/2026-07-09-export-to-ci-plan.md` (11 steps, 4 waves, ≤5 parallel), driven via the `implement` skill.

---

## 1. Pipeline status

| Phase | Status |
|---|---|
| Phase 1 — Implementation (4 waves, 11 steps) | ✅ DONE |
| Phase 2 — Full local gate (typecheck + hermetic) | ✅ GREEN |
| Phase 3 — Completeness gate (plan-verifier) | ✅ DONE (56✅/3⚠️→0❌ after 1 fix round — AC-1, AC-47) |
| Phase 4 — Architecture review ∥ test coverage | ✅ DONE — architecture-reviewer APPROVE (0 Critical/High/Medium, 5 Low non-blocking); 4 test-writer instances filled real gaps in existing test files |
| Phase 5 — Architecture fix iterations | ✅ DONE — nothing to fix per the reviewer's own gate (0 Critical/High); **but see §3**, a self-directed Windows portability fix landed here too |
| **Phase 6 — Bug review (`/code-review` skill, high effort)** | **✅ DONE — see §3, by far the largest phase; 11 confirmed bugs found+fixed** |
| Phase 7 — Final verification (plan-verifier final pass, incl. §8 Testing Plan) | ⏳ **NEXT — not started** |
| Phase 8 — Closeout (insights + final report + flip spec Status) | ⏳ pending |

**Model routing (user directive, unchanged, apply through the rest of the pipeline):** implementer subagents → **Sonnet** (`claude-sonnet-5`); **Reviewer/bug-review gates → Opus** (`claude-opus-4-8`) — this covered both the architecture-reviewer AND every finder/verifier agent in Phase 6's `/code-review` pass. Intermediate gates → default/Sonnet. Spawn every agent with the explicit `model` param.

---

## 2. What's actually in the working tree (all UNCOMMITTED — user commits manually)

**69 changed paths** (`git status --porcelain` — run it yourself to confirm nothing drifted). Everything from the prior handoff's §2 file list, PLUS this session's Phase 6 fixes layered on top of the SAME files (no new files from Phase 6 — only edits + test-file extensions):

**Server, Phase 6 edits:**
- `server/src/modules/ci/repository/installations.repo.ts` — `upsertPublished`'s `setWhere` guard + `AppError` on blocked conflict
- `server/src/modules/ci/export-service.ts` — 6 fixes (see §3)
- `server/src/vendor/shared/adapters.ts` + `client/src/vendor/shared/adapters.ts` — `GitHubClient.getDefaultBranch` added (byte-identical mirror)
- `server/src/adapters/github/octokit.ts` — `getDefaultBranch` impl
- `server/src/adapters/mocks.ts` — `MockGitHubClient.getDefaultBranch`
- `server/src/adapters/runner-bundle/ncc.ts` — Windows `execFile('pnpm',...)` fix (self-directed, see §3)
- `server/src/modules/ci/ingest-service.ts` — per-installation isolation + skip-redundant-redownload
- `server/src/modules/ci/repository/runs.repo.ts` — new `statusesByGithubRunId` method
- Test files extended (not rewritten): `ci-installations-repository.test.ts`, `ci-export-service.test.ts`, `adapters.test.ts`, `ci-helpers.test.ts`, `ci-ingest-service.test.ts`, `ci-runs-repository.test.ts`

**Client, Phase 6 edits:**
- `client/.../CITab/_components/ExportWizard/useExportWizardFlow.ts` — real `base` wire-through, unchecked cast removed
- `client/src/lib/hooks/ci.ts` — `useExportCi` response typed with `secret_value`
- `client/.../CITab/_components/InstallationRow.tsx` — now imports `STATUS_META`/`DEFAULT_STATUS_META` from `CiRunsView/constants.ts` (was a drifted local copy)
- `CITab.test.tsx`, `ExportWizard.test.tsx` extended

**Docs:** this handoff (new) + the superseded prior one (kept). `server/insights.md` now **138 entries** (was 130 at Phase 4 start), `client/insights.md` now **76 entries** (was 72). All genuinely new discoveries, not noise — worth a skim if you want texture on *why* each fix looks the way it does (each Phase-6 fix has its own Decision/Mistake/Pattern entry with the reasoning).

---

## 3. Phase 6 result — READ THIS BEFORE RE-LITIGATING ANYTHING

This is the important part. A `/code-review` pass at **high effort** (8 finder angles → 32 raw candidates → dedup → 16 individually verified via dedicated Opus verifier agents) found **13 CONFIRMED + 2 REFUTED**. This is a materially different picture than Phase 4's architecture-reviewer verdict (0 Critical/High/Medium) — **two of the confirmed bugs are genuine High-severity findings that Phase 4 missed**, one of them (`bulkUpdate`'s hardcoded `base:'main'`) an actual P1 violation (load-bearing workaround, justified by an 11-line comment) of exactly the kind Phase 4 was explicitly instructed to hunt for and reject. **Do not treat Phase 4's APPROVE as the last word on this diff's correctness** — Phase 6 is the more rigorous pass; trust its findings.

**Before Phase 6 even started**, a manual Windows-compat check (prompted by the architecture-reviewer's own out-of-scope note) found and fixed a 14th, separate bug: `NccRunnerBundler.build()` called `execFile('pnpm', [...])`, which **always fails on Windows** (`pnpm` resolves to a `.ps1`/`.cmd` shim; Node's `execFile` without `shell:true` cannot launch either without a shell — confirmed via `Get-Command pnpm` + a live reproduction). Fixed by invoking `@vercel/ncc`'s own JS CLI entry (`node_modules/@vercel/ncc/dist/ncc/cli.js`) via `process.execPath` directly — same no-shell/fixed-args security posture, no dependency on the pnpm wrapper. Verified by running the exact new command directly (succeeded, produced `dist/index.js`).

**All 11 confirmed-and-fixed bugs** (ranked by the severity the verifiers assigned):

1. **TOCTOU race in `upsertPublished`** (High) — `ON CONFLICT SET agentId=excluded.agentId` had no guard; two near-simultaneous exports of different agents to the same repo could silently hijack each other's installation, defeating the one-agent-per-repo invariant. Fixed with `setWhere: or(eq(agentId, values.agentId), isNotNull(disconnectedAt))` (atomic DB-level guard) + `AppError('repo_already_installed', ..., 409)` on the blocked (0-row-returned) case.
2. **Disconnect-takeover semantics** (usability bug + real product decision) — a disconnected installation permanently blocked any OTHER agent from ever claiming that repo (the "disconnect it first" error message was a dead end once already disconnected). **User decision (this session): a disconnected installation is a fully free slot** — any agent can claim it; slug regenerates for a different claiming agent (frozen-slug invariant only applies to same-agent rename/reconnect). Same `setWhere` fix as #1 serves both bugs atomically.
3. **`bulkUpdate`'s hardcoded `base: 'main'`** (High, genuine P1 violation) — broke for any repo whose default branch isn't `main`, specifically for installations first published via `action:'files'` (never created the branch). Fixed: new `GitHubClient.getDefaultBranch(repo)` port method (additive to `adapters.ts` + client mirror + `octokit.ts` + `mocks.ts`), queried per-installation instead of guessing.
4. **`IngestService`'s check loop had no per-installation isolation** (High) — one unreachable repo aborted the WHOLE workspace's `/ci/check`, forever, until manual disconnect. Compounded with a 5th, separate finding (`ci_runs.github_run_id`'s deliberately-global unique index — a documented, correct tradeoff on its own) to create a scenario matching an explicitly-supported use case (two workspaces tracking the same repo) where the LOSING workspace's ingest broke permanently. Fixed with a per-installation try/catch; `setLastCheckedAt` now fires even when some installations individually failed, as long as the loop completed its pass. This single fix closed both the isolation bug and its compounding case.
5. **`getAgentCiSurface`'s `latest_run_status` wrongly limited to the 7-day rollup window** (Medium) — an installation whose last run was >7 days old showed `null` ("never run") despite real history, contradicting the field's own documented contract. Fixed with a second, unwindowed `runsRepo.list` call, decoupled from the 7-day rollup query.
6. **Redundant artifact re-download every poll** (Medium, ties directly to the AC-27 30s budget) — up to ~20 wasted GitHub calls per installation per check for runs already ingested with a terminal status. Fixed with a new `RunsRepository.statusesByGithubRunId` lookup, skipping re-fetch for terminal+artifact-populated runs (degraded/null-artifact runs still retry).
7. **Empty slug for non-ASCII agent names** (Medium-low, reachable — no upstream name validation requires ASCII) — `slugify('日本語')` etc. returns `''`, producing a malformed `.devdigest/agents/.yaml` path. Fixed with a `slugFor` fallback (`slugify(name) || 'agent-${agentId.slice(0,8)}'`); `slugify` itself is unchanged (still correctly returns `''` — the fallback belongs in the caller).
8. **`InstallationRow.tsx`'s status-to-visual map had already drifted** from `CiRunsView`'s canonical `STATUS_META` (3 of 5 statuses differed in icon/color; the code comment falsely claimed "reused"). Fixed by importing `STATUS_META`/`DEFAULT_STATUS_META` directly (the fix also had to wire `bg`, not just icon/color, or 4/5 statuses would still mismatch — caught during implementation).
9. **`bulkUpdate` wasted work on zero active installations** (Low) — built the ncc bundle + GitHub client before checking if there was anything to update. Fixed with an early return.
10. **Client Export Wizard hardcoded `base:"main"`** (Medium, same root issue as #3 but client-side/first-export path) — `selectedRepo.default_branch` was already fetched and unused. One-line fix.
11. **`useExportCi` hook's response type missing `secret_value`** (Low, type-safety only — not a live runtime bug, papered over by an unchecked cast). Fixed by typing the hook's response correctly and deleting the cast.

**Two findings deliberately left unfixed** (both individually verified, both explicitly downgraded to Low/non-reachable by their verifier — re-open only with a genuinely new angle):
- `withTimeout` can't cancel the detached `runCheckLoop` after a client-visible timeout — confirmed mechanically, but idempotent upserts mean no data corruption, just a transient UI/state mismatch. Verifier's own words: "textbook accepted `Promise.race`-timeout tradeoff."
- Duplicate `owner/name` repo-string parser (`parseRepoFullName` throws vs `parseRepoRef` silently degrades) — confirmed as a real code-quality/consistency issue, but confirmed UNREACHABLE in production (the only writer of `ci_installations.repo` already validates before persisting, per the AC-1 fix from Phase 3).

**Two candidates REFUTED** (don't re-flag without new evidence): migration NOT NULL columns without defaults (structurally impossible to violate — no insert path into these tables existed before this feature); `pr_number` sourced from the CI result artifact "violating AC-22" (AC-22 is narrowly scoped to workspace/installation tenancy attribution, not every display field — `pr_number` is never used for authorization/lookup).

**Known, disclosed, non-blocking:** `client/src/vendor/shared/adapters.ts`'s `GitHubClient` interface is still missing `commitFiles`/`findOpenPr`/`CommitFile`/`CommitFilesPayload` (present server-side, absent client mirror) — pre-existing drift from the original feature build, not touched by any Phase 6 fix, doesn't break client typecheck today (nothing in `client/` implements `GitHubClient`). Worth a future pass, not urgent.

---

## 4. Full local gate — current numbers (re-run before trusting if time has passed)

- **Server typecheck:** clean
- **Server hermetic** (`--exclude '**/*.it.test.ts'`): **811/819**. The 8 failures are the same pre-existing Windows-only `ENOENT` temp-path issue in `indexer-pipeline.test.ts`/`conventions-extractor.test.ts`/`indexer-walk.test.ts` documented in `server/insights.md` (2026-07-02) — confirmed untouched by `git diff`. Not a regression.
- **Client typecheck:** clean
- **Client full suite:** **289/290**. The 1 failure (`EvalsTab.test.tsx`, Skills Eval module, a 5000ms test-timeout) is a pre-existing environmental flake, unrelated to this feature — the implementer who found it ran the file in isolation (16/16 passed, including that test at 1910ms, well under budget) and re-ran the full suite clean. Confirmed via `git status` the file is untouched this session.
- **Server integration (`ci-routes.it.test.ts`): NOT independently re-verified after Phase 6's fixes.** 4 attempts this session, all blocked by Docker Desktop responsiveness degradation from this session's own heavy cumulative load (Phase 4 alone ran 5 parallel Opus agents; Phase 6 ran 8 finders + 16 verifiers + 3 implementers, all parallel, all Opus/Sonnet). Root-caused, not just retried blind: `test/helpers/pg.ts`'s `dockerAvailable()` does `execSync('docker info', {timeout: 5000})` — attempts 1–2 passed that check but then hit `Hook timed out in 120000ms` during container/DB setup; attempts 3–4 failed the 5s `docker info` check itself even though plain `docker ps` responded instantly both times. **This is an environment issue, not a code issue**: this exact file passed **10/10** earlier THE SAME SESSION (Phase 4's test-coverage pass, before any Phase 6 fix), and `server/src/modules/ci/routes.ts` itself was not touched by any of the 3 Phase 6 implementers — only the service/repository layer beneath it, which the hermetic suite covers with realistic scenarios for every one of the 11 fixes above.
  **Action for the next session: run `cd server && pnpm exec vitest run test/ci-routes.it.test.ts` once, fresh, before Phase 7 concludes** — ideally after confirming Docker Desktop is idle/responsive (`docker info` should return near-instantly; if not, restart Docker Desktop first).

---

## 5. Runtime isolation — still mandatory, re-verify don't assume

Same profile as before: `CLIENT_PORT=3010 · API_PORT=3011 · POSTGRES_PORT=5442 · DATABASE_NAME=devdigest_ci`, container `devdigest-postgres-ci`. Confirmed **Up** at both the start and end of this session (no restart needed). Pre-flight before anything that needs it:
```sh
docker ps --filter name=devdigest-postgres-ci   # check if Up
docker start devdigest-postgres-ci              # if Exited — container + volume persist
```

**New this session — Docker hygiene note:** two orphaned Testcontainers Postgres instances (`priceless_dewdney`, `romantic_dewdney`, random-named per Testcontainers convention) were left running by this session's timed-out/interrupted integration-test attempts — Ryuk (the Testcontainers reaper sidecar, `testcontainers-ryuk-*`) should eventually clean these up on its own; if they're still present next session and `docker ps` shows more than the 2 persistent dev containers (`devdigest-postgres`, `devdigest-postgres-ci`), it's safe to `docker rm -f` any extra randomly-named `pgvector/pgvector` containers — they're disposable test fixtures, never anything with real data.

**Phase 7** (plan-verifier final pass) needs no live infra for the verification itself — it's a read-only pass over the plan vs. the codebase, same as Phase 3. The pending §4 integration re-run is the only live-infra need before Phase 7 can be considered fully closed.

**Hard rule, unchanged:** never hardcode `3010`/`3011`/`5442`/`devdigest_ci`/`devdigest_review` into committed code — every Phase 6 fix's §5 pre-finalize grep sweep came back clean; keep enforcing this.

---

## 6. What Phase 7 actually is

Per the `implement` skill: a **final `plan-verifier` pass** (Opus, per the model-routing directive — Reviewer gates run on Opus), this time explicitly **including the §8 Testing Plan grades** (the first plan-verifier pass in Phase 3 only graded the 11 Implementation Steps + 48 Acceptance Criteria, not the Testing Plan table — Phase 4's test-coverage work and Phase 6's regression tests are what's being graded now).

Give it: `docs/plans/2026-07-09-export-to-ci-plan.md` (full plan, especially §7 ACs and §8 Testing Plan) + this handoff (for Phase 6 context — so it doesn't re-flag the 2 deliberately-unfixed Low items or the 2 REFUTED candidates as new findings) + instruct it to also confirm the 11 Phase-6 fixes didn't silently regress anything Phase 3 already verified (spot-check AC-1/AC-4/AC-5/AC-13/AC-45/AC-47, since those are exactly the ACs the slug-freeze/conflict/disconnect logic — now rewritten in Phase 6 — governs).

**After Phase 7:** Phase 8 — `engineering-insights` Mode B (session wrap, though both insights.md files are already very well-populated from Phase 6's implementers — this would be a lighter pass) + a final report to the user + remind them to flip the spec's Status → `implemented` via spec-creator (`docs/feature-requirements/2026-07-09-ci-agent-runner-pipeline.md`).

**Suggested commit message** for this session's Phase 6 work (user commits manually, never me — split into multiple commits if preferred, this is one reasonable unit):
```
fix(ci): close 11 code-review findings — race condition, disconnect-takeover, ingest isolation

- Close a TOCTOU race in InstallationsRepository.upsertPublished (setWhere guard) and make
  disconnected installations a fully-free slot for a different agent (product decision)
- Replace bulkUpdate's hardcoded base branch with a real GitHubClient.getDefaultBranch call
- Isolate IngestService's per-installation check loop so one broken repo no longer aborts
  the whole workspace's CI check (also closes a cross-workspace run-id collision case)
- Skip redundant artifact re-downloads for already-terminal runs (protects the AC-27 budget)
- Fix getAgentCiSurface's latest_run_status being wrongly limited to the 7-day rollup window
- Add an empty-slug fallback for non-ASCII agent names; early-return bulkUpdate on zero
  active installations
- Client: wire the Export Wizard's base branch from the real repo default, type
  useExportCi's secret_value properly, unify InstallationRow's status styling with
  CiRunsView's canonical STATUS_META (had silently drifted)
- Fix NccRunnerBundler's execFile('pnpm', ...) failing on Windows (pnpm resolves to a
  non-executable .ps1/.cmd shim) by invoking ncc's own JS CLI via process.execPath
```

---

## 7. Task tracking

Recreate this task list at the start of the new session (`TaskCreate` ×11, mark #1–9 `completed`, #10 `in_progress` when you start Phase 7):

1. Wave 1/Step 1 — ✅ completed
2. Wave 2/Steps 2-6 — ✅ completed
3. Wave 3/Steps 7-10 — ✅ completed
4. Wave 4/Step 11 — ✅ completed
5. Phase 2 full local gate — ✅ completed
6. Phase 3 completeness gate — ✅ completed
7. Phase 4 architecture review ∥ test coverage — ✅ completed
8. Phase 5 architecture fix iterations — ✅ completed (0 Critical/High from the reviewer; 1 self-directed Windows fix landed here)
9. Phase 6 bug review (`/code-review`) — ✅ completed (11 confirmed bugs fixed, 2 deliberately left, 2 refuted — see §3)
10. Phase 7 final verification — pending, **start here**
11. Phase 8 closeout — pending

---

## 8. Related memory

`lesson07-parallel-implementation-demo`, `session-limit-recovery-technique` (used again this session — 2 of the 3 Phase 6 implementers hit the usage limit mid-task and were successfully resumed via `SendMessage`, zero work lost), `worktree-runtime-isolation`, `engineering-principle-fix-the-process`, `ci-agent-runner-wiring-gap`.
