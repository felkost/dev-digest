# Plan — Multiple agents per repo (CI export)

**Date:** 2026-07-11
**Status:** Draft for decision (not yet approved)
**Goal:** Let a user export MORE THAN ONE review agent to the same target repo, so a single PR gets reviewed by N agents in CI — lifting today's "one agent per repo" v1 constraint.

## 1. Why it's one-agent-per-repo today

Three enforcement points, by design (flat v1 layout):

| Where | What it does | File |
|---|---|---|
| **Runner** | Aborts if `.devdigest/agents/` has ≠ 1 `*.yaml` (`"Expected exactly one agent manifest … found N"`) | [agent-runner/src/manifest.ts:40](../../agent-runner/src/manifest.ts) |
| **Export (service)** | Rejects a 2nd, different agent on an active repo | [ci/export-service.ts `resolveInstallationTarget`](../../server/src/modules/ci/export-service.ts) |
| **Export (DB)** | `setWhere` guard on the conflict path | [ci/repository/installations.repo.ts `upsertPublished`](../../server/src/modules/ci/repository/installations.repo.ts) |
| **Schema** | `ci_installations_workspace_repo_uq` unique on `(workspace_id, repo)` | [db/schema/ci.ts:47](../../server/src/db/schema/ci.ts) |

The runner check is the hard blocker — it's why exporting 3 agents produced the `found 3 manifests` failure.

## 2. Recommended design

**N installations per repo** (one `ci_installations` row per agent, as today) + **runner loops all manifests** + **one artifact carrying N per-agent results**.

Rejected alternative: one installation holding N agents — bigger data-model churn, and every downstream query (surface, runs, ingest) already keys on a single agent per row.

## 3. Changes by layer

### A. `agent-runner/` (bundled runner) — the core change
1. `manifest.ts`: add `loadManifests()` (plural) that returns **all** `*.yaml` (drop the `>1` throw; keep the `0` throw). Keep `loadManifest` for back-compat/tests.
2. `run.ts` `runCi`: loop over manifests — run `reviewPullRequest` per agent, post per agent (`github_review`/`pr_comment`), collect per-agent `CiResultArtifact`. Exit code = 1 iff **any** agent's gate triggers `REQUEST_CHANGES`. Keep the single outer try/catch hard-fail contract.
3. Result artifact: write **one** `devdigest-result.json` = `{ agents: CiResultArtifact[] }` (wrapper) — a **contract change** (`CiResultArtifact` → add `CiResultArtifactBundle`) in `vendor/shared` (both copies).
4. **Re-bundle**: `pnpm --dir agent-runner build` (ncc) → new `dist/index.js`; the export embeds this fresh bundle.

### B. `server/` (export + ingest + schema)
5. Migration `00NN_multi_agent_per_repo.sql`: **drop** `ci_installations_workspace_repo_uq`, add `ci_installations_workspace_repo_agent_uq` on `(workspace_id, repo, agent_id)` (still one row per agent per repo, but many agents per repo).
6. `resolveInstallationTarget` + `upsertPublished setWhere`: allow a different agent on an already-active repo (target the conflict on `(workspace, repo, agent)` instead of `(workspace, repo)`). Export writes the agent's manifest **without** clobbering other agents' manifests on the `devdigest/ci` branch (compose = union of all installed agents' manifests for that repo).
7. `ingest-service.ts` / `runs.repo.ts`: parse the **bundle** artifact → upsert **N** `ci_runs` (one per agent) per GitHub run. `ci_runs` unique key must become `(github_run_id, agent)` (or `ci_installation_id`) instead of `github_run_id` alone — **migration on `ci_runs`** + `upsertByGithubRunId` → `upsertByGithubRunIdAndAgent`.
8. `manifest.ts` (server) / `workflow.ts`: the export must emit every installed agent's manifest for the repo into `.devdigest/agents/` (union), not just the current one.

### C. `client/`
9. CI tab (`getAgentCiSurface`) already keys per-agent — mostly works once N installations exist. CI Runs already has an `agent` column and shows one row per (run, agent). Minor: the CI tab's repo grouping may show the same repo under multiple agents — acceptable, or group by repo with agent sub-rows.
10. Remove the "already installed for X — disconnect first" conflict copy for the same-repo-different-agent case.

## 4. Migrations
- `ci_installations`: swap unique index `(workspace, repo)` → `(workspace, repo, agent_id)`.
- `ci_runs`: unique `github_run_id` → `(github_run_id, agent)`.
Both additive-shaped but they DROP/replace an index → must verify no existing duplicate rows first.

## 5. Risks
- **Runner is shipped into other repos**: every already-installed repo runs the OLD single-manifest bundle until re-exported. Multi-agent only works after re-export of the new bundle. Must not break single-agent repos (loop of 1 == today).
- **Artifact contract change** (`CiResultArtifactBundle`) touches both vendored `shared` copies + the ingest parser + the runner writer simultaneously — a mismatched deploy = ingest sees an unknown shape. Ship server + re-bundled runner together; keep the parser tolerant of the old single-object shape (back-compat).
- **GitHub rate/permissions**: N agents = N review/comment posts per PR — still under `pull-requests: write`, but noisier; consider one combined comment.
- **Re-bundle discipline**: `dist/index.js` is generated — never hand-edit; always `ncc build`.

## 6. Scope estimate
**Large.** 3 packages (runner + server + client), 2 migrations, 1 shared-contract change (both copies), a runner re-bundle, and back-compat handling for already-installed single-agent repos. Realistically a multi-step SDD feature (spec → plan → implement), not a single patch. Recommend running it through `spec-creator` → `implementation-planner` → `/implement` given the cross-package + shipped-artifact risk.

## 7. Out of scope (this plan)
- One combined multi-agent PR comment (vs N separate) — nice-to-have, later.
- Fork-PR handling changes (unchanged: still skipped).
- Multi-Agent Review (studio) — already supports N agents; untouched.
