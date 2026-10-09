/** SQL-aggregated dashboard statistics (replaces collecting every video into memory). */
import { sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";

type StatusRow = { status: string; n: number; bytes: number; secs: number };
type DayRow = { day: string; ts: number; n: number };

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Status distribution, the last 7 UTC days of uploads (empty days included), and lifetime totals.
 * Two statements, both aggregates: nothing proportional to the number of videos leaves Postgres.
 */
export async function getDashboardStats(db: DbLike, userId: string) {
  const statusRows = (await db.execute(sql`
    select status,
           count(*)::int as n,
           coalesce(sum(raw_file_size), 0)::float8 as bytes,
           coalesce(sum(duration), 0)::float8 as secs
    from videos
    where user_id = ${userId}
    group by status
    order by min(created_at)
  `)) as unknown as StatusRow[];

  const dayRows = (await db.execute(sql`
    select to_char(g.day, 'YYYY-MM-DD') as day,
           (extract(epoch from g.day) * 1000)::float8 as ts,
           count(v.id)::int as n
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
    order by g.day
  `)) as unknown as DayRow[];

  return {
    statusData: statusRows.map((r) => ({ name: capitalize(r.status), count: Number(r.n) })),
    timelineData: dayRows.map((r) => {
      const [, m, d] = r.day.split("-");
      return { date: `${Number(m)}/${Number(d)}`, timestamp: Number(r.ts), count: Number(r.n) };
    }),
    totalVideos: statusRows.reduce((s, r) => s + Number(r.n), 0),
    totalStorageBytes: statusRows.reduce((s, r) => s + Number(r.bytes), 0),
    totalDurationSeconds: statusRows.reduce((s, r) => s + Number(r.secs), 0),
  };
}
