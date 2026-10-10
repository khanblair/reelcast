/** SQL-aggregated dashboard statistics (replaces collecting every video into memory). */
import { sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";

/** One row of the combined statement: `k` 0 = a status row, `k` 1 = a day row (sorted by `k`, then `ord`). */
type Row = { k: number; label: string; n: number; bytes: number | null; secs: number | null; ts: number | null };

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Status distribution, the last 7 UTC days of uploads (empty days included), and lifetime totals.
 * ONE statement (two aggregates stacked with UNION ALL): nothing proportional to the number of videos leaves Postgres.
 * `ord` carries each part's own ordering (statuses by first upload, days ascending) through the union.
 */
export async function getDashboardStats(db: DbLike, userId: string) {
  const rows = (await db.execute(sql`
    select k, label, n, bytes, secs, ts
    from (
      select 0 as k,
             row_number() over (order by min(created_at)) as ord,
             status as label,
             count(*)::int as n,
             coalesce(sum(raw_file_size), 0)::float8 as bytes,
             coalesce(sum(duration), 0)::float8 as secs,
             null::float8 as ts
      from videos
      where user_id = ${userId}
      group by status
      union all
      select 1 as k,
             row_number() over (order by g.day) as ord,
             to_char(g.day, 'YYYY-MM-DD') as label,
             count(v.id)::int as n,
             null::float8 as bytes,
             null::float8 as secs,
             (extract(epoch from g.day) * 1000)::float8 as ts
      from generate_series(
             ((now() at time zone 'utc')::date - 6)::timestamp,
             (now() at time zone 'utc')::date::timestamp,
             interval '1 day'
           ) as g(day)
      left join videos v
        on v.user_id = ${userId}
       and v.created_at >= (g.day at time zone 'utc')
       and v.created_at < ((g.day + interval '1 day') at time zone 'utc')
      group by g.day
    ) u
    order by k, ord
  `)) as unknown as Row[];

  const statusRows = rows.filter((r) => Number(r.k) === 0);
  const dayRows = rows.filter((r) => Number(r.k) === 1);

  return {
    statusData: statusRows.map((r) => ({ name: capitalize(r.label), count: Number(r.n) })),
    timelineData: dayRows.map((r) => {
      const [, m, d] = r.label.split("-");
      return { date: `${Number(m)}/${Number(d)}`, timestamp: Number(r.ts), count: Number(r.n) };
    }),
    totalVideos: statusRows.reduce((s, r) => s + Number(r.n), 0),
    totalStorageBytes: statusRows.reduce((s, r) => s + Number(r.bytes), 0),
    totalDurationSeconds: statusRows.reduce((s, r) => s + Number(r.secs), 0),
  };
}
