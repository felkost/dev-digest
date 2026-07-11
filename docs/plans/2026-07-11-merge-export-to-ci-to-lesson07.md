# Merge handoff — feat/export-to-ci → feat/lesson_07 (2026-07-11)

> Dialogue in **Ukrainian**; code/commits stay **English**. The user commits — never commit yourself
> unless asked. Runtime isolation is mandatory — never assume `:3001`/`:3000`/`5432` is any given
> worktree's.

## 1. Current state (verified 2026-07-11)

| Branch | HEAD | What it has |
|---|---|---|
| `feat/export-to-ci` (worktree `F:\Data\Neoversity_ai\devdigest-ci`) | `1e95ebe` "feat(L07): Export to CI" (72 files) | **Feature B fully committed** — Export-to-CI + the CI-UI rework (CI-deployment tab, wizard redesign, CI Runs page) + `pr_title`/`latest_run_at` contract additions + migrations `0023_bitter_changeling` + `0025_ci_run_pr_title` |
| `feat/lesson_07` | `a529535` "fix(reviews): exclude multi-agent fan-out runs…" | **Feature A (multi-agent-review) ALREADY merged in** — incl. migration `0024_multi_agent_run_linkage` |
| `feat/multi-agent-review` | — | Feature A source branch (already merged to lesson_07) |

- **Merge-base** of export-to-ci ↔ lesson_07 = `680026d` (the shared branch point; migrations 0000–0022).
- **3 uncommitted files** in `devdigest-ci` right now (see §2) — commit the code ones BEFORE merging.
- The merge to do: **`feat/export-to-ci` → `feat/lesson_07`** (Feature A is already there, so B is the second merge → B resolves all the conflicts).

## 2. PRE-MERGE — do this in the `feat/export-to-ci` worktree first

1. **Commit the 2 code fixes** (tail of the last session, needed so the merge carries the fixed versions):
   - `client/src/app/agents/[id]/_components/AgentEditor/_components/CITab/CITab.test.tsx` — test fixture updated for the `latest_run_at` contract field + dropped the stale `v2` assertion (row now shows relative "Nm ago", not version).
   - `client/src/app/ci-runs/_components/CiRunsView/constants.ts` — `GRID` retuned so the PR column no longer hogs all slack (fixes the large PULL REQUEST↔AGENT gap).
   - Suggested message: `fix(ci): retune CI Runs grid + CITab test for latest_run_at`.
2. **`.claude/settings.json`** (3rd uncommitted file) — this session added generic permission-allowlist entries (`Bash(pnpm exec vitest run *)`, `docker info *`, `git merge-base *`, …) + `"defaultMode":"auto"`. These are local Claude-Code prefs, **not feature code** — prefer NOT to commit them onto the feature branch (or commit separately). No credentials/IDs in the diff (checked), so it's a hygiene choice, not a blocker.
3. **Push** `feat/export-to-ci` so the merge session can fetch it.

## 3. THE CRITICAL PART — migration reconciliation

Both features added a migration at the **same journal index (idx 24)** with the **same snapshot filename** (`meta/0024_snapshot.json`). This WILL conflict and must be reconciled by hand:

| | idx 23 | idx 24 | idx 25 |
|---|---|---|---|
| `feat/lesson_07` (A) | — (gap) | `0024_multi_agent_run_linkage` (snapshot `0024_snapshot.json` = multi-agent schema) | — |
| `feat/export-to-ci` (B) | `0023_bitter_changeling` (snapshot `0023_snapshot.json` = CI schema) | `0025_ci_run_pr_title` (snapshot `0024_snapshot.json` = CI schema) | — |

**Target end-state sequence:** `…0022(22) → 0023_bitter_changeling(23) → 0024_multi_agent_run_linkage(24) → 0025_ci_run_pr_title(25)`.

**Conflicting files at merge:** `meta/_journal.json` (both claim idx 24), `meta/0024_snapshot.json` (two different contents).

**Resolution recipe (do AFTER resolving all code conflicts, so the merged `schema/` has BOTH features' tables):**
1. Keep A's `0024_multi_agent_run_linkage` at idx 24 and its `0024_snapshot.json` as-is.
2. B's `0023_bitter_changeling` fills lesson_07's empty idx-23 slot cleanly (no conflict) — keep it + `0023_snapshot.json`.
3. **Re-sequence B's `0025_ci_run_pr_title` to idx 25**: in `_journal.json` set its entry to `"idx":25`; the `pr_title` migration's snapshot must be renamed/regenerated as `0025_snapshot.json` **chained off A's `0024_snapshot.json`** (not off `0022`).
4. **Do NOT hand-trust the snapshot chain.** After reconciling, the reliable check is a dry-run: `cd server && pnpm db:generate` on the merged schema must report **"No schema changes"** (empty diff). If it wants to emit a migration, the chain is wrong — the pragmatic fix is to delete the two features' post-0022 snapshots + journal entries and let `db:generate` rebuild the combined chain from the merged `schema/`, then re-add the two hand-written SQL bodies. (See `server/insights.md`'s 2026-07-03/07-06 entries on drizzle snapshot-chain corruption — this is exactly that failure class.)
5. Apply to a **CLEAN DB** and confirm `pnpm db:migrate` runs all three (0023→0024→0025) without error, and both feature's tables + columns exist.

## 4. Code conflict hotspots (both A and B edit these — verified)

- **`client/src/vendor/ui/nav.ts`** — A adds *Multi-Agent Review* + *Agent Performance* nav items; B adds *CI Runs*. **Both create a `GLOBAL` section.** Resolve by MERGING into ONE `GLOBAL` section containing all three (Memory / Multi-Agent Review / Agent Performance / CI Runs) — this is exactly the reference nav layout. Keep each item's `gKey` unique.
- **`server/src/modules/index.ts`** — both register a new module in the `modules` record. Keep BOTH (`ci` + A's multi-agent module).
- **`server/src/db/seed.ts`** — both add seed data. Keep both additions (they seed different tables).
- **`server/src/vendor/shared/contracts/`** — B edits `eval-ci.ts` (added `pr_title`, `latest_run_at`, plus the whole CI contract set), A edits `observability.ts` (multi-agent contracts). **Different files → no content conflict**, but check `contracts/index.ts` barrel if both added exports there.
- **`client/src/vendor/shared/contracts/`** — the client mirror of the above; same story (mirror B's `eval-ci.ts` edits, they're byte-identical to server).

## 5. NOT in the merge (DB-only / local-only)

- **Demo CI data** (the 5 `ci_runs` seeded for the CI Runs page + 3 linked runs for the CI tab + the `pr_title`/`latest_run_at` values) were **direct SQL INSERTs into the shared dev DB**, NOT in `seed.ts`. They **do not travel with the merge** — they're runtime data, not code. Only migration `0025` (the `pr_title` *column*) is code. If the merged branch needs a populated CI Runs page for a demo, re-run those inserts against its DB (or, better, add them to `seed.ts` idempotently as a follow-up).
- **`.env` / `launch.json`** — gitignored / reverted to defaults; no isolated ports (`3010`/`3011`/`5442`/`devdigest_ci`) in tracked code. Re-grep the merged tree to confirm none leaked.

## 6. Verification after merge (gate before declaring done)

1. `cd server && pnpm db:generate` → **empty diff** ("No schema changes") — proves the snapshot chain is consistent.
2. Apply migrations to a clean DB (`pnpm db:migrate`) → all succeed; spot-check `ci_runs.pr_title`, `ci_installations`, and A's `multi_agent_runs` linkage columns exist.
3. `cd server && npx tsc --noEmit` → clean. `cd client && pnpm typecheck` → clean.
4. Server hermetic (`pnpm exec vitest run --exclude '**/*.it.test.ts'`) + client (`pnpm test`) → green (mind the known pre-existing Windows-only ENOENT failures documented in `server/insights.md`).
5. Grep the merged tree for `3010|3011|5442|devdigest_ci|devdigest_review` → nothing in tracked code.

## 7. Related

Feature A's own merge handoff (already executed): `docs/plans/2026-07-10-merge-to-lesson07-handoff.md` (in the `devdigest-review` worktree). Memory: `lesson07-parallel-implementation-demo`, `worktree-runtime-isolation`.
