CREATE TABLE "llm_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deck_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "llm_messages" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "llm_sessions" ADD CONSTRAINT "llm_sessions_deck_id_decks_id_fk" FOREIGN KEY ("deck_id") REFERENCES "public"."decks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_sessions" ADD CONSTRAINT "llm_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_messages" ADD CONSTRAINT "llm_messages_session_id_llm_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."llm_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Existing chats become one earlier conversation per person and deck.
INSERT INTO "llm_sessions" ("deck_id", "user_id", "title", "created_at", "updated_at")
SELECT m."deck_id", m."user_id",
	coalesce((SELECT left(f."content"->>'text', 80) FROM "llm_messages" f
		WHERE f."deck_id" = m."deck_id" AND f."user_id" = m."user_id" AND f."role" = 'user'
		ORDER BY f."created_at" LIMIT 1), ''),
	min(m."created_at"), max(m."created_at")
FROM "llm_messages" m WHERE m."user_id" IS NOT NULL
GROUP BY m."deck_id", m."user_id";--> statement-breakpoint
UPDATE "llm_messages" m SET "session_id" = s."id"
FROM "llm_sessions" s WHERE s."deck_id" = m."deck_id" AND s."user_id" = m."user_id";
