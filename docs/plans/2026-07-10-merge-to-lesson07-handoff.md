# Multi-Agent Review → `feat/lesson_07` merge handoff

> Handoff for a FRESH session. Goal: commit + push the finished Multi-Agent Review
> feature, then merge it into `feat/lesson_07` without breaking existing functionality.
> Dialogue Ukrainian, artifacts English. This session MAY commit/push (that is the task).

## 0. Worktree setup to recover (how we got here)

The `devdigest-review` worktree was created earlier from the main repo with:

```sh
# run once, from F:/Data/Neoversity_ai/dev-digest (feat/lesson_07 @ 680026d):
git worktree add ../devdigest-review -b feat/multi-agent-review
```

Three sibling worktrees share ONE `.git` (same repo, different branches):

| Path | Branch | Role |
| --- | --- | --- |
| `F:/Data/Neoversity_ai/dev-digest` | `feat/lesson_07` @ `680026d` | base lesson branch = the MERGE TARGET |
| `F:/Data/Neoversity_ai/devdigest-review` | `feat/multi-agent-review` | **Feature A — THIS worktree** |
| `F:/Data/Neoversity_ai/devdigest-ci` | `feat/export-to-ci` | Feature B (Export to CI), merges into lesson_07 separately |

Branch topology (verified 2026-07-10):
- `feat/multi-agent-review` = `680026d` (branch point, == `feat/lesson_07` tip) + `d8b2e50` (spec/plan docs only) + **all feature code UNCOMMITTED in the working tree**.
- `origin/feat/multi-agent-review` already exists (pushed at `d8b2e50`); a normal `git push` will update it.
- `merge-base(feat/multi-agent-review, feat/lesson_07)` = `680026d` = current `feat/lesson_07` tip.

**Rules (still in force):** run build/test/migrate/seed commands ONLY from `devdigest-review`, never from `dev-digest` (that is a different worktree/branch). Runtime isolation: never commit hardcoded `3010/3011/5442/devdigest_ci/devdigest_review` — the merged feature must run on defaults `3000/3001/5432`. Do NOT start/restart the user's `:3001`/`:3000`.

## 1. What is uncommitted (the whole feature — 54 entries)

All implemented + verified green this session: server hermetic 726/734 (8 pre-existing unrelated Windows-only failures), client **328/328**, integration `multi-run.it.test.ts` 7/7. Full live checkpoint: [docs/plans/2026-07-09-multi-agent-review-implement-progress.md](2026-07-09-multi-agent-review-implement-progress.md).

Categories (run `git status --porcelain` for the exact current list):
- **New client app**: `client/src/app/multi-agent-review/**`, `client/src/components/multi-agent-picker/**`, `client/src/lib/hooks/multi-agent-review.ts(.test.ts)`, `client/messages/en/multi-agent-review.json`.
- **New server module**: `server/src/modules/reviews/multi-run.{routes,service}.ts`, `repository/multi-run.repo.ts`, `conflict-matcher.ts`, `server/test/multi-run-*.test.ts` + `conflict-matcher.test.ts` + `seed-disagreement.test.ts` + `multi-run.it.test.ts`.
- **New migration**: `server/src/db/migrations/0024_multi_agent_run_linkage.sql` + `meta/0024_snapshot.json` (+ `meta/_journal.json` gains idx 24). Migration is `SET NULL` on `agent_runs.multi_agent_run_id` (code-review decision, matches sibling `agent_runs.prId`). **Not yet applied** — safe to edit until `db:migrate`.
- **Modified shared contracts (×2 mirrors — keep both in sync)**: `{client,server}/src/vendor/shared/contracts/observability.ts` (adds `AgentColumn.error`/`tokens_*`, `MultiAgentRun.total_tokens_*`), `.../platform.ts`.
- **Modified server wiring**: `modules/index.ts` (registers multi-run routes), `reviews/{constants,repository,service,run-executor}.ts`, `repository/run.repo.ts`, `schema/runs.ts`, `seed.ts`, `seed-prompts.ts`, `docs/run-executor.md`.
- **Modified client**: `FindingCard.tsx(.test.tsx)`, `PrDetailHeader.tsx`, `pulls/[number]/page.tsx`, `PRRow.tsx`, `lib/hooks/reviews.ts`, `vendor/ui/nav.ts` (GLOBAL section + multi-agent item), `vendor/ui/kit/Tabs.tsx` + `types.ts` (optional `TabDef.color`), `messages/en/{prReview,shell}.json`.
- **Deletions (old component replaced by the picker)**: `client/src/app/repos/[repoId]/pulls/[number]/_components/RunReviewDropdown/**` and `client/src/components/run-review-dropdown/**`.
- **Docs / insights**: `docs/plans/2026-07-09-multi-agent-review-implement-progress.md`, `client/insights.md`, `server/insights.md`.

## 2. TASK — commit + push to `feat/multi-agent-review`

### 2a. Pre-commit hygiene (do first)
- `git status --porcelain` and eyeball every path.
- **`reviewer-core/pnpm-lock.yaml` (untracked) is almost certainly a stray** from a `pnpm install`, NOT part of this feature — confirm with the user, default to EXCLUDING it (do not `git add` it).
- Grep the staged diff for runtime-isolation leaks — must return nothing:
  ```sh
  git diff --cached | grep -nE "3010|3011|5442|devdigest_ci|devdigest_review" || echo "clean"
  ```
- Confirm no secrets / `.env.local` / temp docker overrides are staged.
- Re-run gates from `devdigest-review` to confirm still-green before committing:
  ```sh
  cd client && pnpm typecheck && pnpm test
  cd ../server && pnpm typecheck && pnpm exec vitest run --exclude '**/*.it.test.ts'
  ```

### 2b. Commit
Squash into one commit (or split plan-step + UI-polish if the user prefers). Suggested single-commit message:

```
feat(L07): Multi-Agent Review — parallel per-agent review + disagreement view

Fan out a PR review over multiple selected agents concurrently (Promise.allSettled,
cap 3), persist each as an agent_run linked to a new multi_agent_runs group, and
compose a results page: per-agent Columns/Tabs views, a "Where agents disagree"
comparison grid, run-wide + per-agent duration/cost/token totals, and the reused
RunTraceDrawer. Replaces the single-agent RunReviewDropdown with MultiAgentPicker.

- server: reviews/multi-run.{routes,service}, conflict-matcher, multi-run.repo;
  migration 0024 (agent_runs.multi_agent_run_id FK, SET NULL); seed personas +
  demo disagreement run on PR #482; additive observability/platform contract fields
- client: /multi-agent-review app, multi-agent-picker, header + FindingCard footer
  slot, nav GLOBAL section, TabDef.color
- 328/328 client, server hermetic green, multi-run.it.test.ts 7/7

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

Branch first only if somehow not on `feat/multi-agent-review` (you should be). Then:
```sh
git add -A            # after excluding the stray lockfile if confirmed
git commit -F <msg>
git push              # origin/feat/multi-agent-review already tracks
```

## 3. TASK — prepare + perform the merge into `feat/lesson_07`

### 3a. Reality check first
`feat/lesson_07` is currently AT the branch point (`680026d`). **If it has not advanced, merging Feature A into it is CONFLICT-FREE** (fast-forward-like). Verify before assuming conflicts:
```sh
git fetch origin
git log --oneline -5 origin/feat/lesson_07
git log --oneline feat/lesson_07..feat/multi-agent-review   # what A adds
git log --oneline feat/multi-agent-review..feat/lesson_07   # what lesson_07 has that A lacks (empty ⇒ clean)
```
Conflicts appear ONLY if `feat/lesson_07` has moved on — in practice, if **Feature B (`feat/export-to-ci`) was merged into it first**, or an upstream (`upstream/emdash/multi-agents-review-v1x`) was merged.

### 3b. Where to run the merge (checkout constraint)
`feat/lesson_07` is checked out in the `dev-digest` worktree; git will NOT let you check the same branch out twice. Recommended clean path — a throwaway integration worktree, so neither `dev-digest` nor `devdigest-review` is disturbed until the end:
```sh
git worktree add ../devdigest-merge -b integration/lesson07+mar feat/lesson_07
cd ../devdigest-merge
git merge feat/multi-agent-review
# …resolve, install, migrate, test (see 3d)…
# then fast-forward the real branch and clean up:
#   (from dev-digest)  git checkout feat/lesson_07 && git merge --ff-only integration/lesson07+mar
#   git worktree remove ../devdigest-merge
```
Confirm this mechanic with the user before creating worktrees; they may prefer to run the merge directly in `dev-digest`.

### 3c. Known conflict hotspots (only when `feat/lesson_07` already contains Feature B) — resolution = KEEP BOTH (additive)
- `server/src/modules/index.ts` — A registers multi-run routes, B registers the `ci` module. **Register BOTH.**
- `server/src/db/migrations/meta/_journal.json` — A adds idx 24, B adds idx 23. A's working tree currently jumps 22→24 (23 reserved for B). **Keep all three entries ordered 22, 23, 24.** Ensure both `0023_*` (B) and `0024_*` (A) `.sql` + `meta/*_snapshot.json` files are present; they touch independent tables so apply-order between them is irrelevant.
- `client/src/vendor/ui/nav.ts` — A adds a GLOBAL section + `multi-agent` item; B adds a CI Runs item. **Keep both.**
- `server/src/db/seed.ts` / `seed-prompts.ts` — A adds personas + a demo multi-run; B may add CI seed rows. **Keep both, preserve idempotency guards.**
- Shared contracts: A edits `observability.ts` + `platform.ts` (×2 mirrors); B edits `eval-ci.ts` (+ maybe `platform.ts`). Overlap is likely only on `platform.ts` — **merge both field sets, keep client/server mirrors byte-identical.**
- `client/src/vendor/ui/kit/Tabs.tsx` + `types.ts` — A's `TabDef.color` is additive/optional; if B also touched Tabs, keep both changes.

### 3d. Deletion + verification safety
- A DELETES `RunReviewDropdown` (both copies). After merging, grep the whole tree for dangling references — must be empty:
  ```sh
  grep -rn "RunReviewDropdown\|run-review-dropdown" client/src || echo "no dangling refs"
  ```
- Post-merge verification gate (run from the integration worktree, NOT dev-digest's live runtime):
  ```sh
  # install any packages the merge introduced (B adds yaml/jszip to server; agent-runner)
  pnpm -C server install && pnpm -C client install
  cd server && pnpm typecheck && pnpm db:migrate   # applies 0023 (B) + 0024 (A)
  pnpm exec vitest run --exclude '**/*.it.test.ts'
  pnpm db:seed                                       # idempotent; seeds both features' demo data
  cd ../client && pnpm typecheck && pnpm test
  ```
  "Don't break old functionality" is proven by the FULL pre-existing suites of both packages passing, not just the new tests.

### 3e. Ordering recommendation
Merging **A first (clean, conflict-free today), then B** pushes all the "keep both" conflict resolution onto B's merge instead of A's. Merging **B first, then A** puts it on A. Either works; do the conflict-free one first and let the second merge own the reconciliation. Surface this choice to the user.

## Definition of done
1. `feat/multi-agent-review` committed + pushed (stray lockfile excluded, no leaks/secrets).
2. Merge into `feat/lesson_07` completed with conflicts resolved additively (old L01–L07 + Export-to-CI + Multi-Agent Review all intact).
3. Post-merge: both typechecks clean, both full suites green, `db:migrate` applies 0023+0024, `db:seed` idempotent, no dangling `RunReviewDropdown` refs.
4. Spec status flip (separate, optional): `docs/feature-requirements/2026-07-09-multi-agent-review.md` `approved` → `implemented`.
