import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq, like, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { jobSchedules, tasks, videoAnalytics, youtubeChannels } from "@/db/schema";
import { encryptSecret } from "@/server/crypto";
import { inRolledBackTx } from "@/server/testing";
import { claimDigestMarker, inDigestWindow, isoWeekKey, runDigestPage, runDigestSweep } from "./digest";
import { mkVideo, mockFetch, putSettings, setEnv } from "./testkit";

setDefaultTimeout(120_000);

let restoreEnv: () => void;
let net: ReturnType<typeof mockFetch>;
beforeEach(() => {
  restoreEnv = setEnv({ TELEGRAM_BOT_TOKEN: undefined });
  net = mockFetch(() => new Response("{}", { status: 200 }));
});
afterEach(() => {
  net.restore();
  restoreEnv();
});

describe("week + window helpers", () => {
  test("isoWeekKey follows ISO 8601 (UTC)", () => {
    expect(isoWeekKey(new Date("2026-01-01T00:00:00Z"))).toBe("2026-W01"); // Thursday
    expect(isoWeekKey(new Date("2027-01-03T08:30:00Z"))).toBe("2026-W53"); // Sunday of a 53-week year
    expect(isoWeekKey(new Date("2024-12-30T00:00:00Z"))).toBe("2025-W01"); // Monday belonging to next ISO year
    expect(isoWeekKey(new Date("2026-10-04T08:00:00Z"))).toBe("2026-W40");
  });
  test("window is Sunday 08:00-08:59 UTC only", () => {
    expect(inDigestWindow(new Date("2026-10-04T08:00:00Z"))).toBe(true);
    expect(inDigestWindow(new Date("2026-10-04T08:59:59Z"))).toBe(true);
    expect(inDigestWindow(new Date("2026-10-04T09:00:00Z"))).toBe(false);
    expect(inDigestWindow(new Date("2026-10-04T07:59:59Z"))).toBe(false);
    expect(inDigestWindow(new Date("2026-10-05T08:30:00Z"))).toBe(false); // Monday
  });
});

describe("digest marker (exactly-once)", () => {
  const user = crypto.randomUUID(); // no FK on markers: no real user involved
  const week = "2099-W01";
  afterEach(async () => {
    await db.delete(jobSchedules).where(like(jobSchedules.name, `digest:${user}:%`));
  });

  test("concurrent claimers: exactly one wins; another week / user is independent", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => claimDigestMarker(db, user, week)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await claimDigestMarker(db, user, week)).toBe(false);
    expect(await claimDigestMarker(db, user, "2099-W02")).toBe(true);
    expect(await claimDigestMarker(db, crypto.randomUUID(), week)).toBe(true); // other user (cleaned by TTL)
  });

  test("concurrent sweeps enqueue a single batch for the week", async () => {
    const sunday = new Date("2099-01-04T08:10:00Z"); // a Sunday
    const key = `digest-batch:${isoWeekKey(sunday)}`;
    try {
      await Promise.all(Array.from({ length: 6 }, () => runDigestSweep({ db, now: sunday })));
      const rows = await db.select().from(tasks).where(eq(tasks.dedupeKey, key));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: "digest.batch", status: "pending" });
      expect(rows[0].payload).toMatchObject({ week: isoWeekKey(sunday), after: null });
    } finally {
      await db.delete(tasks).where(eq(tasks.dedupeKey, key));
      await db.delete(jobSchedules).where(eq(jobSchedules.name, `digest-week:${isoWeekKey(sunday)}`));
    }
  });
});

describe("digest sweep + pages", () => {
  test("outside the window nothing happens; inside it opens the week once and prunes old markers", async () => {
    await inRolledBackTx(async ({ tx }) => {
      await tx.insert(jobSchedules).values({ name: "digest:old-user:2020-W01", lastRunAt: new Date("2020-01-01T00:00:00Z") });
      await runDigestSweep({ db: tx, now: new Date("2099-01-05T08:10:00Z") }); // Monday
      await runDigestSweep({ db: tx, now: new Date("2099-01-04T09:00:00Z") }); // Sunday, window closed
      expect(await tx.select().from(tasks).where(eq(tasks.dedupeKey, "digest-batch:2099-W01"))).toHaveLength(0);
      expect(await tx.select().from(jobSchedules).where(eq(jobSchedules.name, "digest:old-user:2020-W01"))).toHaveLength(1);

      await runDigestSweep({ db: tx, now: new Date("2099-01-04T08:00:30Z") });
      await runDigestSweep({ db: tx, now: new Date("2099-01-04T08:45:00Z") }); // a later sweep in the same window
      const batches = await tx.select().from(tasks).where(eq(tasks.dedupeKey, "digest-batch:2099-W01"));
      expect(batches).toHaveLength(1);
      expect(await tx.select().from(jobSchedules).where(eq(jobSchedules.name, "digest:old-user:2020-W01"))).toHaveLength(0);
    });
  });

  test("sends one digest per user per week with the real numbers; users with nothing published are skipped", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const now = new Date("2099-01-04T08:10:00Z");
      const week = isoWeekKey(now);
      await putSettings(tx, user.id, {
        notificationsEnabled: true,
        notifyOnWeeklyDigest: true,
        emailNotificationsEnabled: true,
        resendApiKey: encryptSecret("re_digest_key_0123456789"),
      });
      await tx.delete(youtubeChannels).where(eq(youtubeChannels.userId, user.id));
      await tx.insert(youtubeChannels).values({
        userId: user.id,
        channelId: `UC_digest_${crypto.randomUUID().slice(0, 8)}`,
        accessToken: encryptSecret("a"),
        tokenExpiry: new Date(now.getTime() + 3_600_000),
        isPrimary: true,
      });
      const a = await mkVideo(tx, user.id, { title: "Alpha", status: "published", publishedAt: new Date(now.getTime() - 86_400_000) });
      const b = await mkVideo(tx, user.id, { title: "Beta", aiTitle: "Beta AI", status: "published", publishedAt: new Date(now.getTime() - 2 * 86_400_000) });
      await mkVideo(tx, user.id, { title: "Old", status: "published", publishedAt: new Date(now.getTime() - 30 * 86_400_000) });
      await tx.insert(videoAnalytics).values([
        { userId: user.id, videoId: a.id, youtubeVideoId: "yt-a", day: "2099-01-02", views: 100 },
        { userId: user.id, videoId: a.id, youtubeVideoId: "yt-a", day: "2099-01-03", views: 400 }, // latest snapshot wins
        { userId: user.id, videoId: b.id, youtubeVideoId: "yt-b", day: "2099-01-03", views: 1100 },
      ]);

      const mine = () => net.calls.filter((c) => c.url === "https://api.resend.com/emails" && (JSON.parse(String(c.init!.body)) as { to: string[] }).to[0] === user.email);

      const first = await runDigestPage(tx, week, null, now, 1000);
      expect(first.processed).toBeGreaterThanOrEqual(1);
      expect(mine()).toHaveLength(1);
      const mail = JSON.parse(String(mine()[0].init!.body)) as { subject: string; html: string };
      expect(mail.subject).toBe("Your weekly digest: 2 videos published");
      expect(mail.html).toContain("1,500"); // 400 + 1100
      expect(mail.html).toContain("Beta AI"); // top video, AI title preferred
      expect(mail.html).toContain("1,100 views");

      // a second sweep / retried batch in the same week sends nothing more
      await runDigestPage(tx, week, null, now, 1000);
      expect(mine()).toHaveLength(1);

      // the next week it sends again
      await runDigestPage(tx, isoWeekKey(new Date(now.getTime() + 7 * 86_400_000)), null, new Date(now.getTime() + 7 * 86_400_000), 1000);
      // ...but nothing was published in the 7 days before THAT run except what is older than the window
      expect(mine().length).toBeLessThanOrEqual(1);
    });
  });

  test("opt-in rules: master off / digest off / no channel configured -> not eligible", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const now = new Date("2099-01-04T08:10:00Z");
      await tx.delete(youtubeChannels).where(eq(youtubeChannels.userId, user.id));
      await tx.insert(youtubeChannels).values({ userId: user.id, channelId: `UC_digest_${crypto.randomUUID().slice(0, 8)}`, accessToken: encryptSecret("a"), tokenExpiry: now, isPrimary: true });
      await mkVideo(tx, user.id, { status: "published", publishedAt: new Date(now.getTime() - 86_400_000) });
      const key = encryptSecret("re_digest_key_0123456789");
      const mine = () => net.calls.filter((c) => c.url === "https://api.resend.com/emails" && (JSON.parse(String(c.init!.body)) as { to: string[] }).to[0] === user.email);
      for (const [i, s] of [
        { notificationsEnabled: false, notifyOnWeeklyDigest: true, emailNotificationsEnabled: true, resendApiKey: key },
        { notificationsEnabled: true, notifyOnWeeklyDigest: false, emailNotificationsEnabled: true, resendApiKey: key },
        { notificationsEnabled: true, notifyOnWeeklyDigest: true, emailNotificationsEnabled: false, resendApiKey: key },
        { notificationsEnabled: true, notifyOnWeeklyDigest: true, emailNotificationsEnabled: true },
      ].entries()) {
        await putSettings(tx, user.id, s);
        await runDigestPage(tx, `2099-W1${i}`, null, now, 1000);
      }
      expect(mine()).toHaveLength(0);
      void sql;
    });
  });
});
