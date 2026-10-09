-- Behaves exactly as before (checked immediately) unless a transaction opts in with
-- SET CONSTRAINTS ... DEFERRED. Test transactions use that, then always roll back, so synthetic users
-- never need an auth.users row and cascades/updates behave as in production.
ALTER TABLE "users" ALTER CONSTRAINT "users_id_auth_fkey" DEFERRABLE INITIALLY IMMEDIATE;
