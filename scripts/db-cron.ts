/**
 * Production job runner schedule: Supabase pg_cron + pg_net call /api/cron/tick every minute.
 * Both extensions are free on Supabase. Run ONCE after deploying (and again if the URL changes):
 *
 *   bun --env-file=.env.local scripts/db-cron.ts https://your-domain.example
 *   bun --env-file=.env.local scripts/db-cron.ts --remove
 *
 * Works with any host that serves the Next app: the tick is a plain HTTPS endpoint guarded by
 * CRON_SECRET (stored in Supabase Vault, not in the cron command text).
 */
import postgres from "postgres";

const arg = process.argv[2];
const url = process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL;
const secret = process.env.CRON_SECRET;
if (!url) throw new Error("DATABASE_URL_DIRECT is not set");

const sql = postgres(url, { max: 1, prepare: false });
try {
  if (arg === "--remove") {
    await sql`select cron.unschedule('reelcast-tick') where exists (select 1 from cron.job where jobname = 'reelcast-tick')`;
    console.log("removed reelcast-tick");
  } else {
    if (!arg || !/^https:\/\//.test(arg)) throw new Error("Usage: db-cron.ts https://<your-deployed-domain>  (https required)");
    if (!secret) throw new Error("CRON_SECRET is not set");
    const tickUrl = `${arg.replace(/\/$/, "")}/api/cron/tick`;

    await sql`create extension if not exists pg_cron`;
    await sql`create extension if not exists pg_net`;
    await sql`create extension if not exists supabase_vault`;

    // Keep the secret out of cron.job.command: store it in Vault and read it at run time.
    await sql`delete from vault.secrets where name = 'reelcast_cron_secret'`;
    await sql`select vault.create_secret(${secret}, 'reelcast_cron_secret')`;

    const command = `select net.http_get(
      url := '${tickUrl}',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'reelcast_cron_secret')),
      timeout_milliseconds := 280000
    )`;
    await sql`select cron.schedule('reelcast-tick', '* * * * *', ${command})`;
    console.log(`scheduled reelcast-tick every minute -> ${tickUrl}`);
  }
} finally {
  await sql.end({ timeout: 3 });
}
