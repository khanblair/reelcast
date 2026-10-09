CREATE TABLE "job_schedules" (
	"name" text PRIMARY KEY NOT NULL,
	"last_run_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"last_error" text
);
