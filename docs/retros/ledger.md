# Workflow retro ledger

One row per analyzed run, appended by /workflow-retro (newest last). Costs are API-list estimates.

| Date | Run | Sessions | Contexts | In (uncached) | Cache-write | Cache-read | Out | Cache-hit | Est. cost | Max ∥ | Top action |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-07-09 | Skill Eval Pipeline implementation | b56f0d8d | 21 | 231.6k | 7.59M | 225.53M | 524.0k | 96.7% | $166.85 | 3 | Delegate more step-work out of main — 77% of cost sat in the orchestrator, not the 20 subagents |
