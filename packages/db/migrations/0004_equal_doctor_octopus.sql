CREATE TABLE "privacy_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"requested_by" text NOT NULL,
	"status" text NOT NULL,
	"execute_after" timestamp with time zone DEFAULT now() NOT NULL,
	"result_key" text,
	"expires_at" timestamp with time zone,
	"report" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "privacy_requests_kind" CHECK ("privacy_requests"."kind" in ('export', 'deletion')),
	CONSTRAINT "privacy_requests_subject_type" CHECK ("privacy_requests"."subject_type" in ('user', 'org')),
	CONSTRAINT "privacy_requests_status" CHECK ("privacy_requests"."status" in ('scheduled', 'running', 'completed', 'failed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "created_by" text;--> statement-breakpoint
CREATE INDEX "privacy_requests_subject_type_subject_id_created_at_index" ON "privacy_requests" USING btree ("subject_type","subject_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "privacy_requests_open_deletion" ON "privacy_requests" USING btree ("subject_type","subject_id") WHERE "privacy_requests"."kind" = 'deletion' and "privacy_requests"."status" in ('scheduled', 'running');--> statement-breakpoint
CREATE INDEX "ai_calls_org_id_content_expires_at_index" ON "ai_calls" USING btree ("org_id","content_expires_at");--> statement-breakpoint
CREATE INDEX "ai_calls_org_id_actor_id_index" ON "ai_calls" USING btree ("org_id","actor_id");