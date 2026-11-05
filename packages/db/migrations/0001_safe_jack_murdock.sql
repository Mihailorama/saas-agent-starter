CREATE TABLE "ai_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"actor_id" text,
	"purpose" text NOT NULL,
	"provider" text NOT NULL,
	"request_model" text NOT NULL,
	"response_model" text,
	"prompt_template_id" text NOT NULL,
	"prompt_template_version" text NOT NULL,
	"request_key" text NOT NULL,
	"response_key" text,
	"content_expires_at" timestamp with time zone NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"total_tokens" integer,
	"cost" numeric(14, 6),
	"cost_currency" text,
	"latency_ms" integer NOT NULL,
	"status" text NOT NULL,
	"error_class" text,
	"trace_id" text,
	"span_id" text,
	"contour" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_calls_status" CHECK ("ai_calls"."status" in ('ok', 'error'))
);
--> statement-breakpoint
ALTER TABLE "ai_calls" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "ai_summary" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "ai_status" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "ai_call_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "reviewed_by" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_calls" ADD CONSTRAINT "ai_calls_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_calls_org_id_created_at_index" ON "ai_calls" USING btree ("org_id","created_at");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_ai_call_id_ai_calls_id_fk" FOREIGN KEY ("ai_call_id") REFERENCES "public"."ai_calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_ai_status" CHECK ("projects"."ai_status" in ('generated', 'confirmed', 'corrected'));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ai_calls" AS PERMISSIVE FOR ALL TO public USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));