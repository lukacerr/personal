CREATE TABLE "payment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(255) NOT NULL,
	"tag" varchar(64),
	"value" numeric(14, 2) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"rate_buy" numeric(12, 4),
	"rate_sell" numeric(12, 4),
	"is_subscription" boolean DEFAULT false NOT NULL,
	"paid_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX "payment_paid_at_desc" ON "payment" USING btree ("paid_at" desc);