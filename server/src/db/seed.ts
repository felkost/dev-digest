import 'dotenv/config';
import { createDb, type Db } from './client.js';
import * as t from './schema.js';
import { eq, and, sql } from 'drizzle-orm';
import {
  GENERAL_REVIEWER_PROMPT,
  SECURITY_REVIEWER_PROMPT,
  PERFORMANCE_REVIEWER_PROMPT,
  TEST_QUALITY_REVIEWER_PROMPT,
  API_CONTRACT_REVIEWER_PROMPT,
} from './seed-prompts.js';

/** Default provider/model for the built-in reviewer agents. */
const DEFAULT_PROVIDER = 'openrouter' as const;
const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';

/**
 * Seed the starter's demo data. Idempotent: re-running upserts the default
 * workspace/user and the demo fixtures.
 *
 * Seeds: default workspace + system user + membership, default settings,
 * demo repo (acme/payments-api), PR #482 with files/commits, a sample review
 * with a few findings, and the three built-in agents (General + Security +
 * Performance), all on the default openrouter/deepseek-v4-flash provider+model.
 *
 * Course lessons populate the other tables (skills, conventions, memory, eval,
 * …) once their features are built — they start empty here.
 */

export const DEFAULT_WORKSPACE_NAME = 'default';
export const SYSTEM_USER_EMAIL = 'you@local';

export async function seed(db: Db): Promise<{ workspaceId: string; userId: string }> {
  // ---- workspace + user (no-auth defaults) ----
  let [ws] = await db
    .select()
    .from(t.workspaces)
    .where(eq(t.workspaces.name, DEFAULT_WORKSPACE_NAME));
  if (!ws) {
    [ws] = await db
      .insert(t.workspaces)
      .values({ name: DEFAULT_WORKSPACE_NAME })
      .returning();
  }
  const workspaceId = ws!.id;

  let [user] = await db.select().from(t.users).where(eq(t.users.email, SYSTEM_USER_EMAIL));
  if (!user) {
    [user] = await db
      .insert(t.users)
      .values({ email: SYSTEM_USER_EMAIL, name: 'You' })
      .returning();
  }
  const userId = user!.id;

  await db
    .insert(t.workspaceMembers)
    .values({ workspaceId, userId, role: 'owner' })
    .onConflictDoNothing();

  // ---- default settings ----
  const defaultSettings: Record<string, unknown> = {
    polling_interval_min: 5,
    theme: 'dark',
    density: 'regular',
    sync_to_folder: true,
  };
  for (const [key, value] of Object.entries(defaultSettings)) {
    await db
      .insert(t.settings)
      .values({ workspaceId, userId, key, value })
      .onConflictDoNothing();
  }

  // ---- demo repo (acme/payments-api) ----
  let [repo] = await db
    .select()
    .from(t.repos)
    .where(and(eq(t.repos.workspaceId, workspaceId), eq(t.repos.fullName, 'acme/payments-api')));
  if (!repo) {
    [repo] = await db
      .insert(t.repos)
      .values({
        workspaceId,
        owner: 'acme',
        name: 'payments-api',
        fullName: 'acme/payments-api',
        defaultBranch: 'main',
        clonePath: null,
        createdBy: userId,
      })
      .returning();
  }
  const repoId = repo!.id;

  // ---- PR #482 (rate limiting) ----
  let [pr] = await db
    .select()
    .from(t.pullRequests)
    .where(and(eq(t.pullRequests.repoId, repoId), eq(t.pullRequests.number, 482)));
  if (!pr) {
    [pr] = await db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId,
        number: 482,
        title: 'Add rate limiting to public API endpoints',
        author: 'marisa.koch',
        branch: 'feat/rate-limit-public',
        base: 'main',
        headSha: 'a1b2c3d4e5f6',
        additions: 247,
        deletions: 38,
        filesCount: 9,
        status: 'needs_review',
        body: 'Add rate limiting to public API endpoints to prevent abuse from unauthenticated clients.',
      })
      .returning();

    // pr_files (subset — includes one file per role so Smart Diff demo shows all three groups)
    await db.insert(t.prFiles).values([
      {
        prId: pr!.id,
        path: 'src/middleware/ratelimit.ts',
        additions: 84,
        deletions: 0,
        pseudocodeSummary: 'New token-bucket limiter: read bucketKey → Redis INCR → if over limit return 429, else next().',
      },
      {
        prId: pr!.id,
        path: 'src/api/public/webhooks.ts',
        additions: 31,
        deletions: 6,
        pseudocodeSummary: 'Forward webhook to caller-supplied callback_url with account token attached.',
      },
      { prId: pr!.id, path: 'src/config.ts', additions: 4, deletions: 0 },
      { prId: pr!.id, path: 'src/api/users.ts', additions: 7, deletions: 2 },
      { prId: pr!.id, path: 'pnpm-lock.yaml', additions: 120, deletions: 3, patch: null },
    ]);

    // pr_commits
    await db.insert(t.prCommits).values({
      prId: pr!.id,
      sha: 'a1b2c3d4e5f6',
      message: 'Add token-bucket rate limiter',
      author: 'marisa.koch',
    });

    // intent seed — shows in IntentCard before a live review run
    await db.insert(t.prIntent).values({
      prId: pr!.id,
      intent: 'Add rate limiting to public API endpoints to prevent abuse',
      inScope: ['token-bucket rate limiter middleware', 'rate limit config per endpoint', 'webhook endpoint limits', 'user list endpoint limits'],
      outOfScope: ['authentication changes', 'database schema changes', 'frontend UI changes'],
    }).onConflictDoUpdate({
      target: t.prIntent.prId,
      set: {
        intent: sql`excluded.intent`,
        inScope: sql`excluded.in_scope`,
        outOfScope: sql`excluded.out_of_scope`,
      },
    });

    // a sample review + findings so the PR shows results before the first run
    const [review] = await db
      .insert(t.reviews)
      .values({
        workspaceId,
        prId: pr!.id,
        kind: 'review',
        verdict: 'request_changes',
        summary:
          'Solid middleware approach, but a Stripe secret key is committed in plaintext and the user-list endpoint introduces an N+1 query under the new limiter.',
        score: 61,
        model: 'seed',
      })
      .returning();

    await db.insert(t.findings).values([
      {
        reviewId: review!.id,
        file: 'src/config.ts',
        startLine: 12,
        endLine: 12,
        severity: 'CRITICAL',
        category: 'security',
        title: 'Hardcoded Stripe secret key in commit',
        rationale: 'Line 12 contains a literal `sk_live_` Stripe secret key.',
        suggestion: 'Move to env var and rotate the key immediately.',
        confidence: 0.98,
      },
      {
        reviewId: review!.id,
        file: 'src/api/users.ts',
        startLine: 45,
        endLine: 52,
        severity: 'WARNING',
        category: 'perf',
        title: 'N+1 query in user list endpoint',
        rationale: 'Loop issues one query per user → N+1.',
        suggestion: 'Use a single IN query and group in memory.',
        confidence: 0.86,
      },
    ]);
  }

  // Backfill pnpm-lock.yaml into pr_files for Smart Diff Boilerplate demo (idempotent)
  const [existingLock] = await db
    .select({ id: t.prFiles.id })
    .from(t.prFiles)
    .where(and(eq(t.prFiles.prId, pr!.id), eq(t.prFiles.path, 'pnpm-lock.yaml')));
  if (!existingLock) {
    await db.insert(t.prFiles).values({
      prId: pr!.id, path: 'pnpm-lock.yaml', additions: 120, deletions: 3, patch: null,
    });
  }

  // ---- built-in agents (the three starter presets) ----
  // Prompt bodies live in ./seed-prompts.ts (mirrored in docs/agent-prompts/*.md).
  const seedAgents: Array<typeof t.agents.$inferInsert> = [
    {
      workspaceId,
      name: 'General Reviewer',
      description: 'Reviews a PR diff for bugs, correctness, and clarity.',
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      systemPrompt: GENERAL_REVIEWER_PROMPT,
      enabled: true,
      version: 1,
      createdBy: userId,
    },
    {
      workspaceId,
      name: 'Security Reviewer',
      description: 'Flags secrets, injection, SSRF and the lethal trifecta before merge.',
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      systemPrompt: SECURITY_REVIEWER_PROMPT,
      enabled: true,
      version: 1,
      createdBy: userId,
    },
    {
      workspaceId,
      name: 'Performance Reviewer',
      description: 'Catches N+1 queries, missing indexes, and hot-path allocations.',
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      systemPrompt: PERFORMANCE_REVIEWER_PROMPT,
      enabled: true,
      version: 1,
      createdBy: userId,
    },
  ];
  for (const a of seedAgents) {
    const [existing] = await db
      .select()
      .from(t.agents)
      .where(and(eq(t.agents.workspaceId, workspaceId), eq(t.agents.name, a.name)));
    if (!existing) await db.insert(t.agents).values(a);
  }

  // ---- demo skills for Test Quality Reviewer ----
  const demoSkills = [
    {
      name: 'test-coverage-rubric',
      description: 'Flags missing branch coverage and untested error paths in new test code.',
      type: 'rubric' as const,
      source: 'manual' as const,
      body: `# Test Coverage Rubric

Evaluate the pull request for gaps in test coverage.

## Required checks

- **Branch coverage**: Every if/else, switch branch, early return, or ternary introduced by the diff must have at least one test for each outcome.
- **Error paths**: Every catch block or error-fallback introduced must be exercised by at least one test.
- **Negative cases**: If a function validates input or can throw/return null, there must be at least one test for the invalid/null input.

## Reporting rule

Report only branches introduced in THIS diff that have no matching test case. Do not report pre-existing coverage gaps.`,
    },
    {
      name: 'no-mock-overuse',
      description: 'Detects excessive mocking patterns that make tests pass trivially.',
      type: 'convention' as const,
      source: 'manual' as const,
      body: `# No Mock Overuse

Flag tests that rely on mocking in ways that make them trivially pass.

## Antipatterns to flag

1. **Mocking the system under test** — the test mocks the very function it is testing. The test cannot fail.
2. **Mock always returns success** — a mock configured to return \`{ ok: true }\` regardless of input makes the assertion meaningless.
3. **Mocking DB in integration tests** — integration tests (\`*.it.test.ts\`) must hit a real database via testcontainers. Mocking the DB there invalidates the test.
4. **Implementation-detail mock** — mocking a private method or internal state instead of the public boundary.

## Reporting rule

Flag each occurrence with the specific antipattern. Cite the mock setup line and the assertion that becomes meaningless as a result.`,
    },
    {
      name: 'boundary-cases',
      description: 'Ensures boundary and edge case inputs are exercised for each new function.',
      type: 'rubric' as const,
      source: 'manual' as const,
      body: `# Boundary Case Coverage

For every new function or modified function in the diff, verify that the following boundary inputs are exercised:

## Boundary checklist

- **Empty**: empty string \`""\`, empty array \`[]\`, empty object \`{}\`
- **Zero / negative**: numeric arguments at 0 and -1 (where the function accepts numbers)
- **Null / undefined**: optional parameters not passed, nullable fields set to null
- **Single element**: collection-processing functions tested with exactly one element
- **Exact limit**: if there is a size limit (e.g., \`max(100)\`), test at limit-1, limit, limit+1
- **Concurrent calls**: async functions called simultaneously — is the result deterministic?

## Reporting rule

For each function introduced in the diff, list which boundary cases are missing. Skip functions that are purely cosmetic refactors with no logic change.`,
    },
    {
      name: 'flaky-test-detector',
      description: 'Spots patterns that cause intermittent test failures.',
      type: 'convention' as const,
      source: 'manual' as const,
      body: `# Flaky Test Detector

Flag patterns that cause tests to pass sometimes and fail others.

## Patterns to flag

1. **Hardcoded Date.now() or new Date()** — asserts on a specific timestamp. Will fail at midnight, end of month, or year boundary.
2. **Math.random() without seeding** — non-deterministic values in assertions.
3. **setTimeout/setInterval without fake timers** — tests that rely on real wall-clock delays are inherently flaky in CI.
4. **Array/object order assumptions** — asserting \`expect(result[0]).toBe(x)\` on data returned from a query without an ORDER BY.
5. **Shared state between tests** — a \`beforeAll\` that writes data and an \`afterAll\` that reads it without cleanup; if tests run in a different order the setup may be missing.
6. **External network calls** — any \`fetch\` or HTTP call in a unit test without a stub.

## Reporting rule

Report the exact line of the flaky pattern and explain what triggers the intermittent failure.`,
    },
    {
      name: 'backend-api-conventions',
      description: 'Enforces Fastify route and repository conventions for server-side code.',
      type: 'convention' as const,
      source: 'manual' as const,
      body: [
        '# Backend API Conventions',
        '',
        'Apply when the diff touches `server/` files.',
        '',
        '## Routes',
        '- Every handler that needs workspace context MUST call `getContext()`.',
        '- Route handlers must not contain business logic — delegate to the service.',
        '- Business errors must be thrown as `AppError` (or its subclasses), never plain `Error`.',
        '',
        '## Repository',
        '- Every query MUST filter by `workspace_id` — no exceptions.',
        '- Never return raw DB rows — map to DTO in the service layer.',
        '',
        '## Secrets',
        '- Never read from `process.env` directly — use `SecretsProvider`.',
        '',
        '## Report',
        'Flag each violation with `file:line` and the exact rule broken.',
      ].join('\n'),
    },
  ];

  const skillIds: string[] = [];
  for (const s of demoSkills) {
    const [existing] = await db
      .select()
      .from(t.skills)
      .where(and(eq(t.skills.workspaceId, workspaceId), eq(t.skills.name, s.name)));
    if (existing) {
      skillIds.push(existing.id);
    } else {
      const [inserted] = await db
        .insert(t.skills)
        .values({ workspaceId, ...s, enabled: true, version: 1 })
        .returning();
      // Record initial version snapshot
      await db.insert(t.skillVersions).values({ skillId: inserted!.id, version: 1, body: s.body });
      skillIds.push(inserted!.id);
    }
  }

  // ---- Test Quality Reviewer agent (with attached skills) ----
  const tqrName = 'Test Quality Reviewer';
  let [tqrAgent] = await db
    .select()
    .from(t.agents)
    .where(and(eq(t.agents.workspaceId, workspaceId), eq(t.agents.name, tqrName)));
  if (!tqrAgent) {
    [tqrAgent] = await db
      .insert(t.agents)
      .values({
        workspaceId,
        name: tqrName,
        description: 'Reviews test quality: coverage gaps, over-mocking, boundary cases, flaky patterns.',
        provider: DEFAULT_PROVIDER,
        model: DEFAULT_MODEL,
        systemPrompt: TEST_QUALITY_REVIEWER_PROMPT,
        enabled: true,
        version: 1,
        createdBy: userId,
      })
      .returning();
  }

  // Attach all 4 skills to the Test Quality Reviewer (idempotent)
  if (tqrAgent && skillIds.length > 0) {
    for (const [i, skillId] of skillIds.entries()) {
      await db
        .insert(t.agentSkills)
        .values({ agentId: tqrAgent.id, skillId, order: i })
        .onConflictDoNothing();
    }
  }

  // ---- pr-self-review skills (frontend TS + backend API conventions) ----
  const psrSkillDefs = [
    {
      name: 'frontend-ts-conventions',
      description: 'Enforces TypeScript and React conventions for client-side code changes.',
      type: 'convention' as const,
      source: 'manual' as const,
      body: [
        '# Frontend TypeScript & React Conventions',
        '',
        'Apply when the diff touches `client/` or any `*.tsx?` file.',
        '',
        '## TypeScript',
        '- No `any` — use `unknown` and narrow, or a proper named type.',
        '- Prop interfaces must be named `<ComponentName>Props`.',
        '- No non-null assertion (`!`) unless provably safe from surrounding code.',
        '',
        '## React',
        '- No `useEffect` for data fetching — use TanStack Query hooks.',
        '- Add `"use client"` only at the lowest possible component boundary.',
        '- Keys in lists must be stable IDs, never array index.',
        '',
        '## Report',
        'Flag each violation with `file:line` and the exact rule broken.',
      ].join('\n'),
    },
    {
      name: 'backend-api-conventions',
      description: 'Enforces Fastify route and repository conventions for server-side code.',
      type: 'convention' as const,
      source: 'manual' as const,
      body: [
        '# Backend API Conventions',
        '',
        'Apply when the diff touches `server/` files.',
        '',
        '## Routes',
        '- Every handler that needs workspace context MUST call `getContext()`.',
        '- Route handlers must not contain business logic — delegate to the service.',
        '- Business errors must be thrown as `AppError` (or its subclasses), never plain `Error`.',
        '',
        '## Repository',
        '- Every query MUST filter by `workspace_id` — no exceptions.',
        '- Never return raw DB rows — map to DTO in the service layer.',
        '',
        '## Secrets',
        '- Never read from `process.env` directly — use `SecretsProvider`.',
        '',
        '## Report',
        'Flag each violation with `file:line` and the exact rule broken.',
      ].join('\n'),
    },
  ];

  const psrSkillIds: string[] = [];
  for (const s of psrSkillDefs) {
    const [existing] = await db
      .select()
      .from(t.skills)
      .where(and(eq(t.skills.workspaceId, workspaceId), eq(t.skills.name, s.name)));
    if (existing) {
      psrSkillIds.push(existing.id);
    } else {
      const [inserted] = await db
        .insert(t.skills)
        .values({ workspaceId, ...s, enabled: true, version: 1 })
        .returning();
      await db.insert(t.skillVersions).values({ skillId: inserted!.id, version: 1, body: s.body });
      psrSkillIds.push(inserted!.id);
    }
  }

  // ---- pr-self-review agent (auto-call disabled; full-stack conventions) ----
  const psrName = 'pr-self-review';
  let [psrAgent] = await db
    .select()
    .from(t.agents)
    .where(and(eq(t.agents.workspaceId, workspaceId), eq(t.agents.name, psrName)));
  if (!psrAgent) {
    [psrAgent] = await db
      .insert(t.agents)
      .values({
        workspaceId,
        name: psrName,
        description: 'Full-stack self-review: TypeScript, React, Fastify, and API conventions across client and server.',
        provider: DEFAULT_PROVIDER,
        model: DEFAULT_MODEL,
        systemPrompt: [
          'You are a senior engineer performing a self-review of a pull request in the DevDigest repository.',
          'Your job is to catch issues before the PR goes to human reviewers.',
          'Focus on correctness, adherence to project conventions, and anything that will be flagged in code review.',
          'Return at most 8 high-signal findings, each citing an exact file:line.',
        ].join('\n'),
        enabled: false,
        version: 1,
        createdBy: userId,
      })
      .returning();
  }

  if (psrAgent && psrSkillIds.length > 0) {
    for (const [i, skillId] of psrSkillIds.entries()) {
      await db
        .insert(t.agentSkills)
        .values({ agentId: psrAgent.id, skillId, order: i })
        .onConflictDoNothing();
    }
  }

  // ---- API Contract Reviewer skills ----
  const acrSkillDefs = [
    {
      name: 'breaking-change',
      description: 'Flags any change that removes, renames, or narrows a public API contract.',
      type: 'convention' as const,
      source: 'manual' as const,
      body: `# breaking-change

Flag any change that breaks the existing public API contract for callers who have not updated their code.
A "breaking change" is one that forces clients to change their code to avoid a runtime error or behaviour change.

Flag the offending \`file:line\` and explain exactly what the contract was and what it became.

## Examples

### ❌ Bad — silently breaks callers

\`\`\`diff
- export async function getUser(id: string): Promise<User>
+ export async function getUser(id: string, includeDeleted = false): Promise<User | null>
\`\`\`

Return type changed from \`User\` to \`User | null\`. All callers that wrote \`const u = await getUser(id); u.name\`
will throw at runtime. This is a **breaking change** — flag it.

### ✅ Good — backwards-compatible addition

\`\`\`diff
- export async function getUser(id: string): Promise<User>
+ export async function getUser(id: string, options?: { includeDeleted?: boolean }): Promise<User>
\`\`\`

Optional parameter, return type unchanged. Existing callers are unaffected.

## Rules

1. Any removal of a public export, route, or method is breaking.
2. Any narrowing of an accepted parameter type is breaking (e.g. \`string | number\` → \`string\`).
3. Any widening of a return type is breaking unless callers are guarded (\`User | null\` where \`User\` was expected).
4. A route path change (rename, reorder of segments) is breaking.
5. A required-parameter addition is breaking.
6. Status code change on a success path (200 → 201, 200 → 204) is breaking if clients branch on it.`,
    },
    {
      name: 'response-schema',
      description: 'Flags changes to API response shape: renamed fields, removed fields, type changes.',
      type: 'convention' as const,
      source: 'manual' as const,
      body: `# response-schema

Flag any change to the shape of an API response that could cause a client to fail when deserialising or accessing fields.
"Shape" means: field names, field types, nullability, optionality, nesting depth.

Flag the offending \`file:line\`, show the before/after schema diff, and state which clients are at risk.

## Examples

### ❌ Bad — field renamed

\`\`\`diff
- { "userId": "abc123" }
+ { "user_id": "abc123" }
\`\`\`

\`userId\` is now \`user_id\`. Any client reading \`.userId\` gets \`undefined\` — silent data loss.

### ❌ Bad — field removed

\`\`\`diff
- { "id": "1", "email": "a@b.com", "role": "admin" }
+ { "id": "1", "email": "a@b.com" }
\`\`\`

\`role\` removed. Clients that branch on \`user.role\` will behave incorrectly.

### ✅ Good — additive field

\`\`\`diff
  { "id": "1", "email": "a@b.com"
+ , "avatar_url": "https://..." }
\`\`\`

New optional field. Existing clients ignore it; new clients can use it.

## Rules

1. Renaming any field in a response body is breaking — even if the old name was "wrong".
2. Removing a field that clients currently read is breaking.
3. Changing a field type (e.g. \`string\` → \`number\`, \`string\` → \`string[]\`) is breaking.
4. Making a nullable field non-nullable (or vice versa) is breaking.
5. Changing the nesting level of an existing field is breaking.
6. Reordering array elements in a stable response is breaking when clients index by position.`,
    },
    {
      name: 'semver-discipline',
      description: 'Flags breaking changes shipped without a major version bump.',
      type: 'convention' as const,
      source: 'manual' as const,
      body: `# semver-discipline

Flag when a change to the API requires a semver major version bump but one has not been made,
or when the commit message / PR title suggests a "minor" or "patch" change that is actually a major.

## When a major bump is required

A major bump (X.0.0) is required whenever a published API has a **breaking change** (see \`breaking-change\` skill).
Specifically in this codebase:

- Any route removal or rename → **major**
- Any response field removal or rename → **major**
- Any narrowing of accepted input (required param added, type narrowed) → **major**
- Any authentication/authorization model change (removing a public endpoint, adding mandatory auth) → **major**

## When a minor bump is enough

- New optional query params or request body fields are added.
- New routes are added.
- New optional response fields are added.
- Behaviour is extended in a backwards-compatible way.

## When a patch is enough

- Bug fixes that restore documented behaviour.
- Performance improvements with no visible contract change.
- Documentation or comment changes only.

## Rule

If a PR contains even ONE breaking change (per \`breaking-change\` rules), the semver bump must be major.
Flag the inconsistency with the exact breaking change and the incorrect version label.`,
    },
    {
      name: 'deprecation-policy',
      description: 'Flags API elements removed without a prior deprecation marker and grace period.',
      type: 'convention' as const,
      source: 'manual' as const,
      body: `# deprecation-policy

Flag when a public API element (route, field, param, export) is silently removed or changed without first being
marked as deprecated and given a migration period.

Deprecation must be observable to callers before removal happens. Silent removal is always a breaking change.

## Required deprecation lifecycle

1. **Mark deprecated** — add a response header (\`Deprecation: true\`, \`Sunset: <date>\`) and/or a \`deprecated: true\`
   field in the response body, and document the replacement.
2. **Communicate** — the PR that introduces the deprecation must update API docs / changelog with the sunset date.
3. **Grace period** — at least one minor release must exist between the deprecation marker and removal.
4. **Remove** — only after the grace period and a major version bump.

## Examples

### ❌ Bad — silent removal in same PR

Route removed without deprecation header or grace period. Callers will receive 404 with no warning.

### ❌ Bad — field removed with a comment but no deprecation marker

Comment-only deprecation is not machine-observable. Clients have no programmatic way to detect it.

### ✅ Good — HTTP header

\`\`\`
Deprecation: true
Sunset: Sat, 01 Mar 2025 00:00:00 GMT
Link: <https://docs.example.com/migration>; rel="deprecation"
\`\`\`

RFC 8594-compliant deprecation signal.

## Rule

Any removal or renaming of a public API surface MUST be preceded by a deprecation marker in an earlier release.
If this PR removes or renames something that was never marked deprecated, flag it as a policy violation.`,
    },
  ];

  const acrSkillIds: string[] = [];
  for (const s of acrSkillDefs) {
    const [existing] = await db
      .select()
      .from(t.skills)
      .where(and(eq(t.skills.workspaceId, workspaceId), eq(t.skills.name, s.name)));
    if (existing) {
      acrSkillIds.push(existing.id);
    } else {
      const [inserted] = await db
        .insert(t.skills)
        .values({ workspaceId, ...s, enabled: true, version: 1 })
        .returning();
      await db.insert(t.skillVersions).values({ skillId: inserted!.id, version: 1, body: s.body });
      acrSkillIds.push(inserted!.id);
    }
  }

  // ---- API Contract Reviewer agent (with attached skills) ----
  const acrName = 'API Contract Reviewer';
  let [acrAgent] = await db
    .select()
    .from(t.agents)
    .where(and(eq(t.agents.workspaceId, workspaceId), eq(t.agents.name, acrName)));
  if (!acrAgent) {
    [acrAgent] = await db
      .insert(t.agents)
      .values({
        workspaceId,
        name: acrName,
        description: 'Detects breaking API contract changes: renamed/removed fields, semver violations, missing deprecation markers.',
        provider: DEFAULT_PROVIDER,
        model: DEFAULT_MODEL,
        systemPrompt: API_CONTRACT_REVIEWER_PROMPT,
        enabled: true,
        version: 1,
        createdBy: userId,
      })
      .returning();
  }

  if (acrAgent && acrSkillIds.length > 0) {
    for (const [i, skillId] of acrSkillIds.entries()) {
      await db
        .insert(t.agentSkills)
        .values({ agentId: acrAgent.id, skillId, order: i })
        .onConflictDoNothing();
    }
  }

  return { workspaceId, userId };
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const handle = createDb(url);
  seed(handle.db)
    .then(async (r) => {
      console.log('✓ seeded', r);
      await handle.close();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('✗ seed failed:', err);
      await handle.close();
      process.exit(1);
    });
}
