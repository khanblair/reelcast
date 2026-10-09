CREATE TABLE "ai_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"tool_calls" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_messages_role_chk" CHECK (role in ('user', 'assistant'))
);
--> statement-breakpoint
CREATE TABLE "ai_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"subject" text NOT NULL,
	"message" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_status_chk" CHECK (status in ('new', 'read'))
);
--> statement-breakpoint
CREATE TABLE "generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"video_id" uuid NOT NULL,
	"model" text NOT NULL,
	"prompt" text NOT NULL,
	"negative_prompt" text,
	"resolution" text NOT NULL,
	"aspect_ratio" text NOT NULL,
	"duration_seconds" integer NOT NULL,
	"generate_audio" boolean NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"veo_operation_name" text,
	"output_video_url" text,
	"thumbnail_url" text,
	"error" text,
	"generation_time_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generations_status_chk" CHECK (status in ('submitted', 'processing', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "ideas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"notes" text,
	"tags" text[],
	"status" text DEFAULT 'concept' NOT NULL,
	"scheduled_generate_at" timestamp with time zone,
	"linked_video_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ideas_status_chk" CHECK (status in ('concept', 'in_production', 'published'))
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"video_id" uuid NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"metadata" jsonb,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"locked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_type_chk" CHECK (type in ('generation', 'publish')),
	CONSTRAINT "jobs_status_chk" CHECK (status in ('pending', 'processing', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"type" text NOT NULL,
	"is_read" boolean DEFAULT false NOT NULL,
	"link" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_type_chk" CHECK (type in ('info', 'success', 'warning', 'error'))
);
--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text DEFAULT 'pesapal' NOT NULL,
	"order_tracking_id" text,
	"merchant_ref" text,
	"notification_type" text,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "payment_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"subscription_id" uuid,
	"provider" text DEFAULT 'pesapal' NOT NULL,
	"merchant_ref" text NOT NULL,
	"order_tracking_id" text,
	"purpose" text NOT NULL,
	"plan" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"currency" text NOT NULL,
	"status_code" smallint,
	"status_text" text,
	"confirmation_code" text,
	"payment_method" text,
	"redirect_url" text,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_orders_purpose_chk" CHECK (purpose in ('initial', 'renewal', 'upgrade'))
);
--> statement-breakpoint
CREATE TABLE "platform_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"deepseek_api_key" text,
	"gemini_api_key" text,
	"pesapal_consumer_key" text,
	"pesapal_consumer_secret" text,
	"pesapal_environment" text DEFAULT 'sandbox',
	"pesapal_ipn_id" text,
	"pesapal_ipn_url" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_settings_singleton_chk" CHECK (id = 1)
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"ai_preset" text,
	"default_quality" text,
	"default_aspect_ratio" text,
	"default_captions" boolean,
	"default_background_music" boolean,
	"notifications_enabled" boolean DEFAULT true NOT NULL,
	"telegram_chat_id" text,
	"discord_webhook_url" text,
	"notify_on_publish_success" boolean,
	"notify_on_publish_failure" boolean,
	"notify_on_metadata_ready" boolean,
	"notify_on_weekly_digest" boolean,
	"notify_on_storage_warning" boolean,
	"discord_message_template" text,
	"telegram_message_template" text,
	"resend_api_key" text,
	"email_from_address" text,
	"email_notifications_enabled" boolean,
	"deepseek_api_key" text,
	"ai_auto_generate" boolean,
	"ai_generate_title" boolean,
	"ai_generate_description" boolean,
	"ai_generate_tags" boolean,
	"ai_tone" text,
	"ai_language" text,
	"ai_description_length" text,
	"ai_guidelines" text,
	"ai_niche" text,
	"ai_target_audience" text,
	"ai_brand_voice" text,
	"ai_forbidden_words" text,
	"ai_cta_preferences" text,
	"competitor_channel_ids" text[],
	"auto_publish_enabled" boolean,
	"auto_publish_interval_ms" bigint,
	"auto_publish_count" integer,
	"auto_publish_privacy" text,
	"auto_publish_next_at" timestamp with time zone,
	"auto_publish_time_slots" integer[],
	"auto_publish_timezone_offset" integer,
	"humanize_writing" boolean,
	"veo_model" text,
	"veo_resolution" text,
	"veo_aspect_ratio" text,
	"veo_duration_seconds" integer,
	"veo_generate_audio" boolean,
	"veo_enhance_prompt" boolean,
	"veo_person_generation" text,
	"veo_number_of_videos" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_auto_privacy_chk" CHECK (auto_publish_privacy in ('private', 'public', 'unlisted'))
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"plan" text NOT NULL,
	"status" text DEFAULT 'approval_pending' NOT NULL,
	"provider" text DEFAULT 'pesapal' NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"grace_until" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"pending_plan" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_status_chk" CHECK (status in ('approval_pending', 'active', 'past_due', 'cancelled', 'expired')),
	CONSTRAINT "subscriptions_plan_chk" CHECK (plan in ('pro', 'elite'))
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"user_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"locked_at" timestamp with time zone,
	"last_error" text,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_status_chk" CHECK (status in ('pending', 'running', 'done', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "usage_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"month" text NOT NULL,
	"videos_uploaded" integer DEFAULT 0 NOT NULL,
	"metadata_generated" integer DEFAULT 0 NOT NULL,
	"veo_generated" integer DEFAULT 0 NOT NULL,
	"ai_messages_used" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"image_url" text,
	"is_admin" boolean DEFAULT false NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"plan_source" text DEFAULT 'default' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_plan_chk" CHECK (plan in ('free', 'pro', 'elite')),
	CONSTRAINT "users_plan_source_chk" CHECK (plan_source in ('default', 'subscription', 'admin'))
);
--> statement-breakpoint
CREATE TABLE "video_analytics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"video_id" uuid NOT NULL,
	"youtube_video_id" text NOT NULL,
	"day" date NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"views" integer,
	"watch_time_minutes" double precision,
	"avg_view_duration_sec" double precision,
	"impressions" integer,
	"ctr" double precision,
	"likes" integer,
	"comments" integer,
	"subscribers_gained" integer,
	"estimated_revenue" double precision,
	"rpm" double precision,
	"cpm" double precision,
	"traffic_source_search" double precision,
	"traffic_source_suggested" double precision,
	"traffic_source_external" double precision
);
--> statement-breakpoint
CREATE TABLE "video_daily_stats" (
	"video_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"day" date NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"watch_time_minutes" double precision DEFAULT 0 NOT NULL,
	"avg_view_duration_sec" double precision,
	"likes" integer DEFAULT 0 NOT NULL,
	"comments" integer DEFAULT 0 NOT NULL,
	"subscribers_gained" integer DEFAULT 0 NOT NULL,
	"subscribers_lost" integer DEFAULT 0 NOT NULL,
	"impressions" integer,
	"ctr" double precision,
	"estimated_revenue" double precision,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "video_metadata_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"video_id" uuid NOT NULL,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ai_title" text,
	"ai_description" text,
	"ai_tags" text[]
);
--> statement-breakpoint
CREATE TABLE "videos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"tags" text[],
	"status" text DEFAULT 'draft' NOT NULL,
	"raw_file_key" text NOT NULL,
	"raw_file_size" bigint NOT NULL,
	"processed_file_key" text,
	"thumbnail_url" text,
	"duration" double precision,
	"ai_title" text,
	"ai_description" text,
	"ai_tags" text[],
	"thumbnail_generated_url" text,
	"captions_vtt" text,
	"youtube_channel_id" text,
	"ai_config" jsonb,
	"veo_operation_name" text,
	"veo_operation_done" boolean,
	"source_type" text,
	"published_video_id" text,
	"published_at" timestamp with time zone,
	"scheduled_publish_at" timestamp with time zone,
	"metadata_scheduled_at" timestamp with time zone,
	"cloudinary_deleted_at" timestamp with time zone,
	"storage_missing" boolean,
	"storage_checked_at" timestamp with time zone,
	"privacy_status" text,
	"publish_as" text,
	"publish_order" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "videos_status_chk" CHECK (status in ('draft', 'queued', 'generating', 'ready', 'scheduled', 'publishing', 'published', 'failed')),
	CONSTRAINT "videos_privacy_chk" CHECK (privacy_status in ('private', 'public', 'unlisted')),
	CONSTRAINT "videos_publish_as_chk" CHECK (publish_as in ('short', 'video')),
	CONSTRAINT "videos_source_chk" CHECK (source_type in ('upload', 'generate'))
);
--> statement-breakpoint
CREATE TABLE "youtube_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"channel_id" text NOT NULL,
	"channel_name" text,
	"access_token" text NOT NULL,
	"refresh_token" text,
	"token_expiry" timestamp with time zone NOT NULL,
	"oauth_status" text DEFAULT 'connected',
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "youtube_channels_oauth_chk" CHECK (oauth_status in ('connected', 'token_expired', 'revoked', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "youtube_quota_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"date" date NOT NULL,
	"units_used" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_session_id_ai_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."ai_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_sessions" ADD CONSTRAINT "ai_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_linked_video_id_videos_id_fk" FOREIGN KEY ("linked_video_id") REFERENCES "public"."videos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_analytics" ADD CONSTRAINT "video_analytics_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_analytics" ADD CONSTRAINT "video_analytics_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_daily_stats" ADD CONSTRAINT "video_daily_stats_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_daily_stats" ADD CONSTRAINT "video_daily_stats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_metadata_versions" ADD CONSTRAINT "video_metadata_versions_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "videos" ADD CONSTRAINT "videos_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "youtube_channels" ADD CONSTRAINT "youtube_channels_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "youtube_quota_usage" ADD CONSTRAINT "youtube_quota_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_messages_session_idx" ON "ai_messages" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_messages_user_idx" ON "ai_messages" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ai_sessions_user_idx" ON "ai_sessions" USING btree ("user_id","last_message_at");--> statement-breakpoint
CREATE INDEX "contact_submissions_status_idx" ON "contact_submissions" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "generations_user_idx" ON "generations" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "generations_video_idx" ON "generations" USING btree ("video_id");--> statement-breakpoint
CREATE INDEX "ideas_user_idx" ON "ideas" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "jobs_user_idx" ON "jobs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "jobs_video_idx" ON "jobs" USING btree ("video_id");--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("run_at") WHERE status = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_one_active_per_video_type_idx" ON "jobs" USING btree ("video_id","type") WHERE status in ('pending', 'processing');--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("user_id") WHERE not is_read;--> statement-breakpoint
CREATE INDEX "payment_events_tracking_idx" ON "payment_events" USING btree ("order_tracking_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_orders_merchant_ref_idx" ON "payment_orders" USING btree ("merchant_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_orders_tracking_idx" ON "payment_orders" USING btree ("order_tracking_id") WHERE order_tracking_id is not null;--> statement-breakpoint
CREATE INDEX "payment_orders_user_idx" ON "payment_orders" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "settings_user_idx" ON "settings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "settings_auto_publish_idx" ON "settings" USING btree ("auto_publish_next_at") WHERE auto_publish_enabled;--> statement-breakpoint
CREATE INDEX "subscriptions_user_idx" ON "subscriptions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_one_live_idx" ON "subscriptions" USING btree ("user_id") WHERE status in ('approval_pending', 'active', 'past_due');--> statement-breakpoint
CREATE INDEX "subscriptions_period_end_idx" ON "subscriptions" USING btree ("period_end") WHERE status in ('active', 'past_due');--> statement-breakpoint
CREATE INDEX "tasks_claim_idx" ON "tasks" USING btree ("run_at") WHERE status = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_dedupe_idx" ON "tasks" USING btree ("dedupe_key") WHERE dedupe_key is not null and status in ('pending', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "usage_ledger_user_month_idx" ON "usage_ledger" USING btree ("user_id","month");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "video_analytics_video_day_idx" ON "video_analytics" USING btree ("video_id","day");--> statement-breakpoint
CREATE INDEX "video_analytics_user_day_idx" ON "video_analytics" USING btree ("user_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "video_daily_stats_pk" ON "video_daily_stats" USING btree ("video_id","day");--> statement-breakpoint
CREATE INDEX "video_daily_stats_user_day_idx" ON "video_daily_stats" USING btree ("user_id","day");--> statement-breakpoint
CREATE INDEX "video_metadata_versions_video_idx" ON "video_metadata_versions" USING btree ("video_id","saved_at");--> statement-breakpoint
CREATE INDEX "videos_user_idx" ON "videos" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "videos_user_status_idx" ON "videos" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "videos_due_idx" ON "videos" USING btree ("scheduled_publish_at") WHERE status = 'scheduled';--> statement-breakpoint
CREATE INDEX "videos_metadata_due_idx" ON "videos" USING btree ("metadata_scheduled_at") WHERE metadata_scheduled_at is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "youtube_channels_channel_id_idx" ON "youtube_channels" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "youtube_channels_user_idx" ON "youtube_channels" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "youtube_channels_one_primary_idx" ON "youtube_channels" USING btree ("user_id") WHERE is_primary;--> statement-breakpoint
CREATE UNIQUE INDEX "youtube_quota_user_date_idx" ON "youtube_quota_usage" USING btree ("user_id","date");