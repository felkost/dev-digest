# Agents

Specialized AI agents for the Intent Layer. Each agent has a focused role and a restricted tool set.

## Setup

All agent definitions live in `.claude/agents/` (single source of truth). Each file is a Claude Code sub-agent invokable via `@agent-name`.

```
.claude/agents/          ← canonical agent definitions
.claude/skills/          ← shared skills loaded by agents via frontmatter
```

Claude Code uses:
- `skills:` frontmatter field to auto-load skills into agent context
- `tools:` frontmatter field to restrict available tools per agent
- `model:` frontmatter field to pin a specific model (or `inherit` to use the session model)

## Catalog

| Agent | Model | Scope | Writes? | Description |
|---|---|---|---|---|
| researcher | sonnet | Full-stack | No | Read-only scout — finds code patterns or web information, returns a structured report |
| planner | sonnet | Full-stack | No | Reads architecture + skills + module insights, asks structured questions, outputs a Development Plan |
| implementer | sonnet | Full-stack | Yes | Executes exactly one task from a Development Plan: detects domain, loads skills physically, implements, type-checks, self-reviews, runs hermetic tests |
| test-writer | sonnet | Full-stack | Yes | Writes unit and integration tests for client/ (RTL/Vitest) or server/ (Fastify inject()/Vitest); detects domain from file path |
| architecture-reviewer | sonnet | Full-stack | No | Read-only architectural audit — layer violations, import direction, side-effect contamination, project invariants |
| plan-verifier | sonnet | Full-stack | No | Read-only completeness check — verifies every requirement in a Development Plan has a corresponding implementation |
| doc-writer | sonnet | Full-stack | Yes | Generates and updates documentation — module READMEs, design docs, API references, Mermaid architecture diagrams |

## Pipeline: how the agents work together

```
researcher  →  planner  →  implementer (×N, parallel)
   (find)      (plan)         (build)
                  ↓               ↓
           plan-verifier    test-writer
                  ↓               ↓
        architecture-reviewer  doc-writer
```

1. **researcher** — understand what already exists before making decisions
2. **planner** — design the work, surface all constraints, produce an atomic task list
3. **implementer** — execute one task per instance; spawn N in parallel for N independent tasks
4. **test-writer** — add test coverage after implementation (or alongside it)
5. **plan-verifier** — confirm every plan requirement was implemented before closing a task
6. **architecture-reviewer** — periodic architectural health check; run after major features
7. **doc-writer** — convert plans and implementations into permanent documentation

---

## researcher

The primary information-gathering agent. Use **before** planning or implementing — when you need to understand what already exists or gather external context. It will:

- Ask clarifying questions if the request is vague (interview mode)
- Search the codebase with `Glob`, `Grep`, `Read`, `Bash`
- Search the web with `WebSearch` + `WebFetch`
- Return a structured report (Format A for codebase, Format B for web)
- Explicitly flag what was searched but not found

**Skill routing:** no domain-specific skills — it reads raw code and web pages. Read-only by design: omitting `Edit`/`Write` from `tools:` prevents it from acting on what it finds.

Use when:
- You need to understand how a module is implemented before touching it
- You want to find all usages of a symbol, pattern, or convention
- You need external documentation (library version, API shape, best practice)
- A planner needs a codebase snapshot before writing a plan

**Based on:**
- [Claude Code sub-agents documentation](https://code.claude.com/docs/en/sub-agents)
- [PubNub — Best practices for Claude Code sub-agents](https://www.pubnub.com/blog/best-practices-for-claude-code-sub-agents/)
- Structured reporting pattern: citation-first output ("a finding without a citation is an opinion") borrowed from scientific peer-review norms and adapted for codebase analysis

---

## planner

The development planning agent. Use **after** gathering context and **before** implementing — when you need a structured Development Plan that an implementer can execute. It will:

- Read AGENTS.md files for all affected modules
- Read each affected module's `insights.md` to surface non-obvious constraints (Mode C of engineering-insights)
- Load relevant skills based on scope (server / client / DB / reviewer-core)
- Ask structured questions across 5 categories (one at a time)
- Confirm understanding before writing the plan
- Output a Development Plan with 8 sections: Context, Architecture Fit, Skills Applied, Constraints, Steps, Acceptance Criteria, Testing Plan, Out of Scope

**Skill routing:** carries the same full skill set as the implementer so it plans with complete awareness of every constraint the implementer will enforce. Skill set adapts to scope: always loads `typescript-expert` + `security`; adds Fastify/Drizzle/Zod for server work, React/Next.js for client work.

Use when:
- Starting a new feature or endpoint
- Making a significant change that touches multiple files or layers
- You need the plan to be precise enough for an implementer agent with no prior context
- You want to surface all project constraints before any code is written

**Based on:**
- [Claude Code sub-agents documentation](https://code.claude.com/docs/en/sub-agents)
- [PubNub — Best practices for Claude Code sub-agents](https://www.pubnub.com/blog/best-practices-for-claude-code-sub-agents/)
- [dev.to — Clean Architecture in the age of AI: preventing architectural liquefaction](https://dev.to/uxter/clean-architecture-in-the-age-of-ai-preventing-architectural-liquefaction)
- [dev.to — Enforce Clean Architecture in TypeScript with fresh tools](https://dev.to/remojansen/enforce-clean-architecture-in-your-typescript-projects-with-fresh)
- ADR (Architecture Decision Records) methodology — each plan step is atomic, independently compilable, and produces a single commit; plan is the human-readable decision record

---

## implementer

The code execution agent. Use **after** a Development Plan exists and you have a specific task to assign. Each instance handles **exactly one task** — spawn N instances in parallel for N independent plan tasks. It will:

- Read the target module's `insights.md` (Mode C) before the first file edit
- Identify the assigned task by number/name in the plan
- Detect domain (server / client / both) from the task's file paths
- Read the relevant skill SKILL.md files physically before writing any code
- Read existing `*.test.ts` and `specs/` files to understand expected behavior
- Implement the task, running `pnpm typecheck` after implementation
- Self-review against the loaded skill rules (re-reads rule sections, not from memory)
- Run hermetic tests (`*.test.ts`) before reporting done
- Report `Skills applied:` — which skill files were physically read
- Capture discoveries via engineering-insights (Mode B) at session end

**Skill routing:**

| Scope | Skills loaded physically |
|---|---|
| `server/` | `backend-onion-architecture`, `fastify-best-practices`, `zod`, `typescript-expert`, `security` |
| `server/` + DB | add `drizzle-orm-patterns`, `postgresql-table-design` |
| `client/` | `react-best-practices`, `next-best-practices`, `frontend-architecture`, `typescript-expert`, `security` |
| `client/` + tests | add `react-testing-library` |
| Full-stack | all of the above |

Use when:
- A Development Plan is ready and you have a specific task to execute
- You want to parallelize independent tasks across multiple implementer instances
- You need type-safe, convention-compliant code delivery with built-in verification
- You want the implementation verified against the project's skill rules automatically

**Based on:**
- [Claude Code sub-agents documentation](https://code.claude.com/docs/en/sub-agents)
- [PubNub — Best practices for Claude Code sub-agents](https://www.pubnub.com/blog/best-practices-for-claude-code-sub-agents/)
- [arxiv 2602.00409 — Tautological unit tests: when AI-generated tests pass but miss the bug](https://arxiv.org/html/2602.00409v1)
- [dev.to — When AI-generated tests pass but miss the bug (postmortem)](https://dev.to/jamesdev4123/when-ai-generated-tests-pass-but-miss-the-bug-a-postmortem-on-tautological-unit-tests-2ajp)
- [Callsphere — Mocking LLM calls: deterministic tests for AI agents](https://callsphere.ai/blog/unit-testing-ai-agents-mocking-llm-calls-deterministic-tests)
- [Mergify — Flaky tests in Vitest](https://mergify.com/flaky-tests/vitest/)
- Self-review pattern: "re-read the rules section physically, not from memory" — anti-hallucination discipline borrowed from citation-first research methodology

---

---

## test-writer

Writes behavior-focused unit and integration tests. Detects whether the target file is frontend (`client/`) or backend (`server/`) and applies the matching strategy. Extends existing test files rather than overwriting them.

**Skill routing:**

| Domain | Skills loaded |
|---|---|
| `client/` (frontend) | `react-testing-library`, `react-best-practices` |
| `server/` (backend) | `server-testing`, `fastify-best-practices`, `drizzle-orm-patterns` |

Use when:
- A new module or component has no test file
- You want to extend existing tests with missing scenarios
- An implementer completes a task and tests are the next step

---

## architecture-reviewer

Read-only architectural auditor. Checks import direction, layer boundary violations, side-effect contamination in pure layers, and project-wide invariants defined in AGENTS.md. Never edits files.

**What it reports:** Critical / High / Medium / Low findings with file:line citations and remediation hints.

**Skill routing:** Loads `backend-onion-architecture` for layer boundary rules; `frontend-architecture` for client-side structure. No write tools are available — findings are reported only.

Use when:
- After a major feature is merged and you want an architectural health check
- Before a release to catch any layer violations introduced during fast iteration
- Onboarding new contributors — run it against a new module to verify it follows conventions

---

## plan-verifier

Read-only completeness auditor. Given a Development Plan, it searches the codebase for evidence that each requirement in Implementation Steps, Acceptance Criteria, and Testing Plan has been implemented. Reports ✅ Done / ⚠️ Partial / ❌ Missing per requirement.

**Skill routing:** No domain-specific skills — it reads plan documents, source files, and test files directly. Read-only by design: omitting `Edit`/`Write` from `tools:` prevents it from modifying files during verification.

Use when:
- An implementer has finished all tasks and you want to confirm completeness before closing the issue
- You want to catch requirements that were missed or only partially implemented
- A PR review needs a structured checklist against the plan

---

## doc-writer

Generates and maintains technical documentation. Detects the input type (plan, source code, routes, conversation) and writes to the correct location per the project's doc conventions. Includes Mermaid diagrams for architecture and API flows. Verifies all referenced code entities exist before writing.

**Skill routing:** No domain-specific skills loaded by default — it reads source files and plan documents directly. When the doc involves architecture decisions, the `backend-onion-architecture` or `frontend-architecture` skill may be consulted to ensure descriptions are accurate.

**Doc types produced:**
- `docs/design/` — architecture and design docs (from implementation plans or code)
- `docs/feature-requirements/` — feature specs (from conversation or requirement notes)
- `<package>/README.md` — module overviews (from source code)
- `docs/design/api-<module>.md` — API references (from route definitions)

Use when:
- A feature is complete and needs permanent documentation
- You want to convert an implementation plan into a design doc for future reference
- A module's README is missing or stale

---

## Validation after editing

Run these checks after modifying this file to confirm all required agents are present:

```bash
grep -c "## " .claude/agents/README.md
grep -q "test-writer" .claude/agents/README.md || echo "MISSING test-writer"
grep -q "architecture-reviewer" .claude/agents/README.md || echo "MISSING architecture-reviewer"
grep -q "plan-verifier" .claude/agents/README.md || echo "MISSING plan-verifier"
grep -q "doc-writer" .claude/agents/README.md || echo "MISSING doc-writer"
grep -q "skill routing" .claude/agents/README.md || echo "MISSING skill routing"
```

---

## Adding a new agent

1. Create `.claude/agents/<name>.md` with frontmatter in this order: `name`, `description`, `model`, `tools`, `skills:` (with inline `#` comments).
2. `name` must equal the filename stem exactly.
3. `description` is the trigger rule — write it as "Use when…" or "Read-only agent that…".
4. Omitting `Edit`/`Write` from `tools:` is what makes an agent read-only — do this deliberately.
5. Every skill in `skills:` must exist as a directory under `.claude/skills/`.
6. Add a row to the Catalog table above and a `## <name>` section with "What it does", "Skill routing", "Use when", and "Based on:" subsections.
7. Verify: `grep -qE "^name: <name>$" .claude/agents/<name>.md || echo "NAME MISMATCH"`
