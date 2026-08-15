CREATE TABLE "event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"title" varchar(255) NOT NULL,
	"details" varchar(4096),
	"date" date,
	"time_minutes" smallint,
	"recurrence" jsonb,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "event_completion" (
	"event_id" uuid NOT NULL,
	"date" date NOT NULL,
	"status" varchar(8) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "event_completion_event_id_date_pk" PRIMARY KEY("event_id","date")
);

ALTER TABLE "event_completion" ADD CONSTRAINT "event_completion_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."event"("id") ON DELETE cascade ON UPDATE no action;