CREATE TABLE "reward_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"rule_id" text NOT NULL,
	"subject" text NOT NULL,
	"via" text NOT NULL,
	"status" text NOT NULL,
	"reward" jsonb NOT NULL,
	"provider_ref" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reward_grants_org_id_rule_id_subject_unique" UNIQUE("org_id","rule_id","subject"),
	CONSTRAINT "reward_grants_via" CHECK ("reward_grants"."via" in ('entitlement', 'credit_grant', 'balance_credit', 'coupon', 'manual')),
	CONSTRAINT "reward_grants_status" CHECK ("reward_grants"."status" in ('applied', 'pending_manual'))
);
--> statement-breakpoint
ALTER TABLE "reward_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reward_grants" ADD CONSTRAINT "reward_grants_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "reward_grants" AS PERMISSIVE FOR ALL TO public USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true));