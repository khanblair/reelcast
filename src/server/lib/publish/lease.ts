/**
 * A short lease on a job row, kept in `jobs.metadata.lease`.
 *
 * The queue already hands a pending job to exactly one worker, but a slow run that outlives the
 * stale-recovery window (or an at-least-once redelivery) could execute the same job twice, and two
 * simultaneous runs would start two YouTube upload sessions (2 x 1600 quota units, duplicate videos).
 * The lease is one atomic UPDATE: of any number of concurrent runs exactly one acquires it.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";

export type Lease = { token: string; metadata: Record<string, unknown> };

const asObject = (col: ReturnType<typeof sql>) =>
  sql`case when jsonb_typeof(${col}) = 'object' then ${col} else '{}'::jsonb end`;

/** Take the lease for `ttlMs`, or return null when a live lease is held by another run. */
export async function acquireLease(db: DbLike, jobId: string, ttlMs: number): Promise<Lease | null> {
  const token = randomUUID();
  const until = new Date(Date.now() + ttlMs).toISOString();
  const meta = sql.raw("metadata");
  const rows = (await db.execute(sql`
    update jobs
       set metadata = jsonb_set(${asObject(meta)}, '{lease}', jsonb_build_object('token', ${token}::text, 'until', ${until}::text)),
           updated_at = now()
     where id = ${jobId}
       and (metadata is null
            or jsonb_typeof(metadata) <> 'object'
            or metadata->'lease'->>'until' is null
            or (metadata->'lease'->>'until')::timestamptz <= now())
    returning metadata
  `)) as unknown as { metadata: Record<string, unknown> }[];
  if (!rows[0]) return null;
  return { token, metadata: rows[0].metadata };
}

/** Drop our lease (and optionally the saved upload session). A lease taken over by someone else is left alone. */
export async function releaseLease(db: DbLike, jobId: string, token: string, opts: { clearUpload?: boolean } = {}): Promise<void> {
  const drop = opts.clearUpload ? sql`(metadata - 'lease') - 'upload'` : sql`metadata - 'lease'`;
  await db.execute(sql`
    update jobs set metadata = ${drop}, updated_at = now()
     where id = ${jobId}
       and jsonb_typeof(metadata) = 'object'
       and metadata->'lease'->>'token' = ${token}
  `);
}

/** Merge `value` under `key` of the job's metadata object (used to persist the upload session as it grows). */
export async function setJobMetadataKey(db: DbLike, jobId: string, key: string, value: unknown): Promise<void> {
  const meta = sql.raw("metadata");
  await db.execute(sql`
    update jobs
       set metadata = jsonb_set(${asObject(meta)}, ${`{${key}}`}::text[], ${JSON.stringify(value)}::jsonb),
           updated_at = now()
     where id = ${jobId}
  `);
}
