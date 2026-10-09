ALTER TABLE "payment_orders" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_orders" ADD COLUMN "reviewed_by" uuid;--> statement-breakpoint
ALTER TABLE "payment_orders" ADD COLUMN "review_note" text;--> statement-breakpoint
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_orders_needs_review_idx" ON "payment_orders" USING btree ("created_at") WHERE reviewed_at is null and (status_text in ('AMOUNT_MISMATCH', 'STALE_UPGRADE') or status_code = 3);