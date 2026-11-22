-- Multiple templates: an installed template version is keyed by `<package>@<version>`, so two
-- templates may both have version 1.0.0. Decks point to that key instead of the bare version.
ALTER TABLE "themes" ADD COLUMN "id" text;--> statement-breakpoint
ALTER TABLE "themes" ADD COLUMN "label" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "themes" ADD COLUMN "builtin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "themes" SET "id" = "name" || '@' || "version";--> statement-breakpoint
ALTER TABLE "decks" RENAME COLUMN "theme_version" TO "theme_id";--> statement-breakpoint
UPDATE "decks" SET "theme_id" = "themes"."id" FROM "themes" WHERE "decks"."theme_id" = "themes"."version";--> statement-breakpoint
ALTER TABLE "themes" DROP CONSTRAINT "themes_pkey";--> statement-breakpoint
ALTER TABLE "themes" ALTER COLUMN "id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "themes" ADD PRIMARY KEY ("id");
