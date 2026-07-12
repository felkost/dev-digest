import { pgTable, uuid, text, integer, doublePrecision, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { workspaces } from './core';
import { agents } from './agents';
import { pullRequests } from './pulls';

// ============================================================ Observability

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    prId: uuid('pr_id').references(() => pullRequests.id, { onDelete: 'set null' }),
    ranAt: timestamp('ran_at', { withTimezone: true }).defaultNow().notNull(),
    provider: text('provider'),
    model: text('model'),
    durationMs: integer('duration_ms'),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    status: text('status'),
    /** Failure reason when status='failed' (LLM/API error, timeout, quota, …). */
    error: text('error'),
    source: text('source', { enum: ['local', 'ci'] }).notNull().default('local'),
    findingsCount: integer('findings_count'),
    grounding: text('grounding'),
    /** Review score (0-100) for this run; null on failed/cancelled runs. */
    score: integer('score'),
    /** Findings that tripped the agent's gate (severity ≥ ciFailOn). */
    blockers: integer('blockers'),
    /** USD cost reported by the provider (or estimated). null = unknown. */
    costUsd: doublePrecision('cost_usd'),
    /** Links this run to a multi-agent fan-out group, when it was launched as
     *  part of one (Multi-Agent Review). Forward reference to `multiAgentRuns`,
     *  declared later in this same file — safe: the FK callback is lazy.
     *  `onDelete: 'set null'` (NOT 'cascade') mirrors the sibling `prId`
     *  column above: deleting a repo cascades
     *  repos → pull_requests → multi_agent_runs (pre-existing cascade) →
     *  this column. A 'cascade' here would hard-delete the whole
     *  `agent_runs` row (and its `run_traces` via that table's own cascade)
     *  just because its multi-agent GROUP was deleted, while every other
     *  observability row for the same repo deletion survives (orphaned, not
     *  erased). `set null` keeps `agent_runs` consistent with that
     *  survive-and-orphan convention. */
    multiAgentRunId: uuid('multi_agent_run_id').references(() => multiAgentRuns.id, {
      onDelete: 'set null',
    }),
  },
  (t) => ({
    // Postgres never auto-indexes FK columns — this one backs
    // `listAgentRunsForGroup`'s lookup by multi_agent_run_id.
    multiAgentRunIdx: index('agent_runs_multi_agent_run_id_idx').on(t.multiAgentRunId),
  }),
);

/** Whole trace of one run as a SINGLE jsonb document. */
export const runTraces = pgTable('run_traces', {
  runId: uuid('run_id')
    .primaryKey()
    .references(() => agentRuns.id, { onDelete: 'cascade' }),
  trace: jsonb('trace').notNull(),
});

export const multiAgentRuns = pgTable('multi_agent_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  prId: uuid('pr_id')
    .notNull()
    .references(() => pullRequests.id, { onDelete: 'cascade' }),
  ranAt: timestamp('ran_at', { withTimezone: true }).defaultNow().notNull(),
});
