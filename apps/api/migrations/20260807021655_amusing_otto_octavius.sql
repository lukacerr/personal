ALTER TABLE "note_mutation" ALTER COLUMN "created_at" DROP DEFAULT;
ALTER TABLE "note_mutation" ALTER COLUMN "content" DROP NOT NULL;
ALTER TABLE "note" ADD COLUMN "content" jsonb NOT NULL;
ALTER TABLE "note" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;
ALTER TABLE "note_mutation" ADD COLUMN "delta" jsonb;
ALTER TABLE "note_mutation" ADD COLUMN "base_created_at" timestamp;