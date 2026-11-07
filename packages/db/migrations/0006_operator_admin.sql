ALTER TABLE "audit_log" ALTER COLUMN "org_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "suspend_reason" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "limit_overrides" jsonb;--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "impersonated_by" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "role" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "banned" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "ban_reason" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "ban_expires" timestamp;--> statement-breakpoint
CREATE POLICY "platform_audit" ON "audit_log" AS PERMISSIVE FOR INSERT TO "app_operator_audit" WITH CHECK (org_id is null and action like 'operator.%');