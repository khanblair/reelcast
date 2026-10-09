ALTER TABLE "settings" ALTER COLUMN "auto_publish_timezone_offset" SET DATA TYPE double precision;--> statement-breakpoint
CREATE INDEX "jobs_created_idx" ON "jobs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "jobs_status_created_idx" ON "jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "users_created_idx" ON "users" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "video_analytics_user_video_day_idx" ON "video_analytics" USING btree ("user_id","video_id","day");--> statement-breakpoint
CREATE INDEX "videos_created_idx" ON "videos" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "youtube_quota_date_idx" ON "youtube_quota_usage" USING btree ("date");