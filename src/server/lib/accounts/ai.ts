/**
 * AI assistant chat storage helpers. Plain functions (NOT rpc exports) so the assistant action
 * (agent C2) can persist turns without exposing write endpoints to the browser. Every function
 * is owner-scoped: a session id the caller does not own behaves as "not found".
 */
import { and, desc, eq } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { aiMessages, aiSessions } from "@/db/schema";
import { notFound } from "@/server/rpc/errors";

export type AiRole = (typeof aiMessages.$inferSelect)["role"];

/** The caller's session, or null when it does not exist or belongs to someone else. */
export async function getOwnedSession(db: DbLike, userId: string, sessionId: string) {
  const [row] = await db
    .select()
    .from(aiSessions)
    .where(and(eq(aiSessions.id, sessionId), eq(aiSessions.userId, userId)))
    .limit(1);
  return row ?? null;
}

/** Append a message to one of the caller's sessions and bump the session's lastMessageAt. */
export async function appendAiMessage(db: DbLike, userId: string, sessionId: string, role: AiRole, content: string): Promise<string> {
  const session = await getOwnedSession(db, userId, sessionId);
  if (!session) throw notFound("Session not found");
  const [row] = await db.insert(aiMessages).values({ userId, sessionId, role, content }).returning({ id: aiMessages.id });
  await db.update(aiSessions).set({ lastMessageAt: new Date() }).where(eq(aiSessions.id, sessionId));
  return row.id;
}

/** Bump a session's lastMessageAt (owner-checked; silently ignores foreign/missing sessions). */
export async function touchAiSession(db: DbLike, userId: string, sessionId: string): Promise<void> {
  await db.update(aiSessions).set({ lastMessageAt: new Date() }).where(and(eq(aiSessions.id, sessionId), eq(aiSessions.userId, userId)));
}

/** The last `limit` messages of an owned session, oldest first (chat order). Empty for foreign sessions. */
export async function getSessionMessages(db: DbLike, userId: string, sessionId: string, limit = 100) {
  const rows = await db
    .select({
      id: aiMessages.id,
      userId: aiMessages.userId,
      sessionId: aiMessages.sessionId,
      role: aiMessages.role,
      content: aiMessages.content,
      createdAt: aiMessages.createdAt,
    })
    .from(aiMessages)
    .where(and(eq(aiMessages.sessionId, sessionId), eq(aiMessages.userId, userId)))
    .orderBy(desc(aiMessages.createdAt), desc(aiMessages.id))
    .limit(limit);
  return rows.reverse();
}
