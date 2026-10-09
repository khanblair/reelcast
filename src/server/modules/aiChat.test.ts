import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { aiMessages, aiSessions } from "@/db/schema";
import { appendAiMessage, getSessionMessages, touchAiSession } from "../lib/accounts/ai";
import type { UserRow } from "../rpc/define";
import { callRpc, inRolledBackTx } from "../testing";

setDefaultTimeout(60_000);

type Session = { _id: string; title?: string };
type Msg = { _id: string; role: string; content: string };

describe("aiSessions / aiMessages", () => {
  test("create, list (most recently active first), rename, delete cascades to messages", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      expect(await callRpc("aiSessions.list", {}, { user: null })).toEqual([]);

      const first = (await callRpc("aiSessions.create", { title: "First" }, { user, tx })) as string;
      const second = (await callRpc("aiSessions.create", {}, { user, tx })) as string;
      expect(typeof first).toBe("string");

      // chatting in the older session moves it to the top
      await appendAiMessage(tx, user.id, first, "user", "hi");
      const list = (await callRpc("aiSessions.list", {}, { user, tx })) as Session[];
      expect(list.map((s) => s._id)).toEqual([first, second]);
      expect(list[1].title).toBeUndefined();

      await callRpc("aiSessions.updateTitle", { sessionId: second, title: "Renamed" }, { user, tx });
      expect(((await callRpc("aiSessions.list", {}, { user, tx })) as Session[]).find((s) => s._id === second)?.title).toBe("Renamed");

      await callRpc("aiSessions.remove", { sessionId: first }, { user, tx });
      expect((await tx.select().from(aiMessages).where(eq(aiMessages.sessionId, first))).length).toBe(0);
      expect(((await callRpc("aiSessions.list", {}, { user, tx })) as Session[]).map((s) => s._id)).toEqual([second]);
    });
  });

  test("owner scoping: another account cannot read, rename, delete or append to a session", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const stranger: UserRow = { ...user, id: randomUUID() };
      const sid = (await callRpc("aiSessions.create", { title: "Mine" }, { user, tx })) as string;
      await appendAiMessage(tx, user.id, sid, "user", "secret question");

      expect(await callRpc("aiSessions.list", {}, { user: stranger, tx })).toEqual([]);
      expect(await callRpc("aiMessages.getContext", { sessionId: sid }, { user: stranger, tx })).toEqual([]);
      await expect(callRpc("aiSessions.updateTitle", { sessionId: sid, title: "pwned" }, { user: stranger, tx })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(callRpc("aiSessions.remove", { sessionId: sid }, { user: stranger, tx })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(appendAiMessage(tx, stranger.id, sid, "user", "injected")).rejects.toMatchObject({ code: "NOT_FOUND" });
      await touchAiSession(tx, stranger.id, sid);

      const [row] = await tx.select().from(aiSessions).where(eq(aiSessions.id, sid));
      expect(row.title).toBe("Mine");
      expect((await tx.select().from(aiMessages).where(eq(aiMessages.sessionId, sid))).length).toBe(1);
    });
  });

  test("getContext: chronological messages of an owned session, wire shape, nothing without a session", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const sid = (await callRpc("aiSessions.create", {}, { user, tx })) as string;
      const t0 = Date.now() - 60_000;
      await tx.insert(aiMessages).values([
        { userId: user.id, sessionId: sid, role: "user", content: "one", createdAt: new Date(t0) },
        { userId: user.id, sessionId: sid, role: "assistant", content: "two", createdAt: new Date(t0 + 1000) },
        { userId: user.id, sessionId: sid, role: "user", content: "three", createdAt: new Date(t0 + 2000) },
      ]);
      const msgs = (await callRpc("aiMessages.getContext", { sessionId: sid }, { user, tx })) as Msg[];
      expect(msgs.map((m) => m.content)).toEqual(["one", "two", "three"]);
      expect(msgs[1]).toMatchObject({ role: "assistant" });
      expect(typeof msgs[0]._id).toBe("string");
      expect("toolCalls" in msgs[0]).toBe(false);

      expect(await callRpc("aiMessages.getContext", {}, { user, tx })).toEqual([]);
      expect(await callRpc("aiMessages.getContext", { sessionId: randomUUID() }, { user, tx })).toEqual([]);
      expect(await callRpc("aiMessages.getContext", { sessionId: sid }, { user: null })).toEqual([]);
    });
  });

  test("getContext returns only the last 100 messages", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const sid = (await callRpc("aiSessions.create", {}, { user, tx })) as string;
      const t0 = Date.now() - 1_000_000;
      await tx.insert(aiMessages).values(
        Array.from({ length: 105 }, (_, i) => ({ userId: user.id, sessionId: sid, role: "user" as const, content: `m${i}`, createdAt: new Date(t0 + i * 1000) })),
      );
      const msgs = (await getSessionMessages(tx, user.id, sid, 100)) as { content: string }[];
      expect(msgs.length).toBe(100);
      expect(msgs[0].content).toBe("m5");
      expect(msgs[99].content).toBe("m104");
    });
  });

  test("messages cannot be appended from the browser", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await expect(callRpc("aiMessages.append", {}, { user, tx })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(callRpc("aiSessions.touch", {}, { user, tx })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });
});
