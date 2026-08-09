CREATE TABLE "file" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"path" varchar(1024),
	"content_type" varchar(255) NOT NULL,
	"size" bigint NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "file_path_name_unique" ON "file" USING btree (lower(coalesce("path", '')),lower("name"));