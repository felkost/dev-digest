# Multi-Agent Review — /implement progress checkpoint

> Live checkpoint. If a session is interrupted, open this file in a fresh session and
> resume from "NEXT STEP" below. Dialogue Ukrainian, artifacts English. Never commit
> yourself — the user commits. Never start/restart the user's `:3001`/`:3000`/`:5432`.

**Plan:** `docs/plans/2026-07-09-multi-agent-review.md` (8 steps, multi-agent, cap 3/wave, waves 3-3-2)
**Worktree:** `F:/Data/Neoversity_ai/devdigest-review`, branch `feat/multi-agent-review`
**Main repo (do not confuse with the worktree):** `F:/Data/Neoversity_ai/dev-digest`, branch
`feat/lesson_07` — all uncommitted work described here lives ONLY in the `devdigest-review`
worktree checkout. `db:migrate`/`db:seed`/dev-server commands must run from
`F:/Data/Neoversity_ai/devdigest-review`, never from `dev-digest`.
**Sibling worktree (do not touch):** `../devdigest-ci` — runs its OWN isolated stack (Postgres
container `devdigest-postgres-ci` on 5442, API :3011, Web :3010). This worktree's default ports
(3000/3001/5432) are unaffected and currently free.

## Status: `/implement` pipeline 100% COMPLETE. Post-implement UI polish also done. Nothing committed.

### `/implement` pipeline (all 8 phases done)

- Phase 0-2 (intake, implementation, local gate): 8 steps, 3 waves (3-3-2), all green.
- Phase 3 (completeness gate): 2 gaps found (AC-17, AC-33 — frozen `observability.ts` missing
  `error`/`tokens_*` fields) → fixed via additive contract extension (user-approved) → re-verify
  44/44 AC ✅.
- Phase 4 (architecture review ∥ test coverage): PASS, 2 Low findings (pre-work duplication in
  `run-executor.ts`; raw `Error` in `multi-run.repo.ts`) + 5 new tests added by test-writer.
- Phase 5 (architecture fix): both Low findings fixed (extracted `prepareRunContext` helper;
  `row!.id` idiom matching sibling) → re-review PASS, 0/0/0/0.
- Phase 6 (code-review, xhigh, 10 finder angles + verify + sweep): **15 findings** (10
  correctness [9 CONFIRMED + 1 PLAUSIBLE], 5 cleanup/efficiency). User approved fixing all 10
  correctness bugs; one (`agent_runs.multi_agent_run_id` FK) contradicted the plan's literal
  `cascade` spec — user chose **`SET NULL`** (matches sibling `agent_runs.prId`, fixes a real
  data-loss path on `DELETE /repos/:id`). Fixed via 3 parallel implementers:
  1. FK `cascade`→`set null` (schema + migration 0024 SQL + snapshot — still unapplied, safe to edit)
  2. `computeTotalDurationMs` undercounted wall-clock when agent count > concurrency cap(3) →
     fixed via worker-pool makespan simulation, regression test added
  3. `MultiAgentPicker.tsx`: `onRunStart` now fires only on success; visible error row on `start.isError`
  4. `noHistory` check aligned to `AgentRow.tsx`'s correct `sample_size===0` rule
  5. Persistent merged-PR warning row restored in-panel; `PRRow.tsx` now wires `warnMerged`
  6. Trigger button shows `loading={start.isPending}`; outside-click guarded during pending
  7. `router.push`/callbacks after `mutateAsync` guarded by an unmount ref
  8. `useStartMultiAgentRun` gained `onSuccess` cache invalidation (3 keys)
  9. `MultiAgentResultsView.tsx` settle-effect also refetches `usePrReviews` (Tabs-view stale-findings fix)
  10. `multi-run.repo.ts` non-deterministic ordering (PLAUSIBLE, rare) — reported, not fixed
  5 cleanup/efficiency findings reported only, not fixed (per skill: report-only category):
  Dropdown.tsx reuse gap, `runWithConcurrencyCap` 3rd duplicate (touches out-of-plan `eval/`/
  `skills/` — deferred), format-helper duplication (later resolved organically, see below),
  `getComposedRun` N+1 (moderate, polled every 4s), `estimatesForPr` N+1 (minor).
- Phase 7 (final plan-verifier): found+fixed AC-33 tokens-nullability gap (same `costUsd`
  pattern never generalized to sibling `tokensIn`/`tokensOut` fields) → **8/8 Steps ✅, 44/44
  AC ✅, 9/9 Testing Plan rows ✅**, zero regressions.
- Phase 8 (closeout): engineering-insights Mode B run — 3 new entries added (server: cascade→
  SET NULL decision; client: dropped merge-warning during component swap, dual-cache
  Columns/Tabs desync). Final report delivered to user.

**Test state after Phase 8:** server hermetic 726/734 (8 pre-existing, unrelated Windows-only
failures in `indexer-pipeline.test.ts`/`conventions-extractor.test.ts` — NOT this feature);
integration `multi-run.it.test.ts` 7/7 (Docker/Testcontainers, ephemeral DB, confirmed NOT the
dev DB); client 327/327.

### Post-implement UI polish (4 rounds, user-driven from screenshot comparisons — outside the formal `/implement` pipeline, same session)

1. **Sidebar section fix** — `client/src/vendor/ui/nav.ts`: the `multi-agent` nav item was
   placed under `WORKSPACE` (wrong — its own code comment already admitted "not repo-scoped,
   unlike its siblings"). Design reference (`DevDigest Design standalone.html`, checked via a
   temporary isolated static-file preview, since cleaned up) consistently shows it under a
   `GLOBAL` section. Added a `GLOBAL` group to `NAV`, moved `multi-agent` there. Did NOT invent
   `Memory`/`Agent Performance`/`CI Runs` items — those are design-only placeholders with no
   real routes in this codebase yet.
2. **Results-page header layout fix** — `MultiAgentResultsView.tsx`: `Configure run` was
   right-aligned (looked shell-level, disconnected); `Columns`/`Tabs` toggle was a separate row
   below the stats row. Fixed to match the design reference: one row =
   `[⚙ Configure run] [PR title · agent count] ... [Columns | Tabs]`, stats row unchanged below it.
3. **Reviewer-card redesign** — `ColumnsView.tsx` + `TabsView.tsx`, matching the design
   reference's persona-colored cards:
   - New shared `client/src/app/multi-agent-review/persona.ts` — name-keyword heuristic mapping
     agent name → icon + color (Security→Shield/red, Performance→Zap/amber, Architecture→
     Layers/blue, Mentor/Junior→Lightbulb/blue, Customer→Users/purple, else→Cpu/muted fallback).
     Not a real backend field — frozen `AgentColumn` contract has none; purely client heuristic.
   - `ColumnsView.tsx`: top color-strip border, persona icon in a colored box, findings now
     rendered as colored-left-border boxes (was a plain icon+text list), footer row merges
     `View trace` + `N findings`. **Kept** the explicit status text row ("Done"/"Running"/
     "Failed") for ALL statuses — AC-16 + an existing test require it visible even for `done`,
     despite the design screenshot not showing it explicitly.
   - `TabsView.tsx`: active tab's summary panel is now a bordered card with a persona-colored
     left border and the agent name as a colored heading; `View trace` + duration/cost grouped
     top-right. Findings themselves untouched (already reuse the shared `FindingCard`, which
     already matches the reference's look).
   - `client/src/vendor/ui/kit/Tabs.tsx` + `types.ts`: `TabDef` gained an **optional** `color`
     field (backward-compatible — 9 other consumers unaffected, confirmed via full suite).

4. **DisagreementSection redesign** — `DisagreementSection.tsx`, matching a new pair of
   reference screenshots (current vs. correct) for the "Where agents disagree" panel:
   - Header icon `Users` → `Activity` (pulse icon) in the `SectionLabel`.
   - Each conflict card restructured from a single-column vertical stack of reviewer rows
     into a header strip (`Icon.Code` + mono `file:line` + title, bottom-bordered) above a
     CSS grid with one equal-width column per `take` (`gridTemplateColumns: repeat(N, 1fr)`,
     `1px solid var(--border)` dividers between columns) — dynamic on `takes.length`, not
     hardcoded to 3.
   - Verdict indicator per column rebuilt as a bespoke colored dot (6px circle) + bold
     uppercase label using `SEV[...].c`/`.label` directly (dropped `SeverityBadge`, whose
     compact mode is icon-only and whose default mode adds an unwanted colored-pill
     background not present in the reference) — muted gray dot + lowercase text for the
     "ignored" case.
   - `didNotFlag` copy lowercased ("Did not flag" → "did not flag") to match the reference
     and to align with the sibling key already lowercase in `runs.json`; test assertion
     updated to match.
   - **Stitch MCP used per user instruction**: created project `DevDigest — Where Agents
     Disagree` (`projects/15254361319469345022`) + a dark design system `DevDigest Dark`
     (`assets/8797456270598779791`, DARK/Inter+JetBrains Mono/ROUND_EIGHT, seeded with
     DevDigest's real token hex values and a `designMd` brief describing the multi-column
     comparison-grid pattern) via `create_project` + `create_design_system` +
     `update_design_system`. `generate_screen_from_text` was called once with a detailed
     prompt of the target screenshot but never returned a screen after ~10 polls of
     `list_screens`/`get_project` over ~6 min (per the tool's own "don't retry" guidance) —
     screen generation itself did not complete server-side. Implementation proceeded from
     the design-system token response plus direct screenshot reading, not from a rendered
     Stitch screen. No new/renamed CSS variables were introduced — colors stayed on
     DevDigest's existing `--crit`/`--warn`/`--sugg`/`--text-muted`/`--border` tokens.

**Test state after UI polish:** client typecheck clean, `ColumnsView` 6/6, `TabsView` 9/9,
`DisagreementSection` 4/4, full client suite **327/327** (re-run 4 times across the 4 rounds,
always 327/327, 0 failures). Server untouched by this polish work (no server-side changes).

## NEXT STEP

**Nothing is blocking.** All planned work + all user-requested UI fixes are done and verified
green. Remaining items are entirely up to the user:

1. **Commit.** Nothing has been committed all session (per explicit instruction — user commits).
   52 changed/new files (see `git status --porcelain` for the exact list — spans shared
   contracts ×2 mirrors, migration 0024, 4 new server modules + 6 new server test files, seed
   data, 8 new/changed client files under `multi-agent-review`, the picker component, nav.ts,
   Tabs.tsx, and the new `persona.ts`). Suggest splitting into logical commits (e.g. one per
   plan step + one for the post-implement UI polish) or one squashed commit — user's call.
2. **Flip spec status** — `docs/feature-requirements/2026-07-09-multi-agent-review.md`'s
   `status: approved` → `implemented`, via spec-creator (not `/implement`, not this session).
3. **Deferred runtime checkpoints** (user runs manually, from `devdigest-review`, never `dev-digest`):
   - `cd server && pnpm db:migrate` — applies migration `0024` (now `SET NULL`, not `cascade`)
   - `cd server && pnpm db:seed` — after migrate; seeds 3 new personas + 1 demo multi-agent run
     with a genuine disagreement (both already run successfully once this session via
     `./scripts/dev.sh` — idempotent, safe to re-run)
   - If `:3001` is running from this worktree, it needs a **restart** to pick up TWO rounds of
     shared-contract changes (`agentIds`/`MultiAgentRunStartResponse`/`AgentEstimate`, then
     `AgentColumn.error`/`tokens_*`/`MultiAgentRun.total_tokens_*`) — tsx-watch does not reload
     path-aliased `vendor/shared` contracts.
4. **Optional, not blocking:** the 4 remaining reported-only cleanup findings from Phase 6 code-
   review (`runWithConcurrencyCap` triplicated across `reviews/`/`eval/`/`skills/`;
   `getComposedRun`'s N+1 `getById` loop, polled every 4s — the most worth revisiting if picked;
   `estimatesForPr`'s N+1, minor; `multi-run.repo.ts`'s missing secondary sort key, PLAUSIBLE/rare).

## All changes remain UNCOMMITTED (52 files)

Run `git status --porcelain` in `devdigest-review` for the exact current list — matches the
summary above. No `git add`/`git commit` has been run at any point this session.
