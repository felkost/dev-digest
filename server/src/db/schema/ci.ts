import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  doublePrecision,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { agents } from './agents';
import { workspaces } from './core';

export const ciInstallations = pgTable(
  'ci_installations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    repo: text('repo').notNull(),
    targetType: text('target_type', { enum: ['gha', 'circle', 'jenkins', 'cli'] }).notNull(),
    installedAt: timestamp('installed_at', { withTimezone: true }).defaultNow().notNull(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Slugified agent name, derived once at first export; never re-derived afterward. */
    slug: text('slug').notNull(),
    /** GitHub Actions trigger event names this installation's workflow listens for. */
    triggers: jsonb('triggers')
      .$type<string[]>()
      .notNull()
      .default(sql`'["opened","synchronize"]'::jsonb`),
    postAs: text('post_as', { enum: ['github_review', 'pr_comment', 'none'] })
      .notNull()
      .default('github_review'),
    workflowContents: text('workflow_contents').notNull().default(''),
    workflowVersion: integer('workflow_version').notNull().default(1),
    disconnectedAt: timestamp('disconnected_at', { withTimezone: true }),
  },
  (t) => ({
    // One installation per (workspace, repo) — the DB-level backstop for the
    // one-agent-per-repo rule; the user-facing "reject a second different
    // agent" behavior is enforced at the service layer, not by this alone.
    uq: uniqueIndex('ci_installations_workspace_repo_uq').on(t.workspaceId, t.repo),
    wsIdx: index('ci_installations_workspace_id_idx').on(t.workspaceId),
  }),
);

export const ciRuns = pgTable(
  'ci_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ciInstallationId: uuid('ci_installation_id').references(() => ciInstallations.id, {
      onDelete: 'set null',
    }),
    prNumber: integer('pr_number'),
    /** Denormalized PR title snapshot for the CI Runs list (nullable — older rows / runs without a PR). */
    prTitle: text('pr_title'),
    ranAt: timestamp('ran_at', { withTimezone: true }),
    status: text('status'),
    findingsCount: integer('findings_count'),
    costUsd: doublePrecision('cost_usd'),
    githubUrl: text('github_url'),
    source: text('source'),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** GitHub's own run id — one row per GitHub Actions run, ingested idempotently. */
    githubRunId: text('github_run_id').notNull(),
    /** Denormalized snapshot — survives the parent installation's cascade-delete. */
    repo: text('repo'),
    /** Denormalized snapshot — backs the pre-existing `CiRun.agent` contract field. */
    agent: text('agent'),
    /** Whole seconds; backs the pre-existing `CiRun.duration_s` contract field. */
    durationS: integer('duration_s'),
    critical: integer('critical'),
    warning: integer('warning'),
    suggestion: integer('suggestion'),
  },
  (t) => ({
    githubRunIdUq: uniqueIndex('ci_runs_github_run_id_uq').on(t.githubRunId),
    wsIdx: index('ci_runs_workspace_id_idx').on(t.workspaceId),
  }),
);
