CREATE TABLE "lockin_day" (
	"date" date PRIMARY KEY NOT NULL,
	"calories" integer,
	"protein_grams" integer,
	"masturbated" boolean,
	"mate_and_supplements" boolean,
	"gym" varchar(16),
	"steps" integer,
	"weight_kg" numeric(5, 2),
	"sleep_minutes" integer,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
