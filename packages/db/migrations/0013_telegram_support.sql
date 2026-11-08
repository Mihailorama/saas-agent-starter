CREATE TABLE "telegram_support_users" (
	"telegram_user_id" bigint PRIMARY KEY NOT NULL,
	"chat_id" bigint NOT NULL,
	"topic_id" integer NOT NULL,
	"user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "telegram_support_users" ADD CONSTRAINT "telegram_support_users_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_support_users_chat_id_topic_id_index" ON "telegram_support_users" USING btree ("chat_id","topic_id");--> statement-breakpoint
CREATE INDEX "telegram_support_users_user_id_index" ON "telegram_support_users" USING btree ("user_id");