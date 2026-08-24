CREATE TABLE "agent_message" (
	"id" uuid PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"role" varchar(16) NOT NULL,
	"parts" jsonb NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "agent_thread" (
	"id" uuid PRIMARY KEY NOT NULL,
	"title" varchar(255) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

ALTER TABLE "agent_message" ADD CONSTRAINT "agent_message_thread_id_agent_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."agent_thread"("id") ON DELETE cascade ON UPDATE no action;
CREATE UNIQUE INDEX "agent_message_thread_position_unique" ON "agent_message" USING btree ("thread_id","position");