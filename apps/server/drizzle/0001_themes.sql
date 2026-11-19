CREATE TABLE "themes" (
	"version" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"changelog" text DEFAULT '' NOT NULL,
	"status" text NOT NULL,
	"log" text DEFAULT '' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"uploaded_by" uuid,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "themes" ADD CONSTRAINT "themes_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;