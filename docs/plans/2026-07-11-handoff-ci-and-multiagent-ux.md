# Handoff — CI export + Multi-Agent Review UX (2026-07-11)

**Branch:** `feat/lesson_07` · **HEAD:** `f1a9fb3` · **All work below is UNCOMMITTED.**
**Runtime:** the user runs their OWN `:3001` (API) + `:3000` (web). The server is in watch mode / was
restarted, so **most changes are already LIVE** (verified via live API + browser). Client changes are
live via HMR. **Nothing is committed** — the user commits (per project workflow; the agent never commits).

Gates at handoff: **server typecheck ✅, client typecheck ✅**; CI tests **114/114**, multi-agent client tests **42/42**, plus workflow/ingest/installations suites green.

---

## What was done this session (8 changes, all green, all uncommitted)

### 1. Multi-Agent trace-drawer / Tabs showed 0 findings → FIXED (the recurring bug)
Root cause: commit `a529535` excluded multi-agent fan-out runs from `reviewsForPull`
(`GET /pulls/:id/reviews`); the results page sourced full finding detail from `usePrReviews`, so the
trace drawer + Tabs showed 0 while columns showed findings.
Fix ("Variant A"): added **`findings_by_run: Record<run_id, FindingRecord[]>`** to the `MultiAgentRun`
contract; `getComposedRun` populates it from `findingsAndReviewsForRuns` (same source as conflicts); the
client reads it and **no longer uses `usePrReviews`** on that page.
- `server|client/src/vendor/shared/contracts/observability.ts` (both copies), `server/.../reviews/multi-run.service.ts`
- `client/.../MultiAgentResultsView.tsx`, `.../TabsView/TabsView.tsx` (+ tests)
- **Shared-contract change → needs `:3001` restart** (already live — verified `findings_by_run` returns 4/5 for PR #900).

### 2. Disconnect = HARD DELETE (chosen "Variant 1")
`InstallationsRepository.disconnect()` now DELETEs the row (was a soft `disconnected_at` mark). Attached
`ci_runs` detach via the existing `ON DELETE SET NULL` FK; re-adding a repo is a fresh install with a
clean status (fixes the "Failed 7h ago on a just-added repo" bug).
- `server/.../ci/repository/installations.repo.ts` (+ `ci-installations-repository.test.ts`)

### 3. CI Runs: PR link → the PR, + CI deployment tab full-width
- `RunRow.tsx`: `#num` now links to `…/pull/{n}` (`githubPrUrl`), not the Actions run. Added `ci.runs.viewPr`.
- `CITab/styles.ts`: `wrap` `maxWidth:760` → `width:100%`.

### 4. Clear CI run history (trash button) + it STICKS
- `DELETE /ci/runs` (`ci/routes.ts` → `ingest-service.clearRuns` → `runs.repo.deleteAllForWorkspace`).
- Trash button next to Refresh (`CiRunsView.tsx`), confirm dialog reworded (permanent delete).
- **Clear now sticks:** records `ci_runs_cleared_at` marker; `checkForNewResults` SKIPS GitHub runs
  created before it, so Refresh doesn't repopulate cleared history. Runs created after the clear still ingest.
- `runs.repo.ts` (get/setClearedAt via a shared private helper), `ingest-service.ts`, `hooks/ci.ts`
  (`useClearCiRuns`; `useCiCheck` now also invalidates `ci-surface`), `ci.json` (+ ci-ingest-service tests).

### 5. "Where agents disagree" always visible
`DisagreementSection` renders its header for ANY agent count; below 2 done agents it shows a
"Run at least 2 agents…" hint instead of vanishing. (`multi-agent-review.json` → `needsTwoAgents`; + tests)

### 6. Consolidated, interactive "Findings" section at the bottom (NEW component)
`FindingsSummary` (untracked): groups every done agent's findings, each rendered as the same expandable
`FindingCard` used by Tabs (collapse-by-default; Accept/Dismiss wired to `useFindingAction`). Always shown.
- `client/.../MultiAgentResultsView/_components/FindingsSummary/{FindingsSummary,FindingsSummary.test}.tsx`
- wired in `MultiAgentResultsView.tsx`; `multi-agent-review.json` → `findingsSummaryTitle/Empty/Count`.

### 7. Generated CI workflow now declares token permissions
`workflow.ts` adds `permissions: { contents: read, pull-requests: write }`. Root cause of the LAST CI
failure: default read-only `GITHUB_TOKEN` → `403 Resource not accessible by integration` when posting the
PR comment. **Verified live**: the export now generates the permissions block; a fresh export → PR check
passes (user confirmed "Security Reviewer — Approved ✅"). (+ ci-workflow.test)

### 8. Export Wizard Install step — removed the `OPENROUTER_API_KEY` reminder
`InstallStep.tsx`: dropped the secret-reminder line (both pre- and post-install), matching the reference.
The reminder still lives in the generated PR body.

**One-off DB op (not committed, not code):** deleted 8 fabricated demo `ci_runs` rows (fake
`/actions/runs/<pr#>` URLs that 404'd). Real runs remain.

`server/insights.md` also has a new entry (the `a529535` cross-consumer regression).

---

## Environment facts learned (for the next session)
- Target repo `felkost/Python_REST_APIs_Docker_MongoDB_AWS_DevOps`: Security Reviewer installed; export
  PRs went `#5–#10`; **PR #10 passed** after the permissions fix + secret. `OPENROUTER_API_KEY` IS set there.
- CI deployment tab showing `—` = stale client cache; server returns `no_findings` (a SUCCESS). Reload fixes it.
- Dev is no-auth (default workspace); `curl http://localhost:3001/...` works without headers for quick checks.
- LLM = `openrouter/deepseek/deepseek-v3.1-terminus` — inconsistent (same PR yields findings on one run,
  0 on another). The Zod `verdict/score .optional()` SDK warning is a DELIBERATE tradeoff — do NOT "fix"
  with `.nullable()` (regresses haiku; see `findings.ts:66-95`).

## PENDING DECISION — multiple agents per repo
User asked for it; runner enforces exactly ONE manifest, so it's a real feature. Plan written:
**`docs/plans/2026-07-11-multi-agent-per-repo-ci.md`** (runner loop + re-bundle, `CiResultArtifact` bundle
contract, 2 migrations, export-guard relax, client). Scope = LARGE. User chose **"write spec/plan first"**;
next step is (a) run `spec-creator` on that draft, or (b) refine the plan, or (c) defer.

## NEXT STEPS
1. **User commits** the uncommitted work (suggested split below) — agent never commits.
2. Confirm `:3001` restart picked up all server changes (findings_by_run ✅, permissions ✅, clear marker ✅,
   hard-delete ✅ — all verified live).
3. Decide the multi-agent-per-repo path (spec-creator / refine / defer).

### Suggested commit split
- `fix(multi-agent): findings_by_run on composed run; drop usePrReviews on results page`
- `feat(multi-agent): always-visible disagreement header + consolidated interactive Findings section`
- `fix(ci): disconnect = hard delete (clean status on re-add)`
- `feat(ci): clear-run-history trash button that sticks (ci_runs_cleared_at marker)`
- `fix(ci): workflow declares pull-requests:write; PR link→PR; full-width CI tab; Install without key reminder`
