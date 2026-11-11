ALTER TABLE "user" ADD COLUMN "terms_version" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "privacy_version" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "legal_accepted_at" timestamp;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "age_confirmed_at" timestamp;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "marketing_opt_in" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "marketing_opt_in_at" timestamp;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "locale" text;