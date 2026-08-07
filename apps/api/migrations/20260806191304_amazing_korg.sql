CREATE TABLE "note" (
	"id" uuid PRIMARY KEY NOT NULL,
	"title" varchar(255) NOT NULL,
	"path" varchar(1024),
	"created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "note_mutation" (
	"note_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"content" jsonb NOT NULL,
	CONSTRAINT "note_mutation_note_id_created_at_pk" PRIMARY KEY("note_id","created_at")
);

CREATE TABLE "thread" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(64),
	"is_public" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);

ALTER TABLE "note_mutation" ADD CONSTRAINT "note_mutation_note_id_note_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."note"("id") ON DELETE cascade ON UPDATE no action;
CREATE UNIQUE INDEX "note_path_title_unique" ON "note" USING btree (lower(coalesce("path", '')),lower("title"));
CREATE INDEX "note_mutation_latest" ON "note_mutation" USING btree ("note_id","created_at" desc);
CREATE INDEX "thread_created_at_desc" ON "thread" USING btree ("created_at" desc);