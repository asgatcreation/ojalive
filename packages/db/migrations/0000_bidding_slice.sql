CREATE TYPE "public"."bid_event_kind" AS ENUM('bid', 'proxy_raise', 'retraction', 'buy_now', 'close', 'pause', 'resume', 'extend');--> statement-breakpoint
CREATE TYPE "public"."bid_source" AS ENUM('web', 'api', 'bot', 'staff');--> statement-breakpoint
CREATE TYPE "public"."closure_outcome" AS ENUM('sold', 'unsold_reserve', 'no_bids', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."lot_status" AS ENUM('draft', 'submitted', 'approved', 'scheduled', 'open', 'paused', 'closing', 'closed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."lot_type" AS ENUM('single', 'bulk', 'mixed');--> statement-breakpoint
CREATE TYPE "public"."sale_kind" AS ENUM('timed', 'live', 'sealed');--> statement-breakpoint
CREATE TYPE "public"."sale_status" AS ENUM('draft', 'scheduled', 'open', 'closed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'suspended', 'closed');--> statement-breakpoint
CREATE TABLE "bid_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"lot_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"user_id" uuid,
	"kind" "bid_event_kind" NOT NULL,
	"max_amount_kobo" bigint,
	"price_after_kobo" bigint NOT NULL,
	"leader_after_user_id" uuid,
	"idempotency_key" text,
	"accepted_at" timestamp with time zone NOT NULL,
	"source" "bid_source" DEFAULT 'web' NOT NULL,
	"ip" text,
	"device_id" text,
	"retracted_by" uuid,
	"retracted_reason" text,
	"retracted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "lot_closures" (
	"lot_id" uuid PRIMARY KEY NOT NULL,
	"closed_at" timestamp with time zone NOT NULL,
	"winning_bid_event_id" bigint,
	"hammer_price_kobo" bigint NOT NULL,
	"outcome" "closure_outcome" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lot_state" (
	"lot_id" uuid PRIMARY KEY NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL,
	"price_kobo" bigint NOT NULL,
	"leader_user_id" uuid,
	"leader_max_kobo" bigint,
	"leader_max_set_seq" integer,
	"bid_count" integer DEFAULT 0 NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reserve_met" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sale_id" uuid NOT NULL,
	"seller_id" uuid,
	"lot_number" integer NOT NULL,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"lot_type" "lot_type" DEFAULT 'single' NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"condition_grade" text,
	"starting_price_kobo" bigint NOT NULL,
	"reserve_price_kobo" bigint,
	"buy_now_price_kobo" bigint,
	"opens_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"original_ends_at" timestamp with time zone NOT NULL,
	"extension_count" integer DEFAULT 0 NOT NULL,
	"status" "lot_status" DEFAULT 'draft' NOT NULL,
	"rules_snapshot" jsonb NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"kind" "sale_kind" DEFAULT 'timed' NOT NULL,
	"opens_at" timestamp with time zone NOT NULL,
	"first_lot_closes_at" timestamp with time zone NOT NULL,
	"stagger_seconds" integer DEFAULT 60 NOT NULL,
	"status" "sale_status" DEFAULT 'draft' NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"email" text,
	"phone" text,
	"password_hash" text,
	"is_bot" boolean DEFAULT false NOT NULL,
	"age_confirmed_at" timestamp with time zone,
	"verification_tier" smallint DEFAULT 0 NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bid_events" ADD CONSTRAINT "bid_events_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."lots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bid_events" ADD CONSTRAINT "bid_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bid_events" ADD CONSTRAINT "bid_events_leader_after_user_id_users_id_fk" FOREIGN KEY ("leader_after_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bid_events" ADD CONSTRAINT "bid_events_retracted_by_users_id_fk" FOREIGN KEY ("retracted_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_closures" ADD CONSTRAINT "lot_closures_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."lots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_closures" ADD CONSTRAINT "lot_closures_winning_bid_event_id_bid_events_id_fk" FOREIGN KEY ("winning_bid_event_id") REFERENCES "public"."bid_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_state" ADD CONSTRAINT "lot_state_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."lots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lot_state" ADD CONSTRAINT "lot_state_leader_user_id_users_id_fk" FOREIGN KEY ("leader_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lots" ADD CONSTRAINT "lots_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lots" ADD CONSTRAINT "lots_seller_id_users_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bid_events_lot_seq_key" ON "bid_events" USING btree ("lot_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "bid_events_idempotency_key" ON "bid_events" USING btree ("lot_id","user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "bid_events_lot_id_idx" ON "bid_events" USING btree ("lot_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "lots_sale_lot_number_key" ON "lots" USING btree ("sale_id","lot_number");--> statement-breakpoint
CREATE UNIQUE INDEX "lots_slug_key" ON "lots" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "lots_open_ends_at_idx" ON "lots" USING btree ("ends_at") WHERE "lots"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "sales_slug_key" ON "sales" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_phone_key" ON "users" USING btree ("phone");