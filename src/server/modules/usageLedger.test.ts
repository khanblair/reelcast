import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";
import { users } from "@/db/schema";
import { consumeQuota } from "../lib/usage";
import { callRpc, inRolledBackTx } from "../testing";

setDefaultTimeout(60_000);

type Summary = { plan: string; month: string; usage: Record<string, { used: number; limit: number }> };

describe("usageLedger.getUsageSummary", () => {
  test("returns plan, month and used/limit per metered field (what the billing page reads)", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await tx.update(users).set({ plan: "free" }).where(eq(users.id, user.id));
      let s = (await callRpc("usageLedger.getUsageSummary", {}, { user, tx })) as Summary;
      expect(s.plan).toBe("free");
      expect(s.month).toMatch(/^\d{4}-\d{2}$/);
      expect(s.usage).toEqual({
        videosUploaded: { used: 0, limit: 10 },
        metadataGenerated: { used: 0, limit: 5 },
        veoGenerated: { used: 0, limit: 0 },
        aiMessagesUsed: { used: 0, limit: 0 },
      });

      await consumeQuota(tx, user.id, "videosUploaded");
      await consumeQuota(tx, user.id, "videosUploaded");
      s = (await callRpc("usageLedger.getUsageSummary", {}, { user, tx })) as Summary;
      expect(s.usage.videosUploaded).toEqual({ used: 2, limit: 10 });

      await tx.update(users).set({ plan: "pro" }).where(eq(users.id, user.id));
      s = (await callRpc("usageLedger.getUsageSummary", {}, { user, tx })) as Summary;
      expect(s.plan).toBe("pro");
      expect(s.usage.aiMessagesUsed.limit).toBe(200);
    });
  });

  test("requires a signed-in user", async () => {
    await expect(callRpc("usageLedger.getUsageSummary", {}, { user: null })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
});
