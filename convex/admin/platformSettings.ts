import { v } from "convex/values";
import { mutation, query, internalQuery } from "../_generated/server";
import { getCurrentUserOrThrow } from "../lib/auth";

async function requireAdmin(ctx: { auth: { getUserIdentity: () => Promise<{ subject: string } | null> }; db: any }) {
  const identity = await getCurrentUserOrThrow(ctx as any);
  const user = await ctx.db
    .query("users")
    .withIndex("by_supabase_id", (q: any) => q.eq("supabaseId", identity.subject))
    .unique();
  if (!user?.isAdmin) throw new Error("Admin required");
}

// Admin-facing query — returns only whether keys are set, never the values
export const getStatus = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx as any);
    const row = await ctx.db.query("platformSettings").first();
    return {
      deepseekKeySet: !!(row?.deepseekApiKey),
      geminiKeySet: !!(row?.geminiApiKey),
    };
  },
});

// Admin mutation — upserts the singleton row
export const update = mutation({
  args: {
    deepseekApiKey: v.optional(v.string()),
    geminiApiKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx as any);
    const existing = await ctx.db.query("platformSettings").first();
    const patch: Record<string, string | undefined> = {};
    if (args.deepseekApiKey !== undefined) patch.deepseekApiKey = args.deepseekApiKey || undefined;
    if (args.geminiApiKey !== undefined) patch.geminiApiKey = args.geminiApiKey || undefined;
    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("platformSettings", patch);
    }
  },
});

// Internal query — used by AI actions to read the actual keys (never exposed to client)
export const getInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    return ctx.db.query("platformSettings").first();
  },
});
