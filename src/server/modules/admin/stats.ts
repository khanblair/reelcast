// Port of convex/admin/stats.ts getStats. All counts/sums run in SQL (no table scans in JS).
// `getSystemStats` was internal and unused in Convex, so it is not ported.
import { sql } from "drizzle-orm";
import { query } from "../../rpc/define";

type StatsRow = {
  totalUsers: number;
  adminCount: number;
  youtubeConnected: number;
  totalVideos: number;
  publishedVideos: number;
  totalStorageBytes: number;
  jobsToday: number;
  finished: number;
  ok: number;
  autoPublishActive: number;
};

export const getStats = query({
  auth: "admin",
  handler: async (ctx) => {
    const startOfTodayUtc = new Date();
    startOfTodayUtc.setUTCHours(0, 0, 0, 0);
    const last24h = new Date(Date.now() - 86_400_000);

    // `p` = publish jobs that finished (completed or failed) in the last 24h.
    // ONE statement (polled every 30 s over a slow link): each aggregate is a one-row derived table, so the cross join
    // below always has exactly one row. Counts are cast to int and the byte sum to float8 (postgres.js returns int8 and
    // numeric as strings). The instants go in as ISO strings: a raw `sql` template does not serialise a Date column value.
    const [row] = (await ctx.db.execute(sql`
      select u.total::int as "totalUsers",
             u.admins::int as "adminCount",
             c.connected::int as "youtubeConnected",
             v.total::int as "totalVideos",
             v.published::int as "publishedVideos",
             v.bytes::float8 as "totalStorageBytes",
             j.today::int as "jobsToday",
             p.finished::int as "finished",
             p.ok::int as "ok",
             s.active::int as "autoPublishActive"
      from (select count(*) as total, count(*) filter (where is_admin) as admins from users) u,
           (select count(*) as connected from youtube_channels where is_primary = true) c,
           (select count(*) as total,
                   count(*) filter (where status = 'published') as published,
                   coalesce(sum(raw_file_size), 0) as bytes
              from videos) v,
           (select count(*) as today from jobs where started_at >= ${startOfTodayUtc.toISOString()}::timestamptz) j,
           (select count(*) as finished, count(*) filter (where status = 'completed') as ok
              from jobs
             where type = 'publish' and completed_at is not null and completed_at >= ${last24h.toISOString()}::timestamptz) p,
           (select count(*) as active from settings where auto_publish_enabled = true) s
    `)) as unknown as StatsRow[];

    return {
      totalUsers: row.totalUsers,
      youtubeConnected: row.youtubeConnected,
      adminCount: row.adminCount,
      totalVideos: row.totalVideos,
      publishedVideos: row.publishedVideos,
      totalStorageBytes: row.totalStorageBytes,
      jobsToday: row.jobsToday,
      successRate24h: row.finished > 0 ? row.ok / row.finished : null,
      autoPublishActive: row.autoPublishActive,
    };
  },
});
