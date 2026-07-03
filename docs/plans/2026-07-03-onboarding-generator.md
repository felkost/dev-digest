# Development Plan: Onboarding Generator

**Date:** 2026-07-03
**Requirements:** [docs/feature-requirements/2026-07-03-onboarding-generator.md](../feature-requirements/2026-07-03-onboarding-generator.md) (Status: draft)
**Execution mode:** multi-agent
**Scope:** full-stack (server · client · repo-intel facts)
**Affects modules:** `server/src/modules/onboarding/` (new), `server/src/db/schema/context.ts` (extend), `server/src/db/migrations/` (new `0015`), `server/src/modules/repo-intel/pipeline/walk.ts` (harden), `server/src/adapters/github/octokit.ts` + `server/src/vendor/shared/adapters.ts` (extend), `server/src/vendor/shared/contracts/` + `client/src/vendor/shared/contracts/` (new `onboarding.ts`, mirrored), `server/src/modules/index.ts` (register), `client/src/app/repos/[repoId]/onboarding-tour/` (new), `client/src/vendor/ui/nav.ts` (extend), `client/src/lib/hooks/` (new `onboarding.ts`)

---

## 1. Context

A newcomer to an unfamiliar repository has no fast, trustworthy way to understand its architecture, how to run it, and where to start reading. This feature generates a one-page "Onboarding Tour" per repository: deterministic code computes every fact (stack, structure, routes, scripts, import graph, file importance) at zero LLM cost via the existing `repo-intel` facade, and exactly ONE structured LLM call turns those facts into readable narrative across 5 fixed sections. The tour is persisted so re-opening the page is instant, with a manual "Regenerate" action.

The codebase already contains three load-bearing pieces of prior infrastructure that this plan builds on rather than re-creates: an unregistered `onboarding` DB table (`server/src/db/schema/context.ts:120-126`, JSONB blob + timestamp per repo), a ready-to-use structured-output system prompt (`server/src/prompts/onboarding.system.md`), and repo-intel facade methods explicitly documented as built for this feature (`getTopFilesByRank`, `getCriticalPaths` — both docstring-labeled "onboarding reading-path" in `server/src/modules/repo-intel/service.ts`). The plan's job is to wire these together, add the two genuinely new pieces (lite-mode GitHub Trees/Contents reads, and the repo-wide route aggregator over `file_facts`), and hardern the shared `walk.ts` indexing gap that blocks the repo-isolation acceptance criteria (AC-13/AC-14).

## 2. Architecture Fit

New Fastify module `server/src/modules/onboarding/` (routes → service → repository), registered statically in `modules/index.ts`, following the `blast` module as the direct structural template (same PR-domain-read pattern, same `BlastIndexInfo`-style vocabulary reuse, same `container.repoIntel.*` consumption).

- **Persistence**: the existing `onboarding` table (`server/src/db/schema/context.ts`) is extended additively via a new migration `0015_onboarding_metadata.sql` — never altered in place, never re-created. See §4 for the exact column list and the workspace-scoping resolution.
- **Full-mode facts**: consumed entirely through `container.repoIntel.*` (already implemented, zero new ranking/graph code) plus two new direct-clone reads (`package.json`, `.env.example`, docker-compose) and one new repository method aggregating `file_facts` repo-wide (new — the per-file `getFileFacts` today takes an explicit path list, not "all files").
- **Lite-mode facts**: two new methods added to the `GitHubClient` port (`server/src/vendor/shared/adapters.ts`) and implemented in `OctokitGitHubClient` — Git Trees (recursive) and Contents (single file) — consumed only by the onboarding service, never by other modules in this plan.
- **LLM call**: exactly one `container.llm(provider).completeStructured(...)` call per generation, mirroring `ConventionExtractor.extract()` (`server/src/modules/conventions/extractor.ts`) almost line-for-line: resolve model via `resolveFeatureModel(container, workspaceId, 'onboarding')` (registry entry already exists in `FEATURE_MODELS`), build bounded input from ranked facts, one `completeStructured` call, map `costUsd → cents`.
- **Repo isolation hardening**: `server/src/modules/repo-intel/pipeline/walk.ts` gains `.gitignore` honoring and nested-repo-metadata skipping. This is shared indexing infrastructure — the fix benefits every repo-intel consumer, not just onboarding, and is scoped as its own independent step with its own tests derived from AC-13/AC-14.
- **Client**: new repo-scoped route `client/src/app/repos/[repoId]/onboarding-tour/` (Server Component shell awaiting `params`, mirroring `context/page.tsx`), new sidebar nav entry, new `_components/OnboardingTourView/` tree with 5 section components + shared card chrome, new `useOnboardingTour`/`useGenerateOnboardingTour` hooks via TanStack Query.

**Route path decision**: `repos/[repoId]/onboarding-tour` — NOT `repos/[repoId]/onboarding`, which collides with the existing unrelated "Add new repository" route at `client/src/app/onboarding/`.

## 3. Skills & Patterns Applied

**backend-onion-architecture**: new module strictly follows `routes.ts` → `service.ts` → `repository.ts`; adapters only via `container.*` (never `new OctokitGitHubClient()` in service); `AppError` subclasses for all expected failures; every repository query workspace-scoped via join (R1); static registration in `modules/index.ts` (R7); no cross-module internal imports — lite-mode GitHub reads go through `container.github()`, full-mode facts through `container.repoIntel`.

**fastify-best-practices**: route schemas via Zod + `fastify-type-provider-zod`; rate limiting via Fastify's `config.rateLimit` on the generation route only (mirrors `review-all`'s per-route precedent).

**zod**: `OnboardingTour`/`OnboardingSection`/`OnboardingEntry` schemas drive both the persisted-row parse and the API response type; the LLM structured-output schema (narrative sections only) is a distinct, narrower Zod schema passed to `completeStructured`.

**drizzle-orm-patterns / postgresql-table-design**: additive-only migration (new columns, `NOT NULL DEFAULT` to satisfy existing-empty-table safety, no rewrite risk since the table is currently unregistered and empty); no new indexes needed beyond the existing PK (`repo_id`) since all reads are single-row-by-repo.

**react-best-practices / frontend-architecture**: data fetching in hooks only (`useOnboardingTour`, `useGenerateOnboardingTour`), never in component bodies; container/presentational split (`OnboardingTourView` fetches, section components are presentational); co-located `_components/` per the existing `context`/`pulls` convention.

**next-best-practices**: Server Component page shell awaits `params` per Next 15 convention (mirrors `context/page.tsx`, the one page in the codebase already doing this correctly per `client/insights.md` 2026-07-03).

**mermaid-diagram**: the LLM emits raw mermaid syntax for the architecture/how-to-run diagrams (per the existing system prompt's rules — `flowchart LR/TD` only, quoted labels, no diagram≠null placeholders); the assembler deterministically appends a `classDef`/`style` block keyed by node-kind AFTER the LLM returns — colors are never LLM-authored.

**security**: README content (lite mode) and any repo-content facts fed to the LLM are wrapped in `<untrusted>…</untrusted>` per the existing prompt's already-established convention (§18 of the spec — no new prompt-injection surface, this is data-only, never instructions); file-path traversal guards on `readFile` for `package.json`/`.env.example`/docker-compose mirror the exact `resolve(repoRoot, path).startsWith(repoRoot)` pattern in `conventions/extractor.ts`; the generation endpoint is rate-limited to prevent paid-LLM-call fan-out (AC-16); no secrets are ever included in the bounded LLM input (`.env.example` is explicitly the *example* file, never `.env`).

## 4. Project Constraints

- **Workspace scoping**: `onboarding` table has no `workspace_id` column and none is added (avoids 3NF-violating duplication of `repos.workspace_id`). Every repository query joins `onboarding` → `repos` and filters `repos.workspace_id = $workspaceId` — the established codebase pattern for tables lacking their own column (precedent: `BlastRepository.getPr`, `pull.repo.ts`'s `getBrief`).
- **Migration additivity**: `0015_onboarding_metadata.sql` adds only new nullable/defaulted columns to the existing empty, unregistered `onboarding` table. Never alters `repo_id`, `json`, or `generated_at`. Never edits any applied migration file.
- **DB schema is stable** — one migration, this feature only; no bundling with logic changes.
- **`reviewer-core` is untouched** — this feature does not use `groundFindings()` or `assemblePrompt()`; it is a separate structured-output call path (`container.llm(...).completeStructured`), same pattern as `ConventionExtractor`, deliberately outside reviewer-core's citation-gate machinery (the spec has no "grounding" requirement — narrative claims are the LLM's, bounded by facts, not per-citation graded).
- **Secrets via `SecretsProvider` only** — no `process.env` reads anywhere in the new module; GitHub token and LLM keys resolved exclusively through `container.secrets`/`container.github()`/`container.llm()`.
- **Adapters only via Container** — the two new `GitHubClient` methods are called through `container.github()`, never a direct `new OctokitGitHubClient()`.
- **Shared contracts** — `onboarding.ts` added to `server/src/vendor/shared/contracts/` AND separately mirrored into `client/src/vendor/shared/contracts/` in the same task (these are two physically distinct copies per `client/insights.md` 2026-07-02 — a divergence breaks client typecheck silently).
- **`server/src/vendor/shared/adapters.ts` is additive-only in this plan** — two new methods added to the `GitHubClient` interface; no existing method signature is changed. This still counts as touching a shared port and is called out explicitly as a Wave-1 task with narrow, reviewable scope.
- **Rate limiting**: generation endpoint (`POST`) rate-limited to **3 requests/minute per workspace**, mirroring the `review-all` precedent (per-route, not per-repo) — satisfies AC-16.
- **One LLM call invariant**: the service has exactly one call site to `completeStructured` for the narrative; any retry/backoff internal to `completeStructured` (`maxRetries`) is a single logical call from the AC-5/AC-6 accounting perspective — cost is logged from the single `StructuredResult`, not summed across retries.
- **Zero LLM in facts/ranking**: `getTopFilesByRank`/`getCriticalPaths`/`getFileRank`/`getConventionSamples`-style calls, the new `getAllFileFacts` aggregator, and the two new GitHub Trees/Contents reads are all pure I/O — no LLM involvement (AC-4).
- **Never touch**: `server/src/vendor/shared/` beyond the one additive file/interface change explicitly scoped here; `server/drizzle/`-style applied migrations (never edit in place); `reviewer-core/src/grounding.ts`.

---

## 5. Implementation Steps

### Parallelization Map (multi-agent)

```
Wave 1 (4 independent tracks — no shared owned paths, no cross-dependencies):
  Step 1: DB migration 0015                         [server/src/db/schema, server/src/db/migrations]
  Step 2: walk.ts gitignore/nested-repo hardening    [server/src/modules/repo-intel/pipeline/walk.ts + tests]
  Step 3: GitHub Trees/Contents adapter methods      [server/src/vendor/shared/adapters.ts, server/src/adapters/github/octokit.ts, server/src/adapters/mocks.ts]
  Step 4: Shared contracts (onboarding.ts, both copies) [server/src/vendor/shared/contracts, client/src/vendor/shared/contracts]

Wave 2 (depends on Wave 1; 2 independent tracks once their Wave-1 deps land):
  Step 5: repo-intel repo-wide file_facts aggregator  [server/src/modules/repo-intel/repository.ts, service.ts, types.ts]
           depends on: none from Wave 1 directly (touches only repo-intel; can actually start in Wave 1 —
           see note below), but grouped here because it is a prerequisite for Step 6.
  Step 6: onboarding server module (routes/service/repository/helpers) [server/src/modules/onboarding/**, modules/index.ts]
           depends on: Step 1 (migration/schema), Step 3 (GitHub adapter), Step 4 (contracts), Step 5 (aggregator)
  Step 7: onboarding client page + components + hooks [client/src/app/repos/[repoId]/onboarding-tour/**, client/src/lib/hooks/onboarding.ts, client/src/vendor/ui/nav.ts]
           depends on: Step 4 (contracts) only — proceeds against a mocked API per client hermetic testing convention, in parallel with Step 6

Wave 3 (integration — depends on Steps 6 and 7 both landing):
  Step 8: end-to-end wiring check + i18n strings + nav entry finalization (small, sequential closer)
```

**Note on Step 5**: `getAllFileFacts`-style aggregation only touches `repo-intel/repository.ts` + `service.ts` + `types.ts` — disjoint from Steps 1–4's owned paths. It could run in Wave 1 as a 5th independent track. It is listed under Wave 2 here only because Step 6 cannot start without it and grouping keeps the dependency chain legible; an implementer fleet with 5 free slots MAY start Step 5 in Wave 1 alongside Steps 1–4 — there is no file collision either way.

---

### Step 1: Extend the `onboarding` table via migration 0015

**Dependencies:** none
**Owned paths:** `server/src/db/schema/context.ts` (edit — add columns to the existing `onboarding` table definition only), `server/src/db/migrations/0015_onboarding_metadata.sql` (new), `server/src/db/migrations/meta/0015_snapshot.json` (generated), `server/src/db/migrations/meta/_journal.json` (append entry)

**What to do:**
1. In `server/src/db/schema/context.ts`, extend the existing `onboarding` pgTable definition (lines 120-126) with five new columns — do NOT touch `repoId`, `json`, or `generatedAt`:
   - `mode: text('mode', { enum: ['full', 'lite'] }).notNull().default('full')`
   - `indexStatus: text('index_status', { enum: ['full', 'partial', 'degraded', 'failed'] }).notNull().default('degraded')`
   - `degraded: boolean('degraded').notNull().default(true)`
   - `degradedReason: text('degraded_reason')` (nullable, no default)
   - `llmCostCents: integer('llm_cost_cents')` (nullable, no default — "null = cost unknown" per the contract)
2. Run `cd server && pnpm db:generate` to emit migration `0015_onboarding_metadata.sql` and its matching snapshot/journal entry. Before trusting the output, inspect the generated SQL: it must contain ONLY `ALTER TABLE onboarding ADD COLUMN ...` statements — no `ALTER COLUMN`, no `DROP`, no touching of any other table. If `db:generate` reports "No schema changes" or touches unrelated tables, STOP and follow the diagnostic procedure in `server/insights.md` (2026-07-03 Mistake entries on snapshot chain corruption) before proceeding — do not hand-edit the snapshot chain speculatively.
3. Apply locally with `pnpm db:migrate` and verify via `docker exec devdigest-postgres psql -U devdigest -d devdigest -c "\d onboarding"` that all 8 columns exist with the expected types/defaults.

**Verify:**
- [ ] Compiles (`cd server && pnpm typecheck`)
- [ ] `pnpm db:migrate` applies cleanly against a fresh DB and against the current dev DB
- [ ] `\d onboarding` shows `repo_id, json, generated_at, mode, index_status, degraded, degraded_reason, llm_cost_cents` with no changes to the first three columns' types/constraints
- [ ] A second `pnpm db:generate` run reports no further schema changes (chain is clean)

**Commit:** `feat(onboarding): extend onboarding table with mode/index-health/cost columns (migration 0015)`

---

### Step 2: Harden `walk.ts` — honor `.gitignore` and skip nested repo metadata

**Dependencies:** none
**Owned paths:** `server/src/modules/repo-intel/pipeline/walk.ts`, `server/test/walk.test.ts` (new or extended — check for an existing `walk` test file first and extend rather than overwrite)

**What to do:**
1. Add the `ignore` npm package as a new dependency (`cd server && pnpm add ignore`) — this is the TODO already documented at `walk.ts:14-18` ("TODO(T3): wire `ignore` once we accept a new dep").
2. In `walkClone(root)`, before starting the directory walk: attempt to read `.gitignore` from `root` (best-effort — missing file is not an error, just means no ignore rules). Build an `ignore()` instance from its contents. Also recursively pick up any nested `.gitignore` files as the walk descends (standard git semantics: closer `.gitignore` rules apply to their subtree) — implement this by testing each candidate relative path against the root-level `ignore()` instance at minimum (a single root `.gitignore` check is the mandatory baseline for AC-13; nested `.gitignore` merging is a nice-to-have if time allows within this step, not a separate step).
3. In `walkDir`, before recursing into a directory or accepting a file, test its repo-relative path against the `ignore()` instance; skip if ignored.
4. Add nested-repository detection: when `entry.isDirectory()` and `name === '.git'`, this is ALREADY excluded by `EXCLUDED_DIRS` at the top level, but a NESTED `.git` directory (i.e., `.git` found in ANY subdirectory, not just `root/.git`) indicates a nested repository working tree and must also cause the walk to skip that entire subtree — not just the `.git` folder itself. Detect this by checking, for every directory being recursed into (other than `root` itself), whether it contains a `.git` entry (file or directory — submodules use a `.git` FILE pointing at the parent's gitdir) BEFORE walking its children; if found, skip the whole subtree and record it in `stats` (add a new `stats.skippedNestedRepo: number` counter, incremented once per skipped subtree root).
5. Update `WalkStats` interface to include `skippedNestedRepo: number` and `gitignoredCount: number` (candidates dropped by `.gitignore`, for observability parity with `skippedTooLarge`).
6. Update the file's header comment to remove the "NOT YET HANDLED" section since it is now handled; briefly document the two new stats fields.

**Verify:**
- [ ] Compiles (`cd server && pnpm typecheck`)
- [ ] `pnpm exec vitest run --exclude '**/*.it.test.ts'` — hermetic tests pass, including new/extended test cases for: (a) a file matching a `.gitignore` pattern is excluded from `WalkResult.files`, (b) a nested directory containing its own `.git` entry is fully excluded (none of its descendant files appear in the result) and `stats.skippedNestedRepo` increments, (c) a repo with no `.gitignore` at all still walks normally (no regression, missing file ≠ error)
- [ ] Existing walk.ts tests (if any) still pass unmodified in behavior for non-gitignore, non-nested-repo cases

**Commit:** `fix(repo-intel): honor .gitignore and skip nested repository trees in walkClone`

---

### Step 3: Add GitHub Trees + Contents API methods (lite-mode fact source)

**Dependencies:** none
**Owned paths:** `server/src/vendor/shared/adapters.ts` (additive interface extension only), `server/src/adapters/github/octokit.ts` (implement the two new methods), `server/src/adapters/mocks.ts` (extend the mock `GitHubClient` implementation used by hermetic tests)

**What to do:**
1. In `server/src/vendor/shared/adapters.ts`, extend the `GitHubClient` interface (additive — do not touch any existing method signature) with two new methods:
   - `getRepoTree(repo: RepoRef, ref?: string): Promise<{ path: string; type: 'blob' | 'tree' }[]>` — wraps `GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1` (Octokit: `octokit.rest.git.getTree`). When `ref` is omitted, resolve the default branch's tree sha first (or pass `ref` directly if the caller already has the default branch name — Octokit's `getTree` accepts a branch name as `tree_sha` for the recursive listing in practice via the repo's default ref; if not, resolve `owner/repo` → default branch → `git/refs/heads/{branch}` → commit sha → tree sha, in that order, and cache nothing — single call site).
   - `getFileContents(repo: RepoRef, path: string, ref?: string): Promise<string | null>` — wraps `GET /repos/{owner}/{repo}/contents/{path}` (Octokit: `octokit.rest.repos.getContent`), base64-decodes the `content` field, returns `null` on 404 (file not present — NOT an error, e.g. no README) rather than throwing.
2. In `server/src/adapters/github/octokit.ts`, implement both methods on `OctokitGitHubClient` using the same `withRetry(() => withTimeout(...))` wrapping convention as every other method in the file. `getFileContents` catches a 404 Octokit error specifically and returns `null`; any other error propagates (consistent with the rest of the file's error philosophy — only the documented "absent" case is swallowed).
3. In `server/src/adapters/mocks.ts`, add both methods to the mock `GitHubClient` implementation with simple deterministic fixture behavior (e.g. a small hardcoded tree + a fixture `package.json`/`README.md` content map) so hermetic tests in Step 6 can exercise lite mode without a real GitHub call.

**Verify:**
- [ ] Compiles (`cd server && pnpm typecheck`)
- [ ] `pnpm exec vitest run --exclude '**/*.it.test.ts'` passes (existing adapter/mock tests unaffected — this is purely additive)
- [ ] No existing `GitHubClient` call site anywhere in the codebase needed a signature change (grep confirms only additive)

**Commit:** `feat(github-adapter): add getRepoTree and getFileContents for onboarding lite mode`

---

### Step 4: Shared `onboarding` contracts (both vendor/shared copies)

**Dependencies:** none
**Owned paths:** `server/src/vendor/shared/contracts/onboarding.ts` (new), `server/src/vendor/shared/index.ts` (add barrel export), `client/src/vendor/shared/contracts/onboarding.ts` (new, mirrored), `client/src/vendor/shared/index.ts` (add barrel export, if the client barrel mirrors the server one — verify the existing pattern for e.g. `blast.ts` before assuming)

**What to do:**
1. Author `onboarding.ts` in `server/src/vendor/shared/contracts/` translating spec §17's Contracts section into Zod schemas:
   - `OnboardingIndexInfo` — REUSE the exact shape of `BlastIndexInfo` (`status: enum(['full','partial','degraded','failed']), degraded: boolean, reason: string.nullish()`) — either import/re-export `BlastIndexInfo` directly if a cross-file import within `vendor/shared` is idiomatic here (check how `blast.ts` imports `BlastRadius`/`PrHistory` from `brief.ts` — same package, same convention applies), or define an identically-shaped new type if the two concepts should stay decoupled long-term. Prefer re-export for now (only one indexing-health vocabulary should exist) unless it creates a circular import — in that case, define a structurally identical type named `OnboardingIndexInfo`.
   - `OnboardingEntry` — `{ path: string, rationale: string, rank: number.nullable(), github_link: string.url().nullable() }` (rank null in lite mode per §17; github_link null when unresolvable per AC-9).
   - `OnboardingSectionKind` — `z.enum(['architecture', 'critical_paths', 'how_to_run', 'reading_path', 'first_tasks'])`.
   - `OnboardingSection` — `{ kind: OnboardingSectionKind, title: string, body: string, diagram: string.nullable(), entries: z.array(OnboardingEntry) }`.
   - `OnboardingTour` — `{ repo_id: string.uuid(), generated_at: string.datetime().nullable() /* null = never generated */, mode: z.enum(['full','lite']), index: OnboardingIndexInfo, llm_cost_cents: number.int().nonnegative().nullable(), sections: z.array(OnboardingSection).length(5) }`.
   - `OnboardingGenerateResponse` — same shape as `OnboardingTour` (the generate endpoint returns the refreshed tour synchronously per spec §7's stated option — see Step 6 for the sync-vs-async decision).
   - Export both the Zod schemas and their `z.infer` types per the zod skill's `type-export-schemas-and-types` rule.
2. Add the barrel export line to `server/src/vendor/shared/index.ts` (one line, following the existing pattern for `blast.ts`/other contract files).
3. Copy the exact same file content to `client/src/vendor/shared/contracts/onboarding.ts` (byte-identical schemas — this is a deliberate manual sync per the existing two-copies convention, not a shared import). Add the matching barrel export to `client/src/vendor/shared/index.ts`.
4. Grep the WHOLE `vendor/shared` directory (both copies) for every new export name (`OnboardingTour`, `OnboardingSection`, `OnboardingEntry`, `OnboardingIndexInfo`, `OnboardingSectionKind`, `OnboardingGenerateResponse`) before finalizing — per `server/insights.md` 2026-07-02 Mistake entry, a duplicate export name across contract files breaks the barrel with a cryptic `TS2308` error at `index.ts`, not at the colliding file.

**Verify:**
- [ ] Compiles (`cd server && pnpm typecheck` AND `cd client && pnpm typecheck` — both copies must typecheck independently)
- [ ] `cd server && pnpm exec vitest run --exclude '**/*.it.test.ts'` — existing `contracts.test.ts` (if it parses the whole barrel) still passes
- [ ] No duplicate export names across either `vendor/shared` copy
- [ ] Both copies are byte-identical (diff check)

**Commit:** `feat(shared): add OnboardingTour contracts (server + client vendor/shared)`

---

### Step 5: repo-intel repo-wide `file_facts` aggregator (routes/endpoints inventory)

**Dependencies:** none (can start in Wave 1 alongside Steps 1–4; grouped in Wave 2 narrative only because Step 6 needs it)
**Owned paths:** `server/src/modules/repo-intel/repository.ts` (add method), `server/src/modules/repo-intel/service.ts` (add facade method), `server/src/modules/repo-intel/types.ts` (extend `RepoIntel` interface)

**What to do:**
1. In `RepoIntelRepository` (`repository.ts`), add `getAllFileFacts(repoId: string): Promise<IndexerFileFactsRow[]>` — same shape/query as the existing `getFileFacts(repoId, files)` (around line 548) but WITHOUT the `files` filter — select all `file_facts` rows for `repoId`. This is the "new repo-wide route aggregator over file_facts" named in the requirements.
2. In `types.ts`, add `getAllFileFacts(repoId: string): Promise<{ filePath: string; endpoints: string[]; crons: string[] }[]>` to the `RepoIntel` interface (array-returning method — degrades to `[]` per the file's documented DEGRADED CONTRACT, never throws).
3. In `RepoIntelService` (`service.ts`), implement `getAllFileFacts`: gate on `this.container.config.repoIntelEnabled` (matching every other facade read method's degraded-gate convention), delegate to `this.repo.getAllFileFacts(repoId)`.
4. This method deliberately does NOT apply the `HUB_ENDPOINT_LIMIT` filtering that `blast/service.ts` applies (that filter is specific to blast's "don't attribute a whole app's routes to one changed symbol" concern) — onboarding's routes/endpoints section wants the COMPLETE inventory, hub files included, since it's describing "what routes exist in this repo," not attributing impact to a symbol. Document this distinction in a code comment referencing `blast/service.ts`'s `HUB_ENDPOINT_LIMIT` so a future reader doesn't "fix" this by importing the filter.

**Verify:**
- [ ] Compiles (`cd server && pnpm typecheck`)
- [ ] `pnpm exec vitest run --exclude '**/*.it.test.ts'` — new hermetic test: `getAllFileFacts` returns all rows for a repo with no file-list filter, returns `[]` for a repo with no indexed facts, returns `[]` when `repoIntelEnabled` is false
- [ ] No existing caller of `getFileFacts` (the filtered version) was touched — this is a strictly additive new method

**Commit:** `feat(repo-intel): add getAllFileFacts repo-wide aggregator for onboarding routes inventory`

---

### Step 6: Onboarding server module (routes / service / repository / helpers)

**Dependencies:** Step 1 (migration + schema columns), Step 3 (GitHub Trees/Contents adapter), Step 4 (shared contracts), Step 5 (file_facts aggregator)
**Owned paths:** `server/src/modules/onboarding/routes.ts` (new), `server/src/modules/onboarding/service.ts` (new), `server/src/modules/onboarding/repository.ts` (new), `server/src/modules/onboarding/helpers.ts` (new), `server/src/modules/onboarding/constants.ts` (new), `server/src/modules/index.ts` (add one import + one registry entry), `server/test/onboarding-*.test.ts` (new hermetic tests)

**What to do:**

1. **`repository.ts`** — `OnboardingRepository`, constructor takes `Db`. Methods, ALL joined through `repos` for workspace scope (no `workspace_id` column on `onboarding` itself — see §4):
   - `getTour(workspaceId: string, repoId: string): Promise<OnboardingRow | null>` — `SELECT onboarding.* FROM onboarding INNER JOIN repos ON onboarding.repo_id = repos.id WHERE onboarding.repo_id = $repoId AND repos.workspace_id = $workspaceId`.
   - `upsertTour(workspaceId: string, repoId: string, data: {...}): Promise<OnboardingRow>` — verify repo ownership first (re-use the same join-based existence check, or accept a pre-validated `repoId` from the service since the service will have already resolved repo basics), then `INSERT ... ON CONFLICT (repo_id) DO UPDATE SET json=excluded.json, generated_at=excluded.generated_at, mode=excluded.mode, index_status=excluded.index_status, degraded=excluded.degraded, degraded_reason=excluded.degraded_reason, llm_cost_cents=excluded.llm_cost_cents`.
   - `getRepoBasics(repoId: string): Promise<{ owner, name, defaultBranch, clonePath, workspaceId } | null>` — mirrors `BlastRepository.getRepoBasics` / `RepoIntelRepository.getRepoBasics`, but ALSO returns `workspaceId` so the service can verify ownership before any write (needed since `upsertTour` writes without its own SELECT-then-check round trip if the service already has it).

2. **`helpers.ts`** — pure functions:
   - `toOnboardingTourDto(row, sections)`: maps a DB row + generated sections array into the `OnboardingTour` contract shape (never-null generation timestamp handling: `generated_at: row ? row.generatedAt.toISOString() : null`).
   - `buildLlmInput(facts)`: assembles the bounded fact bundle passed to the LLM — top-N ranked files (cap at 20, matching the existing `getTopFilesByRank` convention used elsewhere), aggregated route/script/stack facts, critical-path chains (from `getCriticalPaths`, already capped at 5 roots × `BFS_DEPTH` internally) — NEVER full file contents.
   - `appendDiagramColors(diagram: string, sectionKind): string`: deterministically appends a `classDef`/`style` block to the LLM-returned mermaid string, keyed by node-kind detected via the reused Blast-Graph-style category convention (application code / middleware / datastore) — see §3. If `diagram` is null, return null unchanged (never synthesize a diagram the LLM didn't produce).
   - `mapGithubLink(repoBasics, sha, path)`: build a `github_link` exactly like `BlastLink`-consuming client code does (`https://github.com/{owner}/{repo}/blob/{sha}/{path}`), returning `null` when `repoBasics` or `sha` is unavailable (AC-9).

3. **`constants.ts`**:
   - `LLM_INPUT_TOP_N_FILES = 20`
   - `ONBOARDING_SYSTEM_PROMPT_PATH` reference (reuse `platform/prompts.ts`'s existing template loader for `onboarding.system.md`)
   - The narrower Zod schema passed to `completeStructured` for the 5-section narrative-only output (title/body/diagram/links per section — the LLM does NOT emit `rank`, `github_link` resolution, or index-health metadata; those are assembled deterministically by the service after the LLM call, per AC-4/AC-5's zero-LLM-for-facts invariant).

4. **`service.ts`** — `OnboardingService`, constructor takes `Container`:
   - `async getTour(workspaceId: string, repoId: string): Promise<OnboardingTour>`: fetch via repository; if no row, return the "never generated" well-formed response (spec §7 — `generated_at: null`, 5 sections present with empty bodies, `mode`/`index` reflecting a fresh `getIndexState` call so the UI can still show a degraded/lite badge and CTA even pre-generation). Never throws for "not yet generated" — that is a valid response shape (only a genuinely missing/cross-workspace REPO throws `NotFoundError`).
   - `async generateTour(workspaceId: string, repoId: string): Promise<OnboardingTour>`: this is the single orchestration method — the heart of the feature:
     a. Resolve repo basics (throw `NotFoundError` if repo missing/cross-workspace).
     b. Call `container.repoIntel.getIndexState(repoId)` to decide full vs lite mode (full/partial → attempt full-mode facts; degraded/failed with no clone → lite mode per AC-10).
     c. **Full mode**: `getTopFilesByRank`, `getCriticalPaths`, `getAllFileFacts` (Step 5), plus direct clone reads of `package.json`/`.env.example`/docker-compose via `container.git.readFile` (reusing the `context-docs` module's confined-path pattern documented in `server/insights.md` 2026-07-03 — repo-relative path passed to `readFile`, never an absolute confined path).
     d. **Lite mode**: `container.github().getRepoTree()` + `getFileContents()` for `package.json` and `README.md` (Step 3); reading-path built from the documented heuristic (declared entry points + top-level dirs) — explicitly NOT rank-ordered (no import graph available), tagged accordingly in the response.
     e. **No-data fallback** (AC-12): if full mode is unavailable AND the lite-mode GitHub calls also fail/return nothing usable, build a deterministic skeleton — 5 section headers, empty bodies, honest "not enough data" notices, `index.status = 'failed'` — and skip the LLM call entirely (this is the one case where generation completes with ZERO sections having narrative content and the LLM is never invoked; still counts as "a generation attempt was made" for UI purposes, but AC-5's "one LLM call" invariant is satisfied vacuously — zero is not more than one).
     f. Build the bounded fact bundle (`helpers.buildLlmInput`), resolve the feature model (`resolveFeatureModel(container, workspaceId, 'onboarding')`), make the ONE `completeStructured` call using the existing `onboarding.system.md` template (loaded via `platform/prompts.ts`'s existing loader) with README/repo-content wrapped in `<untrusted>` tags per §18.
     g. Post-process: `appendDiagramColors` on architecture/how_to_run diagrams; attach `github_link` per entry via `mapGithubLink`; attach `rank` per reading-path entry (from step c's ranked list; `null` in lite mode).
     h. Compute `llm_cost_cents = result.costUsd != null ? Math.round(result.costUsd * 100) : null`.
     i. Log exactly one structured line: LLM call made, cost in cents, mode, index status (AC-6, §13) — `req.log`-style child logger passed down from the route (mirrors the `run-executor.ts` fire-and-forget logger pattern from `server/insights.md`).
     j. Persist via `repository.upsertTour(...)`; return the fresh `OnboardingTour`.
     k. On any hard failure during full generation AFTER a previously-persisted tour exists (AC-18): catch, log, and re-throw an `AppError` that the ROUTE layer maps to a retryable error response WITHOUT touching the persisted row — the client (Step 7) is responsible for keeping the last-good tour visible; the service must NOT overwrite `onboarding` on a failed generation.
   - Non-fatal, best-effort framing throughout: EVERY external read in full/lite mode is wrapped so a single failing fact source (e.g. no `.env.example` present, or `docker-compose.yml` absent) degrades that fact silently rather than aborting the whole generation — only a total inability to gather ANY usable facts triggers the AC-12 skeleton path.

5. **`routes.ts`**:
   - `GET /repos/:id/onboarding` → `service.getTour(workspaceId, repoId)`. Schema: `params: IdParams`, `response: { 200: OnboardingTour }`.
   - `POST /repos/:id/onboarding/generate` → `service.generateTour(workspaceId, repoId)`, rate-limited `{ max: 3, timeWindow: '1 minute' }` per §4 (satisfies AC-16). Pass a child logger (`req.log.child({ route: 'onboarding.generate', repoId })`) into the service call per the fire-and-forget logger convention — even though this route is NOT fire-and-forget (spec §7 allows either sync-return or async-poll; this plan chooses **synchronous return of the refreshed tour** since generation is a single bounded LLM call, not a fan-out, so there is no strong reason to add polling complexity) so the logger recycling risk does not actually apply here, but the child-logger pattern is used anyway for consistent structured log correlation.
   - Both routes call `getContext(container, req)` first, exactly like every other module.

6. **`modules/index.ts`**: add `import onboarding from './onboarding/routes.js';` and one entry `onboarding,` in the `modules` registry object.

**Verify:**
- [ ] Compiles (`cd server && pnpm typecheck`)
- [ ] `pnpm exec vitest run --exclude '**/*.it.test.ts'` — hermetic tests (see Testing Plan for the full AC-derived list) pass, using `MockLLMProvider`/mocked `GitHubClient`/mocked `repoIntel` from `src/adapters/mocks.ts` and `ContainerOverrides`
- [ ] Cross-workspace request to `GET /repos/:id/onboarding` for a repo in a different workspace returns 404, not the tour (workspace isolation)
- [ ] A generation on a repo with NO clone and a failing GitHub API returns the AC-12 skeleton, not a 500
- [ ] Exactly one `completeStructured` call is made per successful `generateTour` invocation (assert call count on the mock LLM provider)
- [ ] Rate limit fires on the 4th rapid `POST .../generate` call within a minute in a route-inject test

**Commit:** `feat(onboarding): add onboarding server module (full+lite generation, persistence, rate limiting)`

---

### Step 7: Onboarding client page, components, and hooks

**Dependencies:** Step 4 (shared contracts) only — proceeds in parallel with Step 6 against mocked API responses
**Owned paths:** `client/src/app/repos/[repoId]/onboarding-tour/page.tsx` (new), `client/src/app/repos/[repoId]/onboarding-tour/_components/**` (new — `OnboardingTourView`, `ArchitectureSection`, `CriticalPathsSection`, `HowToRunSection`, `ReadingPathSection`, `FirstTasksSection`, shared `SectionCard` chrome, `LiteBadge`/`DegradedBadge`), `client/src/lib/hooks/onboarding.ts` (new), `client/src/vendor/ui/nav.ts` (add one `NavItemDef` entry), `client/messages/en/onboarding.json` (new i18n namespace, or extend an existing one if the project convention groups by page rather than by feature — verify against `context.json`/`blast` namespace pattern before creating a new file)

**What to do:**
1. **`page.tsx`** — async Server Component, `await params`, hands `repoId` to a client view component. Mirrors `context/page.tsx` exactly (per `client/insights.md` 2026-07-03 Decision — this is the correct, if unusual-in-this-codebase, pattern to follow for NEW pages).
2. **`nav.ts`** — add `{ key: "onboarding-tour", label: "Onboarding Tour", icon: <pick an existing IconName, e.g. "BookOpen" or "Compass" — verify it exists in `vendor/ui/icons.tsx` before using>, href: "/repos/:repoId/onboarding-tour", gKey: "o" }` under the `WORKSPACE` section, positioned BETWEEN `pulls` and `context` per spec §5 ("between 'Pull Requests' and 'Project Context'"). Also add the matching entry to `SHORTCUTS` (`{ keys: "g o", label: "Go to Onboarding Tour", group: "Navigation" }`). Per the `client/insights.md` 2026-07-03 Mistake entry, DOUBLE-CHECK this task's own owned-paths list actually includes `nav.ts` (it does, here) rather than deferring it to a later step that never claims it.
3. **`hooks/onboarding.ts`**:
   - `useOnboardingTour(repoId)`: `useQuery({ queryKey: ["onboarding", repoId], queryFn: () => api.get<OnboardingTour>(`/repos/${repoId}/onboarding`), enabled: !!repoId, staleTime: 5 * 60 * 1000 })` — mirrors `useBlast`.
   - `useGenerateOnboardingTour(repoId)`: `useMutation` wrapping `api.post<OnboardingTour>(`/repos/${repoId}/onboarding/generate`)`, invalidating/`setQueryData`-updating the `["onboarding", repoId]` cache key on success so the page re-renders with the fresh tour without a second fetch round-trip.
4. **`OnboardingTourView.tsx`** (container component — fetches, owns loading/error/empty branching per react-best-practices):
   - Header: title "Onboarding for `<repo>`" (repo name in accent color via existing typographic convention — check `PrDetailHeader` for the accent-color pattern already used for repo/PR titles), subtitle "Generated from index of N files · last refreshed `<time>` ago" (compute relative time client-side from `generated_at`; N files = index state's `filesIndexed`, fetched alongside or piggy-backed on the tour response's `index` field — if `filesIndexed` isn't already on `OnboardingIndexInfo`, that's fine, omit the N-files clause gracefully rather than adding scope to Step 4's contract; render "Generated from repository index" as a fallback string when the count isn't available).
   - Two top-right actions: "Regenerate" (calls `useGenerateOnboardingTour().mutate()`, disabled/spinner while pending) and "Share link" (copies `window.location.href` to clipboard via `navigator.clipboard.writeText` — AC-15, no new API call).
   - "ON THIS PAGE" table of contents — static list of the 5 section titles in fixed order, anchor-linking to each `SectionCard`.
   - Empty/lite/degraded state handling: when `data.generated_at === null` (never generated) AND no clone/index exists, render section skeletons + a prominent "Clone & index for full tour" CTA button that calls the EXISTING `POST /repos/:id/resync` endpoint (already implemented — `repo-intel/routes.ts`, reused here, NOT a new endpoint) — satisfies AC-10 without inventing new API surface.
   - Loading-in-progress state: while `useGenerateOnboardingTour` mutation is pending, keep rendering the PREVIOUSLY loaded `data` from `useOnboardingTour`'s cache (React Query naturally keeps stale data visible during a separate mutation — no extra state needed) plus a small non-blocking in-progress indicator near the Regenerate button (spec §6 loading state — AC is satisfied by NOT clearing the query cache during the mutation, which is the default TanStack Query behavior as long as the component doesn't manually null out state).
   - Error state (AC-18): on `useGenerateOnboardingTour` mutation error, keep the last successful `useOnboardingTour` data rendered (again, default behavior — the query cache is untouched by a failed mutation) and show an inline error banner with a "Retry" button that re-invokes `mutate()`.
5. **Section components** — each receives its slice of `OnboardingSection` + shared props (`link` info for blob URLs, `degraded`/`mode` flags for section-level "based on limited data" framing in lite mode per §8):
   - `ArchitectureSection`: renders `body` as markdown (reuse whatever markdown renderer the project already uses — check `IntentCard.tsx`/`VerdictBanner` for an existing markdown-rendering dependency before adding a new one) + the `diagram` field rendered via the project's existing mermaid-rendering approach if one exists, else a fenced code block fallback (verify: grep for any existing mermaid client renderer before assuming one needs to be added — if none exists, rendering as a labeled `<pre>` block with the raw mermaid source is an acceptable v1 fallback, NOT a blocker for this plan, and should be called out as a follow-up rather than scope-creeping this step).
   - `CriticalPathsSection`: rows of `path` + `rationale` + "Open" action using `entry.github_link` directly (already resolved server-side, AC-8/AC-9 — render the Open action ONLY when `github_link` is non-null).
   - `HowToRunSection`: numbered list from `entries`, each row rendered as a copyable shell command with a copy-to-clipboard `IconBtn` (reuse the existing copy-to-clipboard pattern — grep for `navigator.clipboard` usage elsewhere in the client for the established micro-pattern, e.g. in `PromptBlock`/`TraceBody`, before writing a new one).
   - `ReadingPathSection`: numbered list ordered exactly as the server returned it (NEVER client-side re-sorted — AC-7 is a server-side invariant; the client must not alphabetize or otherwise reorder `entries`), each with rationale beneath.
   - `FirstTasksSection`: horizontal cards with title, muted target path, complexity badge using the NEW feature-local `COMPLEXITY` token map (Low→`--sugg`, Medium→`--warn`, High→`--crit`, shape mirrors `SEV` from `client/src/vendor/ui/primitives/tokens.ts` but defined locally in this feature's folder, e.g. `_components/OnboardingTourView/constants.ts`, per the promotion rule — do not add to the shared `tokens.ts` for a single consumer).
   - `SectionCard`: shared chrome wrapping every section — header with title + collapse/expand toggle (local `useState`, no persistence needed per spec) + degraded/lite badge reusing the exact `s.degradedBadge` visual pattern from `BlastRadiusCard.tsx` (same CSS-in-JS shape, same `Icon.AlertTriangle`, same `role="status"` accessibility pattern).
6. **i18n**: all user-facing strings (section titles, badge labels, CTA text, empty-state copy, error messages) go through `useTranslations()` with keys in the new/extended message namespace — never hardcoded, per `client/insights.md` 2025-06-01 Mistake entry.

**Verify:**
- [ ] Compiles (`cd client && pnpm typecheck`)
- [ ] `cd client && pnpm test` — hermetic Vitest+RTL tests pass with `fetch` mocked (see Testing Plan)
- [ ] No hardcoded English strings — grep the new `_components/` tree for bare string literals in JSX text positions
- [ ] `nav.ts` diff includes the new item (self-check against the documented past mistake of deferring nav wiring)
- [ ] Reading-path order in the rendered DOM matches `entries` array order exactly (no client-side sort)

**Commit:** `feat(onboarding): add Onboarding Tour page, section components, and hooks`

---

### Step 8: Integration closer — wiring verification + i18n completeness

**Dependencies:** Step 6 AND Step 7 both complete
**Owned paths:** none exclusively — this step is a verification/small-fixup pass across files already owned by Steps 6/7; any edit here must stay within those already-touched files (no new files)

**What to do:**
1. Run the full server hermetic suite + client test suite together; fix any integration seam issues surfaced only when both sides exist (e.g. a contract field the client expects that the server didn't populate, or vice versa — should be rare given Step 4 was the single source of truth for both).
2. Manually verify (dev server, `./scripts/dev.sh`) the full click path once: navigate via the new sidebar item → see empty/lite state on an unindexed seeded repo → trigger "Clone & index" → after indexing, "Regenerate" → confirm 5 sections render, reading path is rank-ordered, Critical path entries have working GitHub links, degraded badge behavior matches index status. This is the manual acceptance run named in AC-17 — document the outcome in the PR description, not in a new file.
3. Confirm the server log line from Step 6.4.i actually appears with cost-in-cents on a real generation against a seeded repo (AC-6 observability check).

**Verify:**
- [ ] `cd server && pnpm exec vitest run --exclude '**/*.it.test.ts'` — full suite green
- [ ] `cd client && pnpm test` — full suite green
- [ ] `cd server && pnpm typecheck` && `cd client && pnpm typecheck` — both green
- [ ] Manual AC-17 walkthrough completed against a seeded indexed repo, one LLM call confirmed in logs with cost in cents

**Commit:** `chore(onboarding): integration verification pass` (only if any fixup edits were needed — otherwise no commit, this step is a gate not guaranteed to produce a diff)

---

## 6. Acceptance Criteria — Traceability

| AC | Requirement (summary) | Satisfied by | Test |
|---|---|---|---|
| AC-1 | 5 sections, fixed order | Step 6.4 (`generateTour` builds exactly 5 sections from the fixed `OnboardingSectionKind` enum), Step 7.4 (TOC + section render order) | Hermetic: assert `sections.length === 5` and kind order; RTL: TOC renders 5 items in order |
| AC-2 | Persisted tour renders without new generation | Step 6.4.a (`getTour` is read-only, no generation side effect) | Hermetic: `GET` does not call the mock LLM provider |
| AC-3 | Regenerate → 1 LLM call, fresh timestamp | Step 6.4.b–j (`generateTour` orchestration) | Hermetic: mock LLM call-count assertion; `generated_at` changes across two calls |
| AC-4 | Facts/ranking/reading-path = zero LLM | Steps 5, 6.4.c/d (all fact gathering via `repoIntel.*`/GitHub adapter, no LLM) | Hermetic: fact-gathering helpers invoked with LLM provider never called |
| AC-5 | Exactly one LLM call per generation (full or lite) | Step 6.4.f (single `completeStructured` call site) | Hermetic: call-count assertion in both full-mode and lite-mode test cases |
| AC-6 | Log one LLM call + cost in cents | Step 6.4.h–i | Hermetic: log line assertion (mock/child logger spy) with `llm_cost_cents` present |
| AC-7 | Reading path ordered by rank desc, never alphabetical | Step 6.4.g (rank attached from `getTopFilesByRank`'s already-ranked order), Step 7.5 `ReadingPathSection` (no client re-sort) | Hermetic: server test with out-of-alphabetical-order ranked fixture asserts response order matches rank; RTL: DOM order matches prop order |
| AC-8 | GitHub blob link on resolvable entries | Step 6.4.g (`mapGithubLink`) | Hermetic: entry with resolvable path gets non-null `github_link` matching the blob URL pattern |
| AC-9 | No Open action when unresolvable | Step 6.4.g (`mapGithubLink` returns null), Step 7.5 `CriticalPathsSection` (conditional render) | Hermetic: entry with no repo basics/sha gets `github_link: null`; RTL: no Open button rendered for null-link entry |
| AC-10 | Lite mode + CTA on no clone/index | Step 6.4.d (lite-mode fact gathering), Step 7.4 (CTA calling existing `/resync`) | Hermetic: `getIndexState` degraded/no-data → service takes lite branch, `mode: 'lite'` in response; RTL: CTA button renders and posts to `/resync` |
| AC-11 | Partial/degraded → badge, tour still generated | Step 6.4.b–c (index-state branching keeps generating), Step 7.5 `SectionCard` degraded badge | Hermetic: `partial`/`degraded` index states both produce a non-empty tour with `degraded: true`; RTL: badge renders |
| AC-12 | No data anywhere → deterministic skeleton | Step 6.4.e | Hermetic: full mode unavailable AND mocked GitHub calls fail → response has 5 sections with "not enough data" bodies, LLM provider never called |
| AC-13 | Facts derived only from the selected repo (exclude gitignored/nested/dependency paths) | Step 2 (walk.ts hardening) | Hermetic: `walkClone` test fixtures with a `.gitignore`'d dir and a nested-`.git` subdir, both excluded from result |
| AC-14 | Full-mode fact-gathering uses a managed clean clone, never an arbitrary working tree | Step 6.4.c (reads via `container.git`/clone path from `getRepoBasics`, never an ad hoc filesystem path) | Hermetic: service test asserts the clone-path passed to file reads comes from `repo.clonePath`, not a hardcoded/arbitrary path |
| AC-15 | Share link copies a deep-link URL | Step 7.4 (`navigator.clipboard.writeText(window.location.href)`) | RTL: click handler calls the mocked clipboard API with the current URL |
| AC-16 | Rate-limited generation (no unlimited-click fan-out) | Step 6.5 (`config.rateLimit: { max: 3, timeWindow: '1 minute' }`, per-workspace) | Hermetic: 4th rapid `POST .../generate` inject call within a window returns 429 |
| AC-17 | Manual acceptance run on a real indexed repo | Step 8.2 | Manual walkthrough (not automated) — documented in PR description |
| AC-18 | Hard failure after prior success keeps last good tour + inline retry | Step 6.4.k (service never overwrites on failure), Step 7.4 (client keeps cached data + retry banner on mutation error) | Hermetic: service test — failing generation after a persisted row leaves the row unchanged; RTL: mutation error keeps rendering previous `data`, shows retry button |

## 7. Testing Plan

**Critical instruction for whoever writes the analyzer/service tests**: derive test cases from the spec's ACs and Edge Cases table (§14/§15 of the spec) FIRST, before looking at how the implementation actually works internally. A test suite written by reading the implementation only confirms the code does what it does — it will not catch a case the implementation silently omits (e.g. AC-12's "no data anywhere" skeleton path, which is easy to forget once full/lite mode "usually" work). Write the AC-derived test list, THEN implement against it.

**Server:**

| Test | Type | Covers |
|---|---|---|
| `walk.test.ts` — gitignored dir excluded | hermetic | AC-13 |
| `walk.test.ts` — nested `.git` subtree excluded | hermetic | AC-13, AC-14 |
| `walk.test.ts` — no `.gitignore` present, no regression | hermetic | AC-13 (negative case) |
| `onboarding-repository.test.ts` — workspace-scoped read (cross-workspace → null) | hermetic | data isolation (security, not a numbered AC but mandatory per R1) |
| `onboarding-service.test.ts` — full mode: facts gathered, exactly 1 LLM call, rank-ordered reading path | hermetic | AC-4, AC-5, AC-7 |
| `onboarding-service.test.ts` — lite mode: no clone → GitHub Trees/Contents used, `mode: 'lite'`, reading path `rank: null` | hermetic | AC-10 |
| `onboarding-service.test.ts` — partial/degraded index still generates + badges | hermetic | AC-11 |
| `onboarding-service.test.ts` — no clone AND GitHub fails → skeleton, zero LLM calls | hermetic | AC-12 |
| `onboarding-service.test.ts` — entry with resolvable location gets github_link; entry without gets null | hermetic | AC-8, AC-9 |
| `onboarding-service.test.ts` — regenerate overwrites with fresh timestamp, no history kept | hermetic | AC-3 |
| `onboarding-service.test.ts` — generation failure after prior success does not overwrite persisted row | hermetic | AC-18 |
| `onboarding-routes.test.ts` — `GET` never generated → well-formed empty response, not an error | hermetic | AC-2 (inverse), §7 |
| `onboarding-routes.test.ts` — `GET` persisted tour, no LLM call triggered | hermetic | AC-2 |
| `onboarding-routes.test.ts` — cross-workspace `GET`/`POST` → 404 | hermetic | security / workspace isolation |
| `onboarding-routes.test.ts` — 4th rapid `POST generate` within a minute → 429 | hermetic | AC-16 |
| `onboarding-routes.test.ts` — log line contains `llm_cost_cents` after generation | hermetic | AC-6 |
| `repo-intel-file-facts.test.ts` — `getAllFileFacts` returns full inventory, no per-symbol filtering | hermetic | supports AC-1 (routes/APIs section content), not independently AC-numbered |
| `github-adapter.test.ts` (extends existing octokit test file if present) — `getRepoTree`/`getFileContents` happy path + 404-returns-null | hermetic | supports AC-10 |

**Client:**

| Test | Type | Covers |
|---|---|---|
| `OnboardingTourView.test.tsx` — renders 5 sections in TOC + body order | RTL, fetch mocked | AC-1 |
| `OnboardingTourView.test.tsx` — persisted tour on mount does not call generate mutation | RTL | AC-2 |
| `OnboardingTourView.test.tsx` — Regenerate click calls generate endpoint, updates "last refreshed" | RTL | AC-3 |
| `ReadingPathSection.test.tsx` — DOM order matches prop array order exactly (no re-sort) | RTL | AC-7 |
| `CriticalPathsSection.test.tsx` — Open action present iff `github_link` non-null | RTL | AC-8, AC-9 |
| `OnboardingTourView.test.tsx` — lite/no-index state shows CTA, CTA posts to `/resync` | RTL, fetch mocked | AC-10 |
| `SectionCard.test.tsx` — degraded badge renders when `index.degraded` or `status === 'partial'` | RTL | AC-11 |
| `OnboardingTourView.test.tsx` — Share link calls clipboard with current URL | RTL, clipboard mocked | AC-15 |
| `OnboardingTourView.test.tsx` — mutation error keeps last-good data + shows retry, retry re-invokes mutate | RTL | AC-18 |
| `FirstTasksSection.test.tsx` — complexity badge color maps Low/Medium/High to the local `COMPLEXITY` tokens correctly | RTL | UX requirement (§5), color-token traceability for the resolved `[NEEDS CLARIFICATION]` item |

**Manual (not automated):** AC-17 — full acceptance run against a real seeded, indexed open-source repo per Step 8.2. Document pass/fail in the PR description; do not attempt to script this in CI for this plan.

## 8. Out of Scope

- Automatic/continuous regeneration on repo changes (manual "Regenerate" only, per spec Non-goals).
- Any spec-conformance or merge-blocking behavior.
- Multi-repo comparison or cross-repo tours.
- Hand-editing generated tour content.
- More than one LLM call per generation, or sending full file contents to the LLM.
- A hotness/churn signal in the ranking formula — `hotness` stays hardcoded `0`; this plan does NOT add git-churn analysis anywhere, including to `repo-intel`'s existing rank computation.
- Reading `.gitignore`-excluded/nested-repo/dependency-folder content for any repo other than the selected one (Step 2 hardens exactly this boundary and no further).
- Adding a client-side mermaid renderer if none currently exists in the codebase — Step 7.5 explicitly allows a raw-source fallback and flags a proper renderer as a future follow-up, not part of this plan's scope.
- Nested-`.gitignore`-file merging beyond the root-level check (Step 2 treats deep per-directory `.gitignore` merging as best-effort/optional, with the root-level check as the mandatory AC-13 baseline).
- Per-repository (as opposed to per-workspace) rate-limit scoping on the generation endpoint — explicitly decided as per-workspace in this plan.
- Async/poll-based generation endpoint — this plan chooses synchronous return of the refreshed tour (spec §7 permits either); polling can be added later without a breaking contract change if generation latency becomes a problem.
