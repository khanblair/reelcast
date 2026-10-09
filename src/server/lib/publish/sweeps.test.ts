import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";
import { jobs, videos } from "@/db/schema";
import { inRolledBackTx } from "@/server/testing";
import { makeDeps, mkJob, mkVideo } from "./dbkit";
import { reconcilePublishing } from "./sweeps";
import { FakeWorld } from "./testkit";

setDefaultTimeout(120_000);

const HOUR_AGO = () => new Date(Date.now() - 3_600_000);

describe("reconcilePublishing", () => {
  test("repairs videos whose job vanished, leaves live and recent ones alone", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const stuck = await mkVideo(tx, user.id, { status: "publishing", updatedAt: HOUR_AGO(), title: "stuck" });
      const alive = await mkVideo(tx, user.id, { status: "publishing", updatedAt: HOUR_AGO(), title: "alive" });
      await mkJob(tx, user.id, alive.id, { status: "pending" });
      const recent = await mkVideo(tx, user.id, { status: "publishing", title: "recent" });
      const finished = await mkVideo(tx, user.id, { status: "publishing", updatedAt: HOUR_AGO(), publishedVideoId: "yt1", title: "finished" });

      const { deps, spies } = makeDeps(new FakeWorld(1));
      const out = await reconcilePublishing(tx, deps, { videoIds: [stuck.id, alive.id, recent.id, finished.id] });
      expect(out).toEqual({ failed: 1, published: 1 });

      const status = async (id: string) => (await tx.select({ s: videos.status }).from(videos).where(eq(videos.id, id)))[0].s;
      expect(await status(stuck.id)).toBe("failed");
      expect(await status(alive.id)).toBe("publishing");
      expect(await status(recent.id)).toBe("publishing");
      expect(await status(finished.id)).toBe("published");

      const links = spies.notifications.map((n) => n.link);
      expect(links).toContain(`/video/${stuck.id}`);
      expect(links).not.toContain(`/video/${alive.id}`);
      expect(links).not.toContain(`/video/${recent.id}`);
      expect(links).not.toContain(`/video/${finished.id}`);
      expect(spies.messages.some((m) => m.event === "publishFailure" && m.data.title === "stuck")).toBe(true);

      // idempotent: a second pass repairs nothing of ours again
      const again = makeDeps(new FakeWorld(1));
      await reconcilePublishing(tx, again.deps, { videoIds: [stuck.id, alive.id, recent.id, finished.id] });
      expect(again.spies.notifications.map((n) => n.link)).not.toContain(`/video/${stuck.id}`);
      expect(await tx.select().from(jobs).where(eq(jobs.videoId, stuck.id))).toHaveLength(0);
    });
  });
});
