CREATE TABLE "ai_dataset_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"call_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"added_by" text,
	"exported_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_dataset_items_call_id_unique" UNIQUE("call_id"),
	CONSTRAINT "ai_dataset_items_status" CHECK ("ai_dataset_items"."status" in ('pending', 'exported'))
);
--> statement-breakpoint
ALTER TABLE "ai_dataset_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ai_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"call_id" uuid NOT NULL,
	"source" text NOT NULL,
	"name" text NOT NULL,
	"value" numeric(10, 4) NOT NULL,
	"comment" text,
	"actor_id" text,
	"judge_call_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_scores_source" CHECK ("ai_scores"."source" in ('user', 'judge', 'rule'))
);
--> statement-breakpoint
ALTER TABLE "ai_scores" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_dataset_items" ADD CONSTRAINT "ai_dataset_items_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_dataset_items" ADD CONSTRAINT "ai_dataset_items_call_id_ai_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."ai_calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_scores" ADD CONSTRAINT "ai_scores_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_scores" ADD CONSTRAINT "ai_scores_call_id_ai_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."ai_calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_scores" ADD CONSTRAINT "ai_scores_judge_call_id_ai_calls_id_fk" FOREIGN KEY ("judge_call_id") REFERENCES "public"."ai_calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_dataset_items_org_id_status_index" ON "ai_dataset_items" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "ai_scores_org_id_call_id_index" ON "ai_scores" USING btree ("org_id","call_id");--> statement-breakpoint
CREATE INDEX "ai_scores_org_id_created_at_index" ON "ai_scores" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ai_dataset_items" AS PERMISSIVE FOR ALL TO public USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ai_scores" AS PERMISSIVE FOR ALL TO public USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));