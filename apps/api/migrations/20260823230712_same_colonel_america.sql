ALTER TABLE "agent_thread" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3);
ALTER TABLE "agent_thread" ALTER COLUMN "created_at" SET DEFAULT now();
ALTER TABLE "agent_thread" ALTER COLUMN "updated_at" SET DATA TYPE timestamp (3);
ALTER TABLE "agent_thread" ALTER COLUMN "updated_at" SET DEFAULT now();
ALTER TABLE "agent_thread" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;