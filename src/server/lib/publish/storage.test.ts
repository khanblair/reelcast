import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { tasks, videos } from "@/db/schema";
import { enqueueTask } from "@/server/jobs/queue";
import { extractCloudinaryPublicId, fetchCloudinaryDurations, isAllowedMediaUrl } from "@/server/lib/cloudinary";
import { isFileMissing } from "@/server/lib/storageCheck";
import { checkAllChannelsOAuthHealth } from "@/server/modules/actions/oauthHealthCheck";
import { checkAllUsersStorageHealth } from "@/server/modules/actions/storageHealth";
import { deleteVideo } from "@/server/modules/actions/deleteVideo";
import { callRpc, inRolledBackTx } from "@/server/testing";
import { backfillDurationsForUser } from "./backfill";
import { deleteVideoForUser } from "./delete";
import { makeDeps, mkVideo } from "./dbkit";
import { checkTargets, listPublishableTargets, setStorageHealth } from "./storage";
import { CLOUD_URL, FakeWorld, cloudUrl } from "./testkit";

setDefaultTimeout(120_000);

const U = (name: string) => cloudUrl(`video/upload/v1/folder/${name}.mp4`);

describe("media URL allow-list and file checks", () => {
  test("only https res.cloudinary.com is allowed", () => {
    expect(isAllowedMediaUrl(CLOUD_URL)).toBe(true);
    for (const bad of [null, undefined, "", "http://res.cloudinary.com/x.mp4", "https://res.cloudinary.com.evil.io/x", "https://evil.io/res.cloudinary.com", "https://user:pw@res.cloudinary.com/x", "https://res.cloudinary.com:8443/x", "ftp://res.cloudinary.com/x", "javascript:1"]) {
      expect(isAllowedMediaUrl(bad as string)).toBe(false);
    }
  });

  test("with a cloud name configured, only that cloud's files are allowed", () => {
    const saved = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME;
    process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME = "ourcloud";
    try {
      expect(isAllowedMediaUrl("https://res.cloudinary.com/ourcloud/video/upload/v1/a.mp4")).toBe(true);
      expect(isAllowedMediaUrl("https://res.cloudinary.com/othercloud/video/upload/v1/a.mp4")).toBe(false);
      expect(isAllowedMediaUrl("https://res.cloudinary.com/ourcloudx/video/upload/v1/a.mp4")).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME;
      else process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME = saved;
    }
  });

  test("public ids are extracted without version or extension, folders kept", () => {
    expect(extractCloudinaryPublicId(U("a"))).toBe("folder/a");
    expect(extractCloudinaryPublicId("https://res.cloudinary.com/demo/video/upload/x.mov")).toBe("x");
    expect(extractCloudinaryPublicId("https://example.com/none")).toBeNull();
  });

  test("isFileMissing: 404 => missing; other answers and network errors are inconclusive; foreign hosts are never requested", async () => {
    const mk = (status: number) => async () => new Response(null, { status });
    expect(await isFileMissing(CLOUD_URL, mk(404))).toBe(true);
    expect(await isFileMissing(CLOUD_URL, mk(200))).toBe(false);
    expect(await isFileMissing(CLOUD_URL, mk(503))).toBe(false);
    expect(await isFileMissing(CLOUD_URL, async () => { throw new TypeError("fetch failed"); })).toBe(false);
    let called = 0;
    expect(await isFileMissing("https://169.254.169.254/x", async () => { called++; return new Response(null, { status: 404 }); })).toBe(false);
    expect(called).toBe(0);
  });
});

describe("storage health bookkeeping", () => {
  test("a missing file demotes ready/scheduled to failed in one statement and leaves other statuses alone; healthy resets the flag", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const ready = await mkVideo(tx, user.id, { status: "ready" });
      const scheduled = await mkVideo(tx, user.id, { status: "scheduled" });
      const published = await mkVideo(tx, user.id, { status: "published" });
      for (const v of [ready, scheduled, published]) await setStorageHealth(tx, v.id, true);
      const get = async (id: string) => (await tx.select().from(videos).where(eq(videos.id, id)))[0];
      expect((await get(ready.id)).status).toBe("failed");
      expect((await get(scheduled.id)).status).toBe("failed");
      expect((await get(published.id)).status).toBe("published");
      expect((await get(published.id)).storageMissing).toBe(true);
      expect((await get(ready.id)).storageCheckedAt).toBeInstanceOf(Date);

      const again = await mkVideo(tx, user.id, { status: "ready", storageMissing: true });
      await setStorageHealth(tx, again.id, false);
      expect((await get(again.id)).storageMissing).toBe(false);
      expect((await get(again.id)).status).toBe("ready");
    });
  });

  test("checkTargets counts, isolates a failing check, and stops at its deadline", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const a = await mkVideo(tx, user.id, { status: "ready", rawFileKey: U("ok1") });
      const b = await mkVideo(tx, user.id, { status: "ready", rawFileKey: U("gone") });
      const c = await mkVideo(tx, user.id, { status: "scheduled", rawFileKey: U("boom"), processedFileKey: U("boom-processed") });
      const targets = (await listPublishableTargets(tx, { userId: user.id })).filter((t) => [a.id, b.id, c.id].includes(t.id));
      expect(targets).toHaveLength(3);

      const warn = console.warn;
      console.warn = () => {};
      try {
        const isMissing = async (u: string) => {
          if (u.includes("boom")) throw new Error("check blew up");
          return u.includes("gone");
        };
        expect(await checkTargets(tx, targets, isMissing)).toEqual({ checked: 2, missing: 1, healthy: 1 });
        expect(await checkTargets(tx, targets, isMissing, { deadline: Date.now() - 1 })).toEqual({ checked: 0, missing: 0, healthy: 0 });
      } finally {
        console.warn = warn;
      }
      expect((await tx.select().from(videos).where(eq(videos.id, b.id)))[0].status).toBe("failed");
      expect((await tx.select().from(videos).where(eq(videos.id, a.id)))[0].status).toBe("ready");
    });
  });

  test("a processed file is checked instead of the raw one when present", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const v = await mkVideo(tx, user.id, { status: "ready", rawFileKey: U("raw"), processedFileKey: U("processed") });
      const seen: string[] = [];
      const targets = (await listPublishableTargets(tx, { userId: user.id })).filter((t) => t.id === v.id);
      await checkTargets(tx, targets, async (u) => (seen.push(u), false));
      expect(seen).toEqual([U("processed")]);
    });
  });

  test("admin-only rpcs reject normal users", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const reg = { checkAllUsersStorageHealth, checkAllChannelsOAuthHealth };
      for (const path of ["checkAllUsersStorageHealth", "checkAllChannelsOAuthHealth"]) {
        await expect(callRpc(path, {}, { user: { ...user, isAdmin: false }, tx }, reg)).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(callRpc(path, {}, { user: null }, reg)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      }
    });
  });
});

describe("deleteVideo", () => {
  test("removes the video, destroys both storage files, cancels its pending tasks", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const v = await mkVideo(tx, user.id, { status: "ready", rawFileKey: U("raw"), processedFileKey: U("proc") });
      const { task } = await enqueueTask(tx, { kind: "metadata.generate", payload: { videoId: v.id }, dedupeKey: `metadata:${v.id}` });
      const { deps, spies } = makeDeps(new FakeWorld(1));

      await deleteVideoForUser(tx, user.id, v.id, deps);

      expect(spies.destroyed.sort()).toEqual(["folder/proc", "folder/raw"]);
      expect(await tx.select().from(videos).where(eq(videos.id, v.id))).toHaveLength(0);
      // (jobs/analytics/generations go with the video through ON DELETE CASCADE; the rolled-back test harness
      // runs with FK triggers disabled, so that database guarantee is not asserted here.)
      expect((await tx.select().from(tasks).where(eq(tasks.id, task.id)))[0].status).toBe("cancelled");
    });
  });

  test("a client-supplied key that only LOOKS like Cloudinary never reaches the destroy call (it would use our credentials)", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const v = await mkVideo(tx, user.id, {
        status: "ready",
        rawFileKey: "https://evil.example/res.cloudinary.com/upload/v1/someone-elses-asset.mp4",
        processedFileKey: "https://res.cloudinary.com.evil.example/upload/v1/another.mp4",
      });
      const { deps, spies } = makeDeps(new FakeWorld(1));
      await deleteVideoForUser(tx, user.id, v.id, deps);
      expect(spies.destroyed).toEqual([]);
      expect(await tx.select().from(videos).where(eq(videos.id, v.id))).toHaveLength(0);
    });
  });

  test("a storage failure never blocks the delete", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const v = await mkVideo(tx, user.id, { status: "ready" });
      const { deps } = makeDeps(new FakeWorld(1), {
        destroyCloudinaryAsset: async () => {
          throw new Error("cloudinary down");
        },
      });
      const warn = console.warn;
      console.warn = () => {};
      try {
        await deleteVideoForUser(tx, user.id, v.id, deps);
      } finally {
        console.warn = warn;
      }
      expect(await tx.select().from(videos).where(eq(videos.id, v.id))).toHaveLength(0);
    });
  });

  test("via rpc: unknown ids are NOT_FOUND and a bad id is BAD_REQUEST; the video is only touched by its owner", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const reg = { deleteVideo };
      await expect(callRpc("deleteVideo", { videoId: randomUUID() }, { user, tx }, reg)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(callRpc("deleteVideo", { videoId: "x" }, { user, tx }, reg)).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(deleteVideoForUser(tx, randomUUID(), (await mkVideo(tx, user.id, { rawFileKey: "x" })).id, makeDeps(new FakeWorld(1)).deps)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });
});

describe("backfillDurations", () => {
  function cloudinaryFake(durations: Record<string, number | null>, opts: { bulkIncludesDuration: string[] }) {
    const calls: string[] = [];
    const f = async (input: string | URL | Request): Promise<Response> => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      calls.push(u.pathname);
      const bulk = u.pathname.endsWith("/resources/video/upload");
      if (bulk) {
        const ids = u.searchParams.getAll("public_ids[]");
        return Response.json({
          resources: ids
            .filter((id) => id in durations)
            .map((id) => ({ public_id: id, ...(opts.bulkIncludesDuration.includes(id) && durations[id] ? { duration: durations[id] } : {}) })),
        });
      }
      const id = decodeURIComponent(u.pathname.split("/resources/video/upload/")[1]);
      if (!(id in durations)) return new Response("{}", { status: 404 });
      return Response.json({ public_id: id, ...(durations[id] ? { duration: durations[id] } : {}) });
    };
    return { f, calls };
  }

  test("fills durations (bulk first, per-resource fallback), switches >60s to video mode unless a mode was chosen", async () => {
    const env = { n: process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME, k: process.env.CLOUDINARY_API_KEY, s: process.env.CLOUDINARY_API_SECRET };
    process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME ??= "demo";
    process.env.CLOUDINARY_API_KEY ??= "k";
    process.env.CLOUDINARY_API_SECRET ??= "s";
    try {
      await inRolledBackTx(async ({ tx, user }) => {
        await tx.update(videos).set({ duration: 1 }).where(eq(videos.userId, user.id)); // take the user's real videos out of the set
        const short = await mkVideo(tx, user.id, { duration: null, rawFileKey: U("bf-short") });
        const long = await mkVideo(tx, user.id, { duration: null, rawFileKey: U("bf-long") }); // only in the per-resource endpoint
        const chosen = await mkVideo(tx, user.id, { duration: null, rawFileKey: U("bf-chosen"), publishAs: "short" });
        const unknown = await mkVideo(tx, user.id, { duration: null, rawFileKey: U("bf-unknown") });
        const deleted = await mkVideo(tx, user.id, { duration: null, rawFileKey: U("bf-deleted"), cloudinaryDeletedAt: new Date() });
        const done = await mkVideo(tx, user.id, { duration: 10, rawFileKey: U("bf-done") });
        const fake = cloudinaryFake(
          { "folder/bf-short": 45.4, "folder/bf-long": 90, "folder/bf-chosen": 120 },
          { bulkIncludesDuration: ["folder/bf-short", "folder/bf-chosen"] },
        );

        const out = await backfillDurationsForUser(tx, user.id, { f: fake.f });
        expect(out).toEqual({ updated: 3, switched: 1, skipped: 1, total: 4, remaining: 1 });

        const get = async (id: string) => (await tx.select().from(videos).where(eq(videos.id, id)))[0];
        expect(await get(short.id)).toMatchObject({ duration: 45, publishAs: null });
        expect(await get(long.id)).toMatchObject({ duration: 90, publishAs: "video" });
        expect(await get(chosen.id)).toMatchObject({ duration: 120, publishAs: "short" });
        expect((await get(unknown.id)).duration).toBeNull();
        expect((await get(deleted.id)).duration).toBeNull();
        expect((await get(done.id)).duration).toBe(10);
        expect(fake.calls.some((p) => p.endsWith("/folder/bf-long"))).toBe(true); // the fallback lookup ran

        // Nothing left to do for the finished ones: a second pass only retries the unresolved one.
        expect(await backfillDurationsForUser(tx, user.id, { f: fake.f })).toMatchObject({ updated: 0, total: 1 });
      });
    } finally {
      for (const [key, v] of [["NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME", env.n], ["CLOUDINARY_API_KEY", env.k], ["CLOUDINARY_API_SECRET", env.s]] as const) {
        if (v === undefined) delete process.env[key];
      }
    }
  });

  test("with nothing to do it returns zeros without calling Cloudinary", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await tx.update(videos).set({ duration: 1 }).where(eq(videos.userId, user.id));
      let called = 0;
      const f = async () => (called++, new Response("{}"));
      expect(await backfillDurationsForUser(tx, user.id, { f })).toEqual({ updated: 0, switched: 0, skipped: 0, total: 0, remaining: 0 });
      expect(called).toBe(0);
    });
  });

  test("fetchCloudinaryDurations stops at its deadline", async () => {
    process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME ??= "demo";
    process.env.CLOUDINARY_API_KEY ??= "k";
    process.env.CLOUDINARY_API_SECRET ??= "s";
    let called = 0;
    const out = await fetchCloudinaryDurations(["a", "b"], { f: async () => (called++, Response.json({ resources: [] })), deadline: Date.now() - 1 });
    expect(out.size).toBe(0);
    expect(called).toBe(0);
  });
});
