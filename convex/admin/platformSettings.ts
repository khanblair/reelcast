import { v } from "convex/values";
import { mutation, query, internalQuery, internalMutation, QueryCtx, MutationCtx } from "../_generated/server";
import { getCurrentUserOrThrow } from "../lib/auth";

async function requireAdmin(ctx: QueryCtx | MutationCtx) {
  const identity = await getCurrentUserOrThrow(ctx);
  const user = await ctx.db
    .query("users")
    .withIndex("by_supabase_id", (q) => q.eq("supabaseId", identity.subject))
    .unique();
  if (!user?.isAdmin) throw new Error("Admin required");
  return user;
}

// Admin-facing query — returns key presence and non-secret PayPal config,
// never the client secret itself.
export const getStatus = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const row = await ctx.db.query("platformSettings").first();
    return {
      deepseekKeySet: !!(row?.deepseekApiKey),
      geminiKeySet: !!(row?.geminiApiKey),
      paypalConfigured: !!(row?.paypalClientId && row?.paypalClientSecret),
      paypalEnvironment: row?.paypalEnvironment ?? "sandbox",
      paypalProductId: row?.paypalProductId,
      paypalPlanId: row?.paypalPlanId,
      paypalWebhookId: row?.paypalWebhookId,
    };
  },
});

// Admin mutation — upserts the singleton row
export const update = mutation({
  args: {
    deepseekApiKey: v.optional(v.string()),
    geminiApiKey: v.optional(v.string()),
    paypalClientId: v.optional(v.string()),
    paypalClientSecret: v.optional(v.string()),
    paypalEnvironment: v.optional(v.union(v.literal("sandbox"), v.literal("live"))),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const existing = await ctx.db.query("platformSettings").first();
    const patch: Record<string, string | undefined> = {};
    if (args.deepseekApiKey !== undefined) patch.deepseekApiKey = args.deepseekApiKey || undefined;
    if (args.geminiApiKey !== undefined) patch.geminiApiKey = args.geminiApiKey || undefined;
    if (args.paypalClientId !== undefined) patch.paypalClientId = args.paypalClientId || undefined;
    if (args.paypalClientSecret !== undefined) patch.paypalClientSecret = args.paypalClientSecret || undefined;
    if (args.paypalEnvironment !== undefined) patch.paypalEnvironment = args.paypalEnvironment;
    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("platformSettings", patch);
    }
  },
});

// Internal mutation — stores the product_id + plan_id created by
// convex/actions/paypal.ts setupBilling (admin-only action), and the
// webhook_id created by registerWebhook.
export const internalSetPaypalCatalog = internalMutation({
  args: {
    productId: v.optional(v.string()),
    planId: v.optional(v.string()),
    webhookId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("platformSettings").first();
    const patch: Record<string, string> = {};
    if (args.productId !== undefined) patch.paypalProductId = args.productId;
    if (args.planId !== undefined) patch.paypalPlanId = args.planId;
    if (args.webhookId !== undefined) patch.paypalWebhookId = args.webhookId;
    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("platformSettings", patch);
    }
  },
});

// Internal query — used by billing actions to read the actual credentials
// (never exposed to client via getStatus above).
export const getInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    return ctx.db.query("platformSettings").first();
  },
});
