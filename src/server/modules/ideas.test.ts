import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";
import { ideas } from "@/db/schema";
import { insertVideo } from "@/server/lib/content/testing";
import { callRpc, inRolledBackTx } from "@/server/testing";

setDefaultTimeout(120_000);

type W = Record<string, unknown>;

describe("ideas", () => {
  test("create / list / update / remove, scoped to the owner", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const stranger = await makeUser();
      const id = (await callRpc("ideas.create", { title: "Idea", notes: "n", tags: ["a"], scheduledGenerateAt: Date.now() + 1000 }, { user, tx })) as string;

      const all = (await callRpc("ideas.list", {}, { user, tx })) as W[];
      expect(all.map((i) => i._id)).toEqual([id]);
      expect(all[0]).toMatchObject({ title: "Idea", status: "concept", notes: "n", tags: ["a"] });
      expect(await callRpc("ideas.list", {}, { user: stranger, tx })).toEqual([]);
      const ids = async (status: string) => ((await callRpc("ideas.list", { status }, { user, tx })) as W[]).map((i) => i._id);
      expect(await ids("concept")).toEqual([id]);
      expect(await ids("published")).toEqual([]);

      await callRpc("ideas.update", { ideaId: id, title: "Renamed", status: "in_production" }, { user, tx });
      let [row] = await tx.select().from(ideas).where(eq(ideas.id, id));
      expect(row).toMatchObject({ title: "Renamed", status: "in_production", notes: "n" }); // untouched fields stay

      await expect(callRpc("ideas.update", { ideaId: id, title: "hax" }, { user: stranger, tx })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(callRpc("ideas.remove", { ideaId: id }, { user: stranger, tx })).rejects.toMatchObject({ code: "NOT_FOUND" });
      [row] = await tx.select().from(ideas).where(eq(ideas.id, id));
      expect(row.title).toBe("Renamed");

      await callRpc("ideas.remove", { ideaId: id }, { user, tx });
      expect(await tx.select().from(ideas).where(eq(ideas.id, id))).toHaveLength(0);
      await expect(callRpc("ideas.remove", { ideaId: id }, { user, tx })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  test("linking requires a video the caller owns", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const theirVideo = await insertVideo(tx, (await makeUser()).id);
      const video = await insertVideo(tx, user.id);
      const id = (await callRpc("ideas.create", { title: "Idea" }, { user, tx })) as string;

      await expect(callRpc("ideas.linkVideo", { ideaId: id, videoId: crypto.randomUUID() }, { user, tx })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(callRpc("ideas.update", { ideaId: id, linkedVideoId: crypto.randomUUID() }, { user, tx })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(callRpc("ideas.linkVideo", { ideaId: id, videoId: theirVideo.id }, { user, tx })).rejects.toMatchObject({ code: "NOT_FOUND" }); // someone else's video
      await expect(callRpc("ideas.update", { ideaId: id, linkedVideoId: theirVideo.id }, { user, tx })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(callRpc("ideas.linkVideo", { ideaId: id, videoId: video.id }, { user: await makeUser(), tx })).rejects.toMatchObject({ code: "NOT_FOUND" }); // someone else's idea

      await callRpc("ideas.linkVideo", { ideaId: id, videoId: video.id }, { user, tx });
      const [row] = await tx.select().from(ideas).where(eq(ideas.id, id));
      expect(row).toMatchObject({ linkedVideoId: video.id, status: "in_production" });
    });
  });
});
