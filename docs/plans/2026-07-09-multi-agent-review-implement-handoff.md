# Session handoff — Multi-Agent Review (Feature A): PLANNING done (verified) → IMPLEMENT next (2026-07-09)

> Open this in the next session to run the **IMPLEMENT** stage via `/implement`.
> Dialogue Ukrainian, artifacts English. Never commit yourself (user commits).
> Never restart the user's `:3001`/`:3000`. Worktree `F:/Data/Neoversity_ai/devdigest-review`,
> branch `feat/multi-agent-review`. Parallel sibling worktree `../devdigest-ci`
> (Feature B) — do NOT touch it.

---

## Pipeline position

`spec ✅ → researcher ✅ → arch-review ✅ → plan ✅ → plan-verify ✅ (READY) → **implement ⬅ NEXT** → test → verify`

## Artifacts (all re-readable from disk — a cold session resumes from these)

| Doc | Path |
|---|---|
| Spec (approved, 44 ACs) | `docs/feature-requirements/2026-07-09-multi-agent-review.md` |
| Arch review (13 constraints) | `docs/plans/2026-07-09-multi-agent-review-arch-review.md` |
| **Development Plan (verified)** | `docs/plans/2026-07-09-multi-agent-review.md` |
| Spec-stage handoff | `docs/plans/2026-07-09-multi-agent-review-spec-handoff.md` |
| This handoff | `docs/plans/2026-07-09-multi-agent-review-implement-handoff.md` |

**Plan-verify verdict: READY.** Grounding solid (no stale citations), waves disjoint,
cap-3 conflict-free, migration `0024`, all 13 arch constraints + Runtime-Isolation +
code-quality principle present. Three small gaps were found AND already fixed in the
plan: (1) server-side estimate test coverage added (`multi-run-service.test.ts` +
`multi-run.it.test.ts`); (2) Step 5 deps now list Step 3; (3) Constraint 4 reconciled
(`Promise.all` over try/catch-no-rethrow `runJob`s satisfies "allSettled semantics").

## Execution mode (user-decided — enforce)

- **Multi-agent, HARD CAP = 3 parallel `implementer` instances per wave** (one per plan
  Step in the wave) + the `/implement` built-in **architecture-reviewer + code-review**
  gates (the "Architect + Reviewer" roles) → ≤5 agents total.
- **Model split (user decision 2026-07-09):** the ≤3 `implementer` agents run on **Sonnet**
  (`claude-sonnet-5`) — the plan is prescriptive enough that execution doesn't need Opus;
  the final **Architect + Reviewer gates run on Opus** (`claude-opus-4-8`) for defect-catching
  and enforcing the no-load-bearing-workaround principle.
- Wave layout **3-3-2** (steps are disjoint in owned paths per wave — verified):
  - **Wave 1:** Step 1 shared contracts (`platform.ts` ×2 mirrors) · Step 2 migration `0024` + `multi-run.repo` · Step 3 `conflict-matcher.ts`
  - **Wave 2:** Step 4 concurrency + multi-run service/routes + estimates · Step 5 seed 3 personas · Step 6 client hooks
  - **Wave 3:** Step 7 picker (deletes `RunReviewDropdown`) · Step 8 Multi-Agent Review page
  - Wave 3 client steps compile against Step 1 contracts + Step 6 hooks only (not Wave-2 server source) — parallelization is intentional, per the plan's map.

## Non-negotiable rules the IMPLEMENT session must honor

- **Runtime Isolation & Merge Compatibility** (plan §5, memory `worktree-runtime-isolation`):
  NO hardcoded worktree ports/db/project-name/URLs in committed code/tests/shared-config/docs;
  env-driven with SAFE DEFAULTS **3000/3001/5432**; local runtime profile lives in untracked
  env only. **Pre-finalize:** `git diff --name-only` then grep changed tracked files for
  `3010|3011|5442|devdigest_ci|devdigest_review` and strip any leak.
- **Code-quality principle** (plan §4, memory `engineering-principle-fix-the-process`):
  no load-bearing workarounds (a workaround needing a paragraph of justification = wrong code);
  when something breaks, fix the process/root cause, not the symptom. The Architect/Reviewer
  gates enforce this.
- **Servers:** before starting anything, check 3000/3001/5432 occupancy → STOP + report on
  conflict; never restart the user's servers; if isolation is unclear, STOP before servers/e2e.
- **Shared contract change:** `agentIds[]` touches BOTH `server/` and `client/`
  `vendor/shared/contracts/platform.ts` mirrors identically → warn the user to **restart :3001**
  after (tsx-watch won't reload the path-aliased contract).
- **Boundaries:** do NOT touch `ci/`, `agent-runner/`, or the Compose Review drawer.
- **Tests:** hermetic first (`pnpm typecheck` → unit), then `*.it.test.ts` (needs Docker).
  The AC-44 wall-clock test (multi-agent ≈ slowest agent) + the server estimate tests are named
  in the plan §8.

## NEXT SESSION — kickoff for the IMPLEMENT stage

Run `/implement` on `docs/plans/2026-07-09-multi-agent-review.md` with:
- Cap: **≤3 parallel implementers per wave** (one per Step), + built-in Architect + Reviewer gates.
- Honor the two memories above + plan §4/§5.
- Report at sign-off (plan's final-report format): summary · files changed · tests + results ·
  runtime resources (ports/db/docker project) · confirm NO hardcoded worktree values ·
  confirm default-runtime compatibility (3000/3001/5432) · known risks · confirm no other
  worktree was used/modified.
- Deliverables land uncommitted for the user to commit.

## Runtime cue points — the session MUST prompt the user just-in-time (with exact commands)

The user runs all servers/DB manually; never start or restart them yourself. At each
point below, tell the user explicitly THAT it's needed + WHY + the exact command +
the port pre-check + what success looks like.

- **Implement + hermetic unit tests:** NO user action, no dev stack — agents self-run
  typecheck + mocked unit tests.
- **Before integration tests (`*.it.test.ts`):** ask the user to ensure **Docker Desktop
  is running** — testcontainers spins its OWN ephemeral Postgres (random port); do NOT
  `docker up` the dev Postgres for these. The dev API/client/Postgres are NOT needed.
- **Verify stage (live 3-agent demo):** give the user copy-paste steps — first a port
  pre-check of 3000/3001/5432 (STOP + report if held by the `devdigest-ci` worktree), then
  `./scripts/dev.sh` (Docker Postgres → `db:migrate` → `db:seed` → API :3001 + client :3000),
  or `./scripts/dev.sh --db-only` to just prep the DB. NOTE the committed `docker-compose.yml`
  is hardcoded (`devdigest-postgres` / 5432 / db `devdigest`, single container) — there is one
  shared Postgres; simplest is ONE live stack at a time (bring the other worktree's servers down).
- **After the `agentIds[]` shared-contract change lands:** if the user already has :3001 up,
  tell them to restart it (tsx-watch won't reload the path-aliased contract).

## Commit — PLANNING block (docs only; user runs this)

Files (all docs, no code): `docs/feature-requirements/2026-07-09-multi-agent-review.md`,
`docs/feature-requirements/README.md`, `docs/plans/2026-07-09-multi-agent-review-arch-review.md`,
`docs/plans/2026-07-09-multi-agent-review-spec-handoff.md`,
`docs/plans/2026-07-09-multi-agent-review.md`,
`docs/plans/2026-07-09-multi-agent-review-implement-handoff.md`.

```
docs(plan): add Multi-Agent Review spec, arch review, and verified plan (SPEC-2026-07-09)

Feature A of the Lesson 07 parallel-implementation demo. Full planning block:
- Spec (approved, 44 ACs) + feature-requirements index row
- Pre-plan architecture review (13 constraints, 2 placement decisions)
- Development Plan (verified READY): 3-3-2 waves, cap 3 parallel implementers,
  migration 0024, net-new conflict-matcher, multi-agent concurrency (AC-44),
  Runtime Isolation & Merge Compatibility section, and a code-quality principle
- Spec-stage and implement-stage handoffs

No application code yet — implement stage runs next via /implement.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

The IMPLEMENT stage should be opened in a **fresh session** — it needs only the plan +
this handoff (both on disk) and the two linked memories.
