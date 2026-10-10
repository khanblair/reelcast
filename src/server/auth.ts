/**
 * Server-side session + user resolution. The only place that turns a Supabase session
 * cookie into a trusted user id. Everything else (RPC handlers, route handlers) uses
 * `getSessionUser()` / `requireUser()` / `requireAdmin()`.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { createClient } from "@/lib/supabase/server";
import { forbidden, unauthenticated } from "./rpc/errors";

export type UserRow = typeof users.$inferSelect;

type Claims = {
  sub: string;
  email?: string;
  user_metadata?: { full_name?: string; name?: string; avatar_url?: string; picture?: string };
};

/** Verified claims from the Supabase session cookie, or null. Verifies the JWT locally when possible. */
export async function getSessionClaims(): Promise<Claims | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims?.sub) return null;
  return data.claims as unknown as Claims;
}

/** Find the app user row for a verified auth id; create it on first sight. */
export async function ensureUser(claims: Claims): Promise<UserRow> {
  const existing = await db.select().from(users).where(eq(users.id, claims.sub)).limit(1);
  if (existing[0]) return existing[0];

  const meta = claims.user_metadata ?? {};
  const email = claims.email;
  if (!email) throw unauthenticated("Account has no email");
  try {
    const [row] = await db
      .insert(users)
      .values({
        id: claims.sub,
        email,
        name: meta.full_name ?? meta.name ?? null,
        imageUrl: meta.avatar_url ?? meta.picture ?? null,
      })
      .onConflictDoUpdate({ target: users.id, set: { email } })
      .returning();
    return row;
  } catch (err) {
    // users.id references auth.users(id). A token can outlive its account (it stays valid until it expires), and
    // once the account is deleted that reference fails: the person is signed out, not a server error.
    if (isForeignKeyViolation(err)) throw unauthenticated("This account no longer exists");
    throw err;
  }
}

function isForeignKeyViolation(err: unknown): boolean {
  for (let e = err as { code?: string; cause?: unknown } | undefined, depth = 0; e && depth < 4; e = e.cause as typeof e, depth++) {
    if (e.code === "23503") return true;
  }
  return false;
}

/** Signed-in user row or null. */
export async function getSessionUser(): Promise<UserRow | null> {
  const claims = await getSessionClaims();
  return claims ? ensureUser(claims) : null;
}

export async function requireUser(): Promise<UserRow> {
  const user = await getSessionUser();
  if (!user) throw unauthenticated();
  return user;
}

/** Admin status is always read from the database, never from token claims. */
export async function requireAdmin(): Promise<UserRow> {
  const user = await requireUser();
  if (!user.isAdmin) throw forbidden("Admin access required");
  return user;
}
