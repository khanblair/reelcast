-- New tables must be locked like the rest (default privileges already revoke API-role grants).
ALTER TABLE "job_schedules" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "job_schedules" FROM anon, authenticated;
