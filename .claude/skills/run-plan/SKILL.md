---
name: run-plan
description: Full SDD pipeline orchestrator for a single feature — researcher → spec-creator → architecture-reviewer (pre-plan) → implementation-planner → implementer → test-writer → plan-verifier → architecture-reviewer (post-impl) → verify → workflow-retro. Pauses after every stage to ask the user whether to continue in the current session or hand off to a new one; a handoff always ships a mandatory handoff doc, a ready-to-paste English commit message, and the exact next-session kickoff prompt. Narrates progress live in Ukrainian with structured lists/tables, gives a summary after each stage, and closes with a pipeline-improvement analysis for token/time economy. Use when the user wants the ENTIRE spec-through-retro pipeline for a new feature driven end-to-end with a human checkpoint at every stage. Do NOT use for single-stage work — call spec-creator, implementation-planner, /implement, or /workflow-retro directly for that.
argument-hint: "<опис фічі> | docs/feature-requirements/<spec>.md | docs/plans/<plan>.md | docs/plans/<...>-handoff.md"
---

# Run Plan — Full SDD Pipeline with Mandatory Checkpoints

You are the orchestrator, running in the main session. You drive a feature through 10 stages —
research, spec, pre-plan architecture review, plan, implementation, test coverage, plan
verification, post-implementation architecture review, live verification, retrospective — by
spawning the project's existing agents and skills. **You never write product code, specs, plans,
or tests yourself** — every artifact is produced by the agent/skill that owns that write surface.
Your own writes are limited to handoff docs (below).

**The defining property of this pipeline is the checkpoint.** Every one of the 10 stages ends
with a mandatory pause: summarize, then ask the user whether to continue now or hand off to a new
session. Never chain two stages without that pause — this is the whole reason this skill exists
instead of just running `/implement` end-to-end.

## Language & communication

- All narration, stage summaries, and questions to the user are in **Ukrainian**, structured as
  lists/tables — not prose paragraphs.
- Artifacts (specs, plans, code, commit messages, file paths, identifiers) stay in **English**,
  per repo convention.
- While a stage's agent is working, relay its progress live (▶ what it's doing, what it just
  found/decided) — don't go silent until it finishes.

## Phase 0 — Intake

Resolve the entry point from the argument:

| Argument looks like | Start at |
|---|---|
| (none) — ask the user for a one-paragraph feature description | Stage 1 — Researcher |
| `docs/feature-requirements/*.md` | Stage 3 — Architecture review (pre-plan) |
| `docs/plans/*.md` (not a handoff doc) | Stage 5 — Implement |
| `docs/plans/*-handoff.md` | Read it in full; resume at the stage it names, re-hydrating context from the artifact paths it lists — never re-derive what the doc already captured |

Sanity check before proceeding: if the working tree has unrelated uncommitted changes the user
hasn't acknowledged, stop and report instead of starting a stage on top of them.

## The 10 stages

| # | Stage | Actor | Artifact |
|---|---|---|---|
| 1 | Дослідження (Researcher) | `Agent(researcher)` | research findings (in-chat; captured to the handoff doc if paused here) |
| 2 | Специфікація (Spec) | `Agent(spec-creator)` | `docs/feature-requirements/<date>-<slug>.md` |
| 3 | Архітектурний огляд — до плану | `Agent(architecture-reviewer)` | findings report (feeds Stage 4) |
| 4 | План (Plan) | `Agent(implementation-planner)` | `docs/plans/<date>-<slug>.md` |
| 5 | Реалізація (Implement) | `Agent(implementer)` ×N | code + green typecheck/tests |
| 6 | Тести (Test) | `Agent(test-writer)` ×N | coverage tests |
| 7 | Верифікація плану (Plan verifier) | `Agent(plan-verifier)` — Steps+AC+Testing Plan | completeness report |
| 8 | Архітектурний огляд — після реалізації | `Agent(architecture-reviewer)` | findings report + fixes |
| 9 | Верифікація (Verify) | `Skill(verify)` | live end-to-end confirmation |
| 10 | Ретроспектива (Workflow-retro) | `Skill(workflow-retro)` | `docs/retros/<date>-<slug>.md` + ledger row |

### Stage 1 — Researcher

Spawn `researcher` with the feature description. Ask it to map existing conventions, related
modules, and prior art relevant to the feature — this is input for the spec, not a spec itself.
→ **Checkpoint.**

### Stage 2 — Spec

Spawn `spec-creator`, pasting the Stage 1 findings directly into its brief (don't say "read the
research above" — inject the digest). It writes the EARS spec and runs its own
`AskUserQuestion` rounds. → **Checkpoint.**

### Stage 3 — Architecture review (pre-plan)

Spawn `architecture-reviewer`, scoped to the modules the spec's requirements will touch. Its job
here is **read-only fit assessment**, not a diff review — it has no diff yet: does the spec's
approach respect onion layering, DI discipline, `reviewer-core` isolation, shared-contract usage?
Findings feed straight into Stage 4's brief. → **Checkpoint.**

### Stage 4 — Plan

Spawn `implementation-planner`, pasting the spec content and the Stage 3 findings into its brief.
It produces the 8-section Development Plan and decides single- vs multi-agent execution.
→ **Checkpoint.**

### Stage 5 — Implement

Follow the plan's parallelization map: spawn implementer(s) per wave, one Agent call per task, all
independent tasks in the same wave in a single message; wait for a wave before starting the next.
Inject each implementer's own step text + owned/shared file digests — never "read the plan".
After all waves: run the full local gate once per affected package (`pnpm typecheck`, then the
hermetic suite). Failures → fix via an implementer before proceeding. → **Checkpoint.**

### Stage 6 — Test

Spawn `test-writer`, one instance per Testing Plan row group, pointed at the target files from the
plan. → **Checkpoint.**

### Stage 7 — Plan verifier

Spawn `plan-verifier` for a single, complete pass: **verify Implementation Steps, Acceptance
Criteria, and Testing Plan against the codebase** — by this point Stage 5 (code) and Stage 6
(tests) both exist, so all three requirement types are checkable in one go; this is effectively
the plan's sign-off gate. For each ❌/⚠️: spawn a fresh implementer with the gap as its task, then
re-run affected tests, then re-verify by continuing the **same** `plan-verifier` instance via
`SendMessage` ("re-check only Step-n / AC-n / Testing-Plan-row-n just fixed") — it keeps the plan
and codebase map warm. **Loop cap: 2 iterations**, then escalate remaining gaps to the user.
→ **Checkpoint.**

### Stage 8 — Architecture review (post-implementation)

Spawn `architecture-reviewer`, scoped to the files Stages 5-7 touched. Critical/High findings →
fresh implementer(s) with the findings verbatim as tasks, then re-run affected tests, then
re-review by continuing the **same** `architecture-reviewer` instance via `SendMessage` (never a
fresh one — it already holds the module context warm). **Loop cap: 2 iterations**, then escalate.
Medium/Low → report only; fix only what the user picks. → **Checkpoint.**

### Stage 9 — Verify

Invoke the `verify` skill to drive the actual feature end-to-end and confirm it behaves as
specified — this is a live-behavior check, distinct from Stage 7's document-level completeness
check. → **Checkpoint.**

### Stage 10 — Workflow-retro

Invoke the `workflow-retro` skill (deep mode) across the session(s) this run spanned — pass every
session id involved if the run crossed handoffs. Relay its metrics table, insights, and
recommendations. → **Checkpoint**, then produce the **Closing analysis** below instead of a Stage
11 (there isn't one).

## Checkpoint procedure (run after every stage, no exceptions)

1. **Ukrainian structured summary** of the stage: what was produced, artifact path(s), key
   decisions made, open questions — as a short table or bullet list, not prose.
2. If the stage touched files worth committing, give the user a one-paragraph description **and**
   a ready-to-paste **English** commit message. **Never run `git commit` yourself** — the user
   commits.
3. Ask the user via `AskUserQuestion`: continue now in this session, or hand off to a new one.
   - **Continue** → before proceeding, check: did this stage surface a non-obvious, *verified*
     finding (an architecture-reviewer violation with a root cause, a plan-verifier gap that
     wasn't a simple oversight, a latent bug hit during Implement)? If yes, invoke
     `engineering-insights` inline now — a "new session" checkpoint gets this for free from the
     Stop hook, but a continued session doesn't stop, so nothing else will remind you. Then
     proceed straight into the next stage.
   - **New session** → write the handoff doc (below), then **stop** — do not start the next stage
     (the Stop hook will prompt `engineering-insights` for whatever this stage surfaced).

## Handoff doc (mandatory whenever the user picks "new session")

Path: `docs/plans/<date>-<slug>-<stage-name>-handoff.md`. Must contain:

- Stage just completed / stage to resume at (by number and name)
- Every artifact path produced so far (spec, plan, findings reports, touched files) — a cold-start
  session must be able to resume from this doc alone, without re-deriving anything
- Decisions locked so far
- Gate/loop status (typecheck/test results, fix-loop iterations used per stage)
- Open items or unresolved questions
- The exact next-session kickoff prompt, ready to paste, e.g.:
  `Continue run-plan from Stage 5 (Implement) using docs/plans/<...>-handoff.md — read it first, then proceed.`
- The ready-to-paste English commit message for anything uncommitted at this point

## Closing analysis (after Stage 10)

Beyond workflow-retro's own recommendations (which are about the token/cache mechanics of the
run), add a short Ukrainian meta-analysis about the **run-plan pipeline structure itself**:

| Спостереження | Вплив | Пропозиція |
|---|---|---|
| e.g. скільки checkpoint-пауз обрали "нову сесію" → скільки handoff-документів і холодних стартів це коштувало | час/токени | злити сусідні стадії, якщо користувач завжди відповідає "продовжити" |
| e.g. які артефакти з stage N агент stage N+1 читав повторно, хоч вони вже були вставлені в бриф | токени | посилити injection-дисципліну в конкретному Phase |
| e.g. які з 10 стадій жодного разу не давали знахідок/фіксів у цьому прогоні | час | кандидат на злиття або пропуск у наступних прогонах цієї фічі |

Close with 2-4 concrete proposals, each naming the exact stage or mechanism to change.

## Hard Rules

- **Checkpoint after every stage — no exceptions.** Never chain two stages without asking.
- **Never commit.** Summarize + hand over the commit message; the user runs `git commit`.
- **Loop caps are absolute:** Stage 7 (plan-verifier↔implementer) and Stage 8
  (architecture-reviewer↔implementer) each cap at 2 iterations, then escalate to the user.
- **Continue vs respawn:** re-checks of the same scope (Stage 7's re-verify, Stage 8's re-review)
  continue the **same** agent instance via `SendMessage`. A genuine fix is new work → a fresh
  implementer. Never respawn an agent mid-task on ambiguity — relay the question to the user and
  continue the same instance with the answer.
- **Inject, don't point.** Every stage's brief carries the prior stage's artifact content (or a
  digest) pasted in directly — never "go read `docs/plans/...`".
- **Stage 7 runs only once, after Test (Stage 6)**, so it can check Steps, AC, and Testing Plan
  together in a single sign-off pass — don't split it into an earlier partial pass.
- **Narrate in Ukrainian, structured**; artifacts and commit messages stay English.
- **On interruption or hard failure**, report which stages completed and which artifacts exist —
  the handoff doc must let the run resume from the failed stage, never from scratch.

## Final Report (once Stage 10 + closing analysis are done, or on early stop)

```
## Run-plan: <feature>

| # | Stage | Status | Artifact |
|---|---|---|---|
| 1 | Researcher | ✅/⏸/— | — |
| 2 | Spec | ✅/⏸/— | docs/feature-requirements/... |
| 3 | Arch review (pre-plan) | ✅/⏸/— | — |
| 4 | Plan | ✅/⏸/— | docs/plans/... |
| 5 | Implement | ✅/⏸/— | — |
| 6 | Test | ✅/⏸/— | — |
| 7 | Plan verifier | ✅/⏸/— | — |
| 8 | Arch review (post-impl) | ✅/⏸/— | — |
| 9 | Verify | ✅/⏸/— | — |
| 10 | Workflow-retro | ✅/⏸/— | docs/retros/... |

**Fix loops used:** plan verifier <n>/2 · post-impl architecture <n>/2
**Handoffs written:** <list of handoff doc paths, if any>
**Open escalations:** <list or "none">
```
