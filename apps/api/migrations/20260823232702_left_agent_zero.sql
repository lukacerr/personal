ALTER TABLE "agent_thread" ADD COLUMN "mutation_owner" uuid;
ALTER TABLE "agent_thread" ADD COLUMN "mutation_expires_at" timestamp (3);