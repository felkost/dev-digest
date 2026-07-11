ALTER TABLE "ci_installations" ADD COLUMN "workspace_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "ci_installations" ADD COLUMN "slug" text NOT NULL;--> statement-breakpoint
ALTER TABLE "ci_installations" ADD COLUMN "triggers" jsonb DEFAULT '["opened","synchronize"]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ci_installations" ADD COLUMN "post_as" text DEFAULT 'github_review' NOT NULL;--> statement-breakpoint
ALTER TABLE "ci_installations" ADD COLUMN "workflow_contents" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "ci_installations" ADD COLUMN "workflow_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "ci_installations" ADD COLUMN "disconnected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD COLUMN "workspace_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD COLUMN "github_run_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD COLUMN "repo" text;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD COLUMN "agent" text;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD COLUMN "duration_s" integer;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD COLUMN "critical" integer;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD COLUMN "warning" integer;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD COLUMN "suggestion" integer;--> statement-breakpoint
ALTER TABLE "ci_installations" ADD CONSTRAINT "ci_installations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD CONSTRAINT "ci_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ci_installations_workspace_repo_uq" ON "ci_installations" USING btree ("workspace_id","repo");--> statement-breakpoint
CREATE INDEX "ci_installations_workspace_id_idx" ON "ci_installations" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ci_runs_github_run_id_uq" ON "ci_runs" USING btree ("github_run_id");--> statement-breakpoint
CREATE INDEX "ci_runs_workspace_id_idx" ON "ci_runs" USING btree ("workspace_id");