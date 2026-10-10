/**
 * backfillDurationsForUser: equivalence with the original per-row loop, and a statement-count guard.
 *
 * `legacyBackfill` below is the original implementation (one unbounded select, then one UPDATE per video),
 * kept verbatim as the reference. The new code must produce the same return value and the same rows for the
 * same input, while issuing a constant number of statements. Cloudinary is replaced by an injected fetch.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { videos } from "@/db/schema";
import { extractCloudinaryPublicId, fetchCloudinaryDurations, isAllowedMediaUrl } from "@/server/lib/cloudinary";
import type { FetchLike } from "@/server/lib/youtube";
import { countQueries, inRolledBackTx } from "@/server/testing";
import { backfillDurationsForUser, type BackfillResult } from "./backfill";
import { cloudUrl } from "./testkit";

setDefaultTimeout(180_000);

const ENV_KEYS = ["NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"] as const;
const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME ??= "demo";
  process.env.CLOUDINARY_API_KEY ??= "k";
  process.env.CLOUDINARY_API_SECRET ??= "s";
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** The ORIGINAL implementation (before the batching change), kept as the equivalence oracle. */
async function legacyBackfill(
  db: DbLike,
  userId: string,
  opts: { f?: FetchLike; budgetMs?: number; maxPerRun?: number } = {},
): Promise<BackfillResult> {
  const deadline = Date.now() + (opts.budgetMs ?? 25_000);
  const eligible = await db
    .select({ id: videos.id, rawFileKey: videos.rawFileKey, processedFileKey: videos.processedFileKey, publishAs: videos.publishAs })
    .from(videos)
    .where(and(eq(videos.userId, userId), isNull(videos.duration), isNull(videos.cloudinaryDeletedAt), sql`${videos.rawFileKey} like '%res.cloudinary.com%'`))
    .orderBy(sql`${videos.createdAt} desc`);
  const total = eligible.length;
  if (total === 0) return { updated: 0, switched: 0, skipped: 0, total: 0, remaining: 0 };
  const batch = eligible.slice(0, opts.maxPerRun ?? 300);
  const idFor = new Map<string, string | null>();
  for (const v of batch) {
    const url = isAllowedMediaUrl(v.processedFileKey) ? v.processedFileKey : v.rawFileKey;
    idFor.set(v.id, isAllowedMediaUrl(url) ? extractCloudinaryPublicId(url) : null);
  }
  const publicIds = [...new Set([...idFor.values()].filter((p): p is string => !!p))];
  const durations = await fetchCloudinaryDurations(publicIds, { f: opts.f, deadline });
  let updated = 0;
  let switched = 0;
  let skipped = 0;
  for (const v of batch) {
    const publicId = idFor.get(v.id);
    const dur = publicId ? durations.get(publicId) : undefined;
    if (!dur) {
      skipped++;
      continue;
    }
    const switchToVideo = dur > 60 && !v.publishAs;
    await db
      .update(videos)
      .set({ duration: dur, updatedAt: new Date(), ...(switchToVideo ? { publishAs: "video" as const } : {}) })
      .where(and(eq(videos.id, v.id), eq(videos.userId, userId), isNull(videos.duration)));
    updated++;
    if (switchToVideo) switched++;
  }
  return { updated, switched, skipped, total, remaining: total - updated };
}

const U = (name: string) => cloudUrl(`video/upload/v1/folder/${name}.mp4`);

/** Fake Cloudinary Admin API: answers the bulk listing with `duration` for every id it knows. */
function cloudinaryFake(durations: Record<string, number>, hook?: () => Promise<void>) {
  const calls: string[] = [];
  let first = true;
  const f = async (input: string | URL | Request): Promise<Response> => {
    if (first && hook) {
      first = false;
      await hook();
    }
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    calls.push(u.pathname);
    if (u.pathname.endsWith("/resources/video/upload")) {
      const ids = u.searchParams.getAll("public_ids[]");
      return Response.json({ resources: ids.filter((id) => id in durations).map((id) => ({ public_id: id, duration: durations[id] })) });
    }
    const id = decodeURIComponent(u.pathname.split("/resources/video/upload/")[1]);
    return id in durations ? Response.json({ public_id: id, duration: durations[id] }) : new Response("{}", { status: 404 });
  };
  return { f, calls };
}

type Spec = Partial<typeof videos.$inferInsert>;

/** One multi-row insert (30 sequential inserts over the remote database would be slow). */
async function mkVideos(tx: DbLike, userId: string, specs: Record<string, Spec>) {
  const labels = Object.keys(specs);
  const rows = await tx
    .insert(videos)
    .values(labels.map((l) => ({ userId, title: `__test backfill ${l}`, rawFileSize: 1, status: "draft" as const, rawFileKey: U(`${userId}-${l}`), ...specs[l] })))
    .returning();
  const byLabel: Record<string, string> = {};
  for (const r of rows) byLabel[r.title.replace("__test backfill ", "")] = r.id;
  return byLabel;
}

type Snap = { duration: number | null; publishAs: string | null; updatedAt: number };
async function snapshot(tx: DbLike, byLabel: Record<string, string>): Promise<Record<string, Snap>> {
  const rows = await tx.select().from(videos).where(inArray(videos.id, Object.values(byLabel)));
  const out: Record<string, Snap> = {};
  for (const [label, id] of Object.entries(byLabel)) {
    const r = rows.find((x) => x.id === id)!;
    out[label] = { duration: r.duration, publishAs: r.publishAs, updatedAt: r.updatedAt.getTime() };
  }
  return out;
}
const strip = (s: Record<string, Snap>) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, { duration: v.duration, publishAs: v.publishAs }]));

/** A varied set of videos for one user; `p` keeps the public ids of different users apart. */
function scenario(userId: string) {
  const p = (l: string) => `${userId}-${l}`;
  const specs: Record<string, Spec> = {
    short: {},
    long: {},
    chosenShort: { publishAs: "short" },
    chosenVideo: { publishAs: "video" },
    boundary: {},
    unknown: {},
    processed: { processedFileKey: U(p("processed-file")) }, // the processed file wins over the raw one
    badProcessed: { processedFileKey: "https://evil.example/x.mp4" }, // a foreign host is ignored: raw is used
    sameA: { rawFileKey: U(p("same")) },
    sameB: { rawFileKey: U(p("same")) }, // two videos, one Cloudinary asset
    deleted: { cloudinaryDeletedAt: new Date() }, // ineligible
    done: { duration: 10 }, // ineligible
    notCloudinary: { rawFileKey: "https://example.com/a.mp4" }, // ineligible
  };
  const durations: Record<string, number> = {
    [`folder/${p("short")}`]: 45.4,
    [`folder/${p("long")}`]: 90,
    [`folder/${p("chosenShort")}`]: 120,
    [`folder/${p("chosenVideo")}`]: 20,
    [`folder/${p("boundary")}`]: 60,
    [`folder/${p("processed")}`]: 5, // the raw file's (wrong) answer
    [`folder/${p("processed-file")}`]: 75,
    [`folder/${p("badProcessed")}`]: 33,
    [`folder/${p("same")}`]: 80,
    [`folder/${p("deleted")}`]: 99,
    [`folder/${p("done")}`]: 99,
  };
  return { specs, durations };
}

describe("backfillDurationsForUser equivalence with the per-row loop", () => {
  test("same return value and same rows as the original; ineligible rows and other users' rows untouched", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const legacyUser = await makeUser();
      const bystander = await makeUser();
      const a = scenario(user.id);
      const b = scenario(legacyUser.id);
      const c = scenario(bystander.id); // eligible too, and Cloudinary knows them: must still be left alone
      const idsA = await mkVideos(tx, user.id, a.specs);
      const idsB = await mkVideos(tx, legacyUser.id, b.specs);
      const idsC = await mkVideos(tx, bystander.id, c.specs);
      const fake = cloudinaryFake({ ...a.durations, ...b.durations, ...c.durations });
      const beforeC = await snapshot(tx, idsC);
      const beforeA = await snapshot(tx, idsA);

      const got = await backfillDurationsForUser(tx, user.id, { f: fake.f });
      const want = await legacyBackfill(tx, legacyUser.id, { f: fake.f });
      expect(got).toEqual(want);
      expect(got).toEqual({ updated: 9, switched: 4, skipped: 1, total: 10, remaining: 1 });

      const afterA = await snapshot(tx, idsA);
      expect(strip(afterA)).toEqual(strip(await snapshot(tx, idsB)));
      expect(strip(afterA)).toEqual({
        short: { duration: 45, publishAs: null }, // 45.4 rounds to 45
        long: { duration: 90, publishAs: "video" },
        chosenShort: { duration: 120, publishAs: "short" }, // the user's choice is kept
        chosenVideo: { duration: 20, publishAs: "video" },
        boundary: { duration: 60, publishAs: null }, // exactly 60s is not "> 60"
        unknown: { duration: null, publishAs: null },
        processed: { duration: 75, publishAs: "video" },
        badProcessed: { duration: 33, publishAs: null },
        sameA: { duration: 80, publishAs: "video" },
        sameB: { duration: 80, publishAs: "video" },
        deleted: { duration: null, publishAs: null },
        done: { duration: 10, publishAs: null },
        notCloudinary: { duration: null, publishAs: null },
      });
      // updated_at moved on exactly the rows that were written, and nowhere else
      for (const [label, s] of Object.entries(afterA)) {
        const wrote = ["short", "long", "chosenShort", "chosenVideo", "boundary", "processed", "badProcessed", "sameA", "sameB"].includes(label);
        if (wrote) {
          expect(s.updatedAt).not.toBe(beforeA[label].updatedAt);
          expect(Math.abs(s.updatedAt - Date.now())).toBeLessThan(10 * 60_000); // the app clock, not an arbitrary value
        } else {
          expect(s.updatedAt).toBe(beforeA[label].updatedAt);
        }
      }
      expect(await snapshot(tx, idsC)).toEqual(beforeC); // a bystander's eligible videos were not touched

      // A second pass only retries the unresolved video, exactly like the original.
      expect(await backfillDurationsForUser(tx, user.id, { f: fake.f })).toEqual(await legacyBackfill(tx, legacyUser.id, { f: fake.f }));
      expect(await backfillDurationsForUser(tx, user.id, { f: fake.f })).toMatchObject({ updated: 0, skipped: 1, total: 1, remaining: 1 });
    });
  });

  test("maxPerRun caps the batch (newest first); total and remaining still count every eligible video", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const legacyUser = await makeUser();
      const mk = async (u: { id: string }) => {
        const specs: Record<string, Spec> = {};
        const durations: Record<string, number> = {};
        for (let i = 0; i < 5; i++) {
          specs[`v${i}`] = { createdAt: new Date(Date.UTC(2026, 0, 10 - i)) }; // v0 newest ... v4 oldest
          durations[`folder/${u.id}-v${i}`] = 30 + i * 20; // 30, 50, 70, 90, 110
        }
        return { ids: await mkVideos(tx, u.id, specs), durations };
      };
      const a = await mk(user);
      const b = await mk(legacyUser);
      const fake = cloudinaryFake({ ...a.durations, ...b.durations });

      const got = await backfillDurationsForUser(tx, user.id, { f: fake.f, maxPerRun: 3 });
      const want = await legacyBackfill(tx, legacyUser.id, { f: fake.f, maxPerRun: 3 });
      expect(got).toEqual(want);
      expect(got).toEqual({ updated: 3, switched: 1, skipped: 0, total: 5, remaining: 2 });
      expect(strip(await snapshot(tx, a.ids))).toEqual(strip(await snapshot(tx, b.ids)));
      expect((await snapshot(tx, a.ids)).v3.duration).toBeNull(); // the two oldest wait for the next run
      expect((await snapshot(tx, a.ids)).v2.duration).toBe(70);

      // Running again continues with what is left.
      expect(await backfillDurationsForUser(tx, user.id, { f: fake.f, maxPerRun: 3 })).toEqual(await legacyBackfill(tx, legacyUser.id, { f: fake.f, maxPerRun: 3 }));
      expect(strip(await snapshot(tx, a.ids))).toEqual(strip(await snapshot(tx, b.ids)));
      expect((await snapshot(tx, a.ids)).v4).toMatchObject({ duration: 110, publishAs: "video" });

      // A cap of zero processes nothing but still reports the true totals.
      const zeroUser = await makeUser();
      const zeroLegacy = await makeUser();
      await mkVideos(tx, zeroUser.id, { z0: {}, z1: {} });
      await mkVideos(tx, zeroLegacy.id, { z0: {}, z1: {} });
      const zero = await backfillDurationsForUser(tx, zeroUser.id, { f: fake.f, maxPerRun: 0 });
      expect(zero).toEqual(await legacyBackfill(tx, zeroLegacy.id, { f: fake.f, maxPerRun: 0 }));
      expect(zero).toEqual({ updated: 0, switched: 0, skipped: 0, total: 2, remaining: 2 });
    });
  });

  test("a video that gets a duration between the read and the write keeps it (guarded update); it is still counted, like the original", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const legacyUser = await makeUser();
      const specs: Record<string, Spec> = { victim: {}, other: {} };
      const ids = { a: await mkVideos(tx, user.id, specs), b: await mkVideos(tx, legacyUser.id, specs) };
      const durations = {
        [`folder/${user.id}-victim`]: 120,
        [`folder/${user.id}-other`]: 20,
        [`folder/${legacyUser.id}-victim`]: 120,
        [`folder/${legacyUser.id}-other`]: 20,
      };
      // The write lands while the (mocked) Cloudinary request is in flight: after the select, before the update.
      const race = (id: string) => cloudinaryFake(durations, async () => void (await tx.update(videos).set({ duration: 7 }).where(eq(videos.id, id))));
      const got = await backfillDurationsForUser(tx, user.id, { f: race(ids.a.victim).f });
      const want = await legacyBackfill(tx, legacyUser.id, { f: race(ids.b.victim).f });
      expect(got).toEqual(want);
      expect(got).toEqual({ updated: 2, switched: 1, skipped: 0, total: 2, remaining: 0 });
      const after = await snapshot(tx, ids.a);
      expect(strip(after)).toEqual(strip(await snapshot(tx, ids.b)));
      expect(strip(after)).toEqual({ victim: { duration: 7, publishAs: null }, other: { duration: 20, publishAs: null } });
    });
  });

  test("nothing eligible: zeros, one statement, no Cloudinary call", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const fake = cloudinaryFake({});
      const { result, queries } = await countQueries(() => backfillDurationsForUser(tx, user.id, { f: fake.f }));
      expect(result).toEqual({ updated: 0, switched: 0, skipped: 0, total: 0, remaining: 0 });
      expect(queries).toBe(1);
      expect(fake.calls).toEqual([]);
    });
  });

  test("eligible videos that Cloudinary cannot resolve: no UPDATE statement at all", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await mkVideos(tx, user.id, { a: {}, b: {} });
      const { result, queries } = await countQueries(() => backfillDurationsForUser(tx, user.id, { f: cloudinaryFake({}).f }));
      expect(result).toEqual({ updated: 0, switched: 0, skipped: 2, total: 2, remaining: 2 });
      expect(queries).toBe(1);
    });
  });
});

describe("backfillDurationsForUser statement count", () => {
  test("is the same for 1, 5 and 30 eligible videos (one select, one update)", async () => {
    await inRolledBackTx(async ({ tx, makeUser }) => {
      const counts: Record<number, number> = {};
      for (const n of [1, 5, 30]) {
        const u = await makeUser();
        const specs: Record<string, Spec> = {};
        const durations: Record<string, number> = {};
        for (let i = 0; i < n; i++) {
          specs[`v${i}`] = {};
          durations[`folder/${u.id}-v${i}`] = i % 2 ? 90 : 30; // half of them switch to "video"
        }
        const ids = await mkVideos(tx, u.id, specs);
        const fake = cloudinaryFake(durations);
        const { result, queries } = await countQueries(() => backfillDurationsForUser(tx, u.id, { f: fake.f }));
        counts[n] = queries;
        expect(result).toEqual({ updated: n, switched: Math.floor(n / 2), skipped: 0, total: n, remaining: 0 });
        const snap = await snapshot(tx, ids);
        for (let i = 0; i < n; i++) expect(snap[`v${i}`]).toMatchObject({ duration: i % 2 ? 90 : 30, publishAs: i % 2 ? "video" : null });
      }
      console.log("[backfill statement counts by eligible videos]", JSON.stringify(counts));
      expect(counts[5]).toBe(counts[1]);
      expect(counts[30]).toBe(counts[1]);
      expect(counts[1]).toBe(2);
    });
  });

  test("a very large batch is written in chunks of 1000 (1001 videos: one select, two updates)", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const specs: Record<string, Spec> = {};
      const durations: Record<string, number> = {};
      for (let i = 0; i < 1001; i++) {
        specs[`v${i}`] = {};
        durations[`folder/${user.id}-v${i}`] = 61 + (i % 7);
      }
      const ids = await mkVideos(tx, user.id, specs);
      const { result, queries } = await countQueries(() => backfillDurationsForUser(tx, user.id, { f: cloudinaryFake(durations).f, maxPerRun: 5000 }));
      expect(result).toEqual({ updated: 1001, switched: 1001, skipped: 0, total: 1001, remaining: 0 });
      expect(queries).toBe(3);
      const rows = await tx.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(videos).where(and(eq(videos.userId, user.id), eq(videos.publishAs, "video"), sql`${videos.duration} > 60`));
      expect(rows[0].n).toBe(Object.keys(ids).length);
    });
  });
});
