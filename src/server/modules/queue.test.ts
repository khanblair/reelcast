import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { settings, videos } from "@/db/schema";
import { insertVideo } from "@/server/lib/content/testing";
import { callRpc, inRolledBackTx } from "@/server/testing";

setDefaultTimeout(120_000);

type W = Record<string, unknown>;

describe("queue", () => {
  test("list: ready + scheduled only, publishOrder first (nulls last), then oldest first", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const t = (n: number) => new Date(Date.UTC(2026, 0, n));
      const a = await insertVideo(tx, user.id, { title: "a", status: "ready", createdAt: t(1) });
      const b = await insertVideo(tx, user.id, { title: "b", status: "ready", createdAt: t(2), publishOrder: 2 });
      const c = await insertVideo(tx, user.id, { title: "c", status: "scheduled", scheduledPublishAt: t(20), createdAt: t(3), publishOrder: 1 });
      const d = await insertVideo(tx, user.id, { title: "d", status: "ready", createdAt: t(4) });
      const draft = await insertVideo(tx, user.id, { title: "draft", status: "draft", publishOrder: 3 });
      const published = await insertVideo(tx, user.id, { title: "published", status: "published", publishOrder: 4 });

      const rows = (await callRpc("queue.list", {}, { user, tx })) as W[];
      // ordered rows first, then un-ordered oldest first; drafts/published excluded
      expect(rows.map((r) => r._id)).toEqual([c.id, b.id, a.id, d.id]);
      expect(draft.id).not.toBe(published.id);
      expect(rows[0]).toMatchObject({ title: "c", status: "scheduled", publishOrder: 1, storageMissing: false });
      expect(typeof rows[0].scheduledPublishAt).toBe("number");
      expect(await callRpc("queue.list", {}, { user: await makeUser(), tx })).toEqual([]);
      expect(await callRpc("queue.list", {}, { user: null })).toEqual([]);
    });
  });

  test("bulkSetPublishOrder reorders in one statement and is all-or-nothing on ownership", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const a = await insertVideo(tx, user.id, { status: "ready", publishOrder: 1 });
      const b = await insertVideo(tx, user.id, { status: "ready", publishOrder: 2 });
      const order = async () =>
        Object.fromEntries((await tx.select({ id: videos.id, o: videos.publishOrder }).from(videos).where(inArray(videos.id, [a.id, b.id]))).map((r) => [r.id, r.o]));

      await callRpc("queue.bulkSetPublishOrder", { orders: [{ videoId: a.id, publishOrder: 2 }, { videoId: b.id, publishOrder: 1 }] }, { user, tx });
      expect(await order()).toEqual({ [a.id]: 2, [b.id]: 1 });

      // one foreign/unknown id fails the whole call: nothing moves
      await expect(
        callRpc("queue.bulkSetPublishOrder", { orders: [{ videoId: a.id, publishOrder: 9 }, { videoId: crypto.randomUUID(), publishOrder: 8 }] }, { user, tx }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(callRpc("queue.bulkSetPublishOrder", { orders: [{ videoId: a.id, publishOrder: 9 }] }, { user: await makeUser(), tx })).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await order()).toEqual({ [a.id]: 2, [b.id]: 1 });

      // repeated ids: the last one wins; empty input is a no-op
      await callRpc("queue.bulkSetPublishOrder", { orders: [{ videoId: a.id, publishOrder: 5 }, { videoId: a.id, publishOrder: 7 }] }, { user, tx });
      expect((await order())[a.id]).toBe(7);
      await callRpc("queue.bulkSetPublishOrder", { orders: [] }, { user, tx });

      // invalid input is rejected before touching anything
      await expect(callRpc("queue.bulkSetPublishOrder", { orders: [{ videoId: "nope", publishOrder: 1 }] }, { user, tx })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(callRpc("queue.bulkSetPublishOrder", { orders: [{ videoId: a.id, publishOrder: 1.5 }] }, { user, tx })).rejects.toMatchObject({ code: "BAD_REQUEST" });

      await callRpc("queue.setPublishOrder", { videoId: b.id, publishOrder: 3 }, { user, tx });
      expect((await order())[b.id]).toBe(3);
      await expect(callRpc("queue.setPublishOrder", { videoId: b.id, publishOrder: 3 }, { user: await makeUser(), tx })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  test("getQueueStats counts ready and scheduled videos", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      await insertVideo(tx, user.id, { status: "ready" });
      await insertVideo(tx, user.id, { status: "ready" });
      await insertVideo(tx, user.id, { status: "scheduled", scheduledPublishAt: new Date(Date.now() + 1000) });
      await insertVideo(tx, user.id, { status: "draft" });
      await insertVideo(tx, (await makeUser()).id, { status: "ready" });

      // a null nextPublishAt is omitted on the wire
      expect(await callRpc("queue.getQueueStats", {}, { user, tx })).toEqual({ readyCount: 2, scheduledCount: 1 });
      expect(await callRpc("queue.getQueueStats", {}, { user: await makeUser(), tx })).toEqual({ readyCount: 0, scheduledCount: 0 });
      expect(await callRpc("queue.getQueueStats", {}, { user: null })).toEqual({ readyCount: 0, scheduledCount: 0 });
    });
  });

  test("getQueueStats reports the next auto-publish time from settings", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const next = Date.now() + 3_600_000;
      await tx.insert(settings).values({ userId: user.id, autoPublishNextAt: new Date(next) });
      const stats = (await callRpc("queue.getQueueStats", {}, { user, tx })) as { nextPublishAt: number };
      expect(stats.nextPublishAt).toBe(next);
      await tx.update(settings).set({ autoPublishNextAt: null }).where(eq(settings.userId, user.id));
      expect("nextPublishAt" in ((await callRpc("queue.getQueueStats", {}, { user, tx })) as W)).toBe(false);
    });
  });
});
