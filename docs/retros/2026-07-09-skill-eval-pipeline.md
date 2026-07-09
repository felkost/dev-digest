# Retro: Skill Eval Pipeline implementation — 2026-07-09

**Sessions:** b56f0d8d-d034-400d-8c26-8dbdb581cf86 · **Plan:** docs/plans/2026-07-06-skill-eval-pipeline.md · **Mode:** deep

> The analyzed run itself took place 2026-07-07 (session wall-clock span ~17h). This retro was run 2026-07-09 from the `workflow-retro-list-7f2270` worktree against the main project's session history (`--project` override — this worktree has its own isolated `~/.claude/projects/<slug>` folder, so the default session list only shows itself).

## Metrics

| context | model | API calls | in (uncached) | cache-write | cache-read | out | cache-hit | wall | est. cost |
|---|---|---|---|---|---|---|---|---|---|
| main | claude-opus-4-8,\<synthetic\>,claude-sonnet-5 | 339 | 47.6k | 4.40M | 145.96M | 469.1k | 97.0% | 1177m49s | $128.95 |
| implementer — Fix B: AC-33 cost + AC-30 read-back | claude-sonnet-5,\<synthetic\> | 2 | 1 | 18.4k | 12.1k | 4 | 39.7% | 6s | $0.07 |
| implementer — Fix A: AC-2/AC-3 create validation | claude-sonnet-5,\<synthetic\> | 5 | 8.9k | 68.7k | 135.7k | 13 | 63.6% | 43s | $0.33 |
| plan-verifier — Completeness gate pass 1 | claude-sonnet-5 | 34 | 11.0k | 261.6k | 3.72M | 7.2k | 93.2% | 6m59s | $2.24 |
| implementer — Step 6: skill-eval routes | claude-sonnet-5 | 28 | 3.9k | 170.1k | 3.94M | 1.8k | 95.8% | 6m38s | $1.86 |
| implementer — Step 5: service + orchestrator | claude-sonnet-5 | 52 | 29.1k | 251.1k | 10.01M | 3.0k | 97.3% | 13m33s | $4.08 |
| implementer — Step 2: skill-eval shared contracts | claude-sonnet-5 | 13 | 4.9k | 88.2k | 1.06M | 1.7k | 91.9% | 3m07s | $0.69 |
| plan-verifier — Final verification pass | claude-sonnet-5 | 19 | 5.8k | 96.8k | 1.33M | 3.1k | 92.8% | 4m01s | $0.83 |
| test-writer — Test coverage audit skill-eval | claude-sonnet-5 | 48 | 7.6k | 305.8k | 5.58M | 2.8k | 94.7% | 19m25s | $2.89 |
| implementer — Step 4: SkillEvalRepository | claude-sonnet-5 | 18 | 3.8k | 119.2k | 1.82M | 2.3k | 93.7% | 3m21s | $1.04 |
| general-purpose — Bug finder: server correctness | claude-opus-4-8 | 9 | 16.7k | 88.9k | 549.4k | 2.0k | 83.9% | 1m54s | $0.96 |
| implementer — Step 1: skill_eval_batches migration | claude-sonnet-5 | 27 | 6.1k | 103.2k | 2.40M | 3.4k | 95.6% | 4m22s | $1.18 |
| implementer — Skill-eval trend/compare/clear-history: client | claude-sonnet-5 | 64 | 9.2k | 269.4k | 11.33M | 2.8k | 97.6% | 20m23s | $4.48 |
| general-purpose — Bug finder: client + cleanup | claude-opus-4-8 | 15 | 12.7k | 51.8k | 828.3k | 282 | 92.8% | 8m06s | $0.81 |
| implementer — Step 8: EvalsTab UI rewrite | claude-sonnet-5 | 84 | 7.7k | 236.2k | 15.26M | 5.0k | 98.4% | 16m00s | $5.56 |
| implementer — Step 9: HostAgentSelect | claude-sonnet-5 | 32 | 6.3k | 123.7k | 3.48M | 2.7k | 96.4% | 7m55s | $1.57 |
| architecture-reviewer — Architecture review skill-eval | claude-sonnet-5 | 18 | 5.7k | 120.1k | 1.45M | 3.8k | 92.0% | 2m47s | $0.96 |
| implementer — Step 7: client skill-eval hooks | claude-sonnet-5 | 21 | 5.9k | 122.2k | 2.20M | 2.3k | 94.5% | 3m46s | $1.17 |
| implementer — Step 3: skill-eval scoring | claude-sonnet-5 | 24 | 28.6k | 132.8k | 2.61M | 1.8k | 94.2% | 3m58s | $1.39 |
| implementer — Skill-eval trend/compare/clear-history: server | claude-sonnet-5 | 49 | 6.0k | 429.1k | 8.38M | 6.5k | 95.1% | 15m42s | $4.24 |
| implementer — Step 10: seed skill-eval cases | claude-sonnet-5 | 31 | 4.4k | 127.2k | 3.48M | 2.5k | 96.4% | 5m26s | $1.57 |
| **TOTAL** | | 932 | 231.6k | 7.59M | 225.53M | 524.0k | 96.7% | | **$166.85** |

Subagent share of cost: 22.7% — this is what the parent context never sees; in-context estimates undercount total spend by exactly this share.

Parallelism: 20 subagents, max concurrent 3, sum-of-wall 148m12s over a 1020m55s span (factor 0.1×).

Tool calls: Read:466 · Bash:281 · Grep:201 · Edit:155 · Write:33 · Glob:29 · Agent:20 · PowerShell:7 · mcp__ccd_session__mark_chapter:4 · Skill:2 · AskUserQuestion:2 · ToolSearch:1 · TaskStop:1

Files Read in ≥3 contexts (pre-fetch / preload candidates):
- docs/plans/2026-07-06-skill-eval-pipeline.md — 15 contexts
- server/src/modules/skills/eval-service.ts — 12 contexts
- server/src/vendor/shared/contracts/skill-eval.ts — 10 contexts
- client/src/app/skills/_components/SkillDetail/EvalsTab.tsx — 10 contexts
- .claude/skills/engineering-insights/SKILL.md — 10 contexts
- server/insights.md — 9 contexts
- server/src/db/schema/eval.ts — 8 contexts
- client/src/lib/hooks/skills.ts — 8 contexts
- server/src/modules/skills/eval-scoring.ts — 8 contexts
- server/src/modules/skills/eval-orchestrator.ts — 8 contexts
- server/src/modules/skills/eval-repository.ts — 8 contexts
- server/src/modules/skills/eval-routes.ts — 8 contexts

## Insights

1. **Main context, not subagents, is the dominant cost center.** $128.95 of $166.85 (77%) sat in the orchestrator itself — subagent share is only 22.7% despite 20 dispatched agents carrying the actual implementation. 339 main-context API calls averaged ~430k cache-read tokens each, consistent with one long, continuously-growing context across the full ~17h session rather than short, delegated round-trips.
2. **The plan doc and core server modules were re-discovered independently, not shared.** `docs/plans/2026-07-06-skill-eval-pipeline.md` was read fresh in 15 of 21 contexts; six server modules (`eval-service.ts`, `eval-scoring.ts`, `eval-orchestrator.ts`, `eval-repository.ts`, `eval-routes.ts`, `schema/eval.ts`) were each read independently in 8+ contexts.
3. **Effective parallelism was near zero despite 20 subagents.** Max concurrent was only 3. The 10 "Step N" implementers form a genuine serial dependency chain (migration → repository → service → routes → client), so seriality there is largely expected — but the 5 independent QA/verification dispatches (plan-verifier ×2, test-writer, architecture-reviewer, general-purpose bug-finder ×2) share no file-write conflicts and still show no sign of having run together.
4. **A real, if small, rework loop.** plan-verifier's first completeness pass flagged gaps in AC-2/AC-3, AC-30, and AC-33, triggering two reactive "Fix" agents. Both are the coldest contexts in the run (39.7% and 63.6% cache-hit) — a freshly spawned reactive agent inherits no warm prefix.
5. **Low-cache-hit contexts are exactly the unplanned reactive ones.** Every planned Step/verifier/reviewer context sits at ≥91.9% cache-hit; only the two Fix agents and the server-correctness bug-finder (83.9%) fall below 90%.

## Recommendations

| # | Action | Target | Expected effect |
|---|---|---|---|
| 1 | Push more step-by-step editing into `implementer` dispatches; keep main to plan-following, review, and AC-gate checks only | how `/implement` drives execution — the main-loop/dispatch discipline, not any single agent file | shrinks the 77%-in-main cost skew; more of the $166.85 shifts into (cheaper, delegated) subagent contexts |
| 2 | Paste the relevant plan section + existing module excerpts directly into each `implementer`'s dispatch brief instead of letting it `Read` them fresh | the task-dispatch step where the plan hands work to an `implementer` | cuts most of the redundant Reads — the plan doc alone was reread ~14 times beyond the first |
| 3 | Batch the 5 independent QA/verification dispatches (plan-verifier ×2, test-writer, architecture-reviewer, bug-finder ×2) into one parallel wave — they are read-only reviewers with no cross-conflict | the QA/verification phase of the workflow (post-implementation review step) | wall-clock for that phase drops from a serial sum toward the single longest reviewer (~19m test-writer) |
| 4 | Have plan-verifier check acceptance criteria incrementally, at least right after the step that owns each AC, instead of only at the very end | plan-verifier's invocation point in the workflow | avoids cold-start "Fix" agents for gaps caught late — removes the 39.7%/63.6% cache-hit tax entirely |

## Follow-up
- [ ] Not yet applied — recommendations above are proposals pending user approval.
