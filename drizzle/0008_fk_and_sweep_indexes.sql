-- Indexes for the foreign keys that had none (ideas.linked_video_id, tasks.user_id, payment_orders.subscription_id,
-- payment_orders.reviewed_by) and for the sweeps that scan their table every tick / every 5 minutes.
-- Plain CREATE INDEX on purpose: drizzle runs all pending migrations in ONE transaction, where CONCURRENTLY is not
-- allowed. A plain build blocks writes to that table until it finishes, which is milliseconds at today's sizes
-- (every table involved is under 1 MB). Do not reuse this pattern for a large table.
CREATE INDEX "ideas_linked_video_idx" ON "ideas" USING btree ("linked_video_id") WHERE linked_video_id is not null;--> statement-breakpoint
CREATE INDEX "payment_events_received_idx" ON "payment_events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "payment_orders_subscription_idx" ON "payment_orders" USING btree ("subscription_id","created_at");--> statement-breakpoint
CREATE INDEX "payment_orders_reviewed_by_idx" ON "payment_orders" USING btree ("reviewed_by") WHERE reviewed_by is not null;--> statement-breakpoint
CREATE INDEX "payment_orders_unpaid_updated_idx" ON "payment_orders" USING btree ("updated_at") WHERE applied_at is null and order_tracking_id is not null;--> statement-breakpoint
CREATE INDEX "tasks_running_locked_idx" ON "tasks" USING btree ("locked_at") WHERE status = 'running';--> statement-breakpoint
CREATE INDEX "tasks_user_idx" ON "tasks" USING btree ("user_id") WHERE user_id is not null;--> statement-breakpoint
CREATE INDEX "videos_publishing_updated_idx" ON "videos" USING btree ("updated_at") WHERE status = 'publishing';