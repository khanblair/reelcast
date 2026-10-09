/**
 * Test helpers for the AI / generation runtime (imported by *.test.ts only).
 * Everything DB-related is meant to run inside `inRolledBackTx`.
 */
import { eq, sql } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { platformSettings, settings, users, videos } from "@/db/schema";
import { encryptSecret } from "@/server/crypto";
import type { JobRow } from "@/server/jobs/queue";
import { monthKey } from "@/server/lib/usage";

export type FetchCall = { url: string; init?: RequestInit };

/** Replace global fetch for one test. `handler` decides the response; calls are recorded. */
export function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A Gemini generateContent REST response carrying `text`. */
export const geminiText = (text: string) =>
  json({ candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }] });

export const META_JSON = JSON.stringify({ title: "Generated Title", description: "Generated description.", tags: ["a", "b"] });

/** Set env vars for a test and return a restore function. */
export function setEnv(vars: Record<string, string | undefined>): () => void {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/** Make the platform Gemini/DeepSeek keys deterministic inside a test transaction. */
export async function setPlatformKeys(db: DbLike, keys: { gemini?: string | null; deepseek?: string | null }) {
  const values = {
    id: 1,
    geminiApiKey: keys.gemini ? encryptSecret(keys.gemini) : null,
    deepseekApiKey: keys.deepseek ? encryptSecret(keys.deepseek) : null,
  };
  await db
    .insert(platformSettings)
    .values(values)
    .onConflictDoUpdate({ target: platformSettings.id, set: { geminiApiKey: values.geminiApiKey, deepseekApiKey: values.deepseekApiKey } });
}

/** Replace the user's settings row with exactly `values` (rolled back with the test tx). */
export async function putSettings(db: DbLike, userId: string, values: Partial<typeof settings.$inferInsert> = {}) {
  await db.delete(settings).where(eq(settings.userId, userId));
  const [row] = await db.insert(settings).values({ userId, ...values }).returning();
  return row;
}

export async function setPlan(db: DbLike, userId: string, plan: "free" | "pro" | "elite") {
  await db.update(users).set({ plan }).where(eq(users.id, userId));
}

export async function mkVideo(db: DbLike, userId: string, values: Partial<typeof videos.$inferInsert> = {}) {
  const [v] = await db
    .insert(videos)
    .values({ userId, title: "Test video", rawFileKey: "", rawFileSize: 0, ...values })
    .returning();
  return v;
}

/** A claimed `generation` job row (what the tick hands a handler). */
export function mkJob(userId: string, videoId: string, over: Partial<JobRow> = {}): JobRow {
  const now = new Date();
  return {
    id: "00000000-0000-4000-8000-000000000001",
    userId,
    videoId,
    type: "generation",
    status: "processing",
    error: null,
    // Long before the test transaction began: inside a transaction now() is frozen at its start, and a
    // slow database must not make the job look newer than the rows the test creates.
    startedAt: new Date(now.getTime() - 3_600_000),
    completedAt: null,
    metadata: null,
    runAt: now,
    attempts: 1,
    maxAttempts: 3,
    lockedAt: now,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

export async function usageCount(db: DbLike, userId: string, field: "videos_uploaded" | "metadata_generated" | "veo_generated" | "ai_messages_used"): Promise<number> {
  const rows = (await db.execute(
    sql`select ${sql.identifier(field)} as n from usage_ledger where user_id = ${userId} and month = ${monthKey()}`,
  )) as unknown as { n: number }[];
  return Number(rows[0]?.n ?? 0);
}

/** Put the user's usage for this month at exactly `n` (inside the test tx). */
export async function setUsage(db: DbLike, userId: string, field: "metadata_generated" | "veo_generated" | "ai_messages_used", n: number) {
  await db.execute(sql`
    insert into usage_ledger (user_id, month, ${sql.identifier(field)}) values (${userId}, ${monthKey()}, ${n})
    on conflict (user_id, month) do update set ${sql.identifier(field)} = ${n}
  `);
}
