ALTER TABLE "organization" ADD COLUMN "referral_code" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "referral_link" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "referred_by" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "referral_code" text;--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_referral_code_unique" UNIQUE("referral_code");