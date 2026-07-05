# insights.md — evals

> Append-only. Add new entries at the bottom of the correct section.
> Discovery bar: "Would a fresh agent save ≥10 minutes from reading this?" If not, skip.
> Format: `**YYYY-MM-DD [Category]** — actionable sentence. `file:line``
> See `.claude/skills/engineering-insights/` for full criteria and format rules.

## Patterns
<!-- Reusable approaches that worked in this module. -->
- **2026-07-05 [Pattern]** — CI trigger logic is fully verifiable locally, no push needed: set `CHANGED_FILES` (newline-separated), point `GITHUB_OUTPUT` and `GITHUB_STEP_SUMMARY` at temp files, run `node scripts/ci-detect.mjs`, then assert on the two files' contents. This loop caught a real bug (`.claude/agents/README.md` matched the agent regex → phantom "README" agent + spurious expensive workflow-tier trigger) before it ever reached GitHub. `evals/scripts/ci-detect.mjs:25`

## Mistakes
<!-- Failure modes, antipatterns, wrong assumptions. Prioritize this section. -->

## Decisions
<!-- Architectural or design choices with the reasoning behind them. -->

## Quirks
<!-- Dependency gotchas, env constraints, non-obvious tool or library behavior. -->
- **2026-07-05 [Quirk]** — `eval:quality` parses SKILL.md frontmatter with `gray-matter`/`js-yaml` (strict YAML), which crashes with an uncaught `YAMLException` — aborting the entire run, not just that skill — when a `description:` field contains an unquoted `: ` (colon-space), e.g. `Use when: (1)`. The Claude Code harness parses the same frontmatter leniently and loads the skill fine, so the bug is invisible until the eval runs. Fix: remove colon-space (use `—`) or quote the whole value. `evals/src/skill-quality.ts:39` *(2026-07-05: guarded — `evaluate()` now catches the parse error and FAILs only that skill; the run no longer aborts.)*
- **2026-07-05 [Quirk]** — On Windows, `pnpm exec vitest ...` spawned from `runVitestOnce`/`countTests` throws `Error: spawn pnpm ENOENT` because `pnpm` is a `.cmd` shim and Node's `spawn`/`execFileSync` don't resolve `PATHEXT` without `shell: true`. Crashes `eval:benchmark`/`eval:repeat` immediately on Windows. Fix: `shell: process.platform === "win32"` on both calls. `evals/src/run-vitest.ts:19,36`
- **2026-07-05 [Quirk]** — Workflow `trace`/`contrast` cases assert `expectFilesRead` via `filesRead.some(f => f.includes(file))`, but on Windows the `Read` tool's `file_path` arrives as an absolute backslash path (`F:\...\pipeline.md`) while every `expectFilesRead` in `cases.ts` is authored POSIX-style (`"reviewer-core/docs/pipeline.md"`) — `.includes()` never matches, so a case can fail even though the model read exactly the right file. Confirmed via trace: `reads:` listed the exact expected file (Windows-style) yet the assertion still read `false`. Fix: normalize backslashes to forward slashes at the single capture point. `evals/src/runtime/run-claude.ts:112`
- **2026-07-05 [Quirk]** — `eval:quality` link checks can pass on Windows yet fail on Linux CI when the git index holds a different-case filename than the link target (first hit: index had `templates/INSIGHTS.md`, SKILL.md linked `templates/insights.md`). Windows resolves case-insensitively; the CI checkout materializes the index's casing. Diagnose with `git ls-files <dir>` vs disk; fix with `git mv` (case-only renames are invisible to `git status` on Windows). `evals/src/skill-quality.ts:50`

## Open Questions
<!-- Unresolved. Convert to an entry in the appropriate section when answered. -->

---
Last updated: 2026-07-05 · Entries: 5
