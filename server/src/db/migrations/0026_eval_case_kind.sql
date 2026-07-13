ALTER TABLE "eval_cases" ADD COLUMN "case_kind" text DEFAULT 'review_finding' NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_cases" ADD COLUMN "passing_threshold" double precision;