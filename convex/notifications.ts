import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Helper function to verify user authentication
async function getUserId(ctx: any) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new Error("Unauthenticated call");
  }
  const user = await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q: any) => q.eq("clerkId", identity.subject))
    .first();
  
  if (!user) {
    throw new Error("User not found");
  }
  return user._id;
}

export const get = query({
  handler: async (ctx) => {
    try {
      const userId = await getUserId(ctx);
      return await ctx.db
        .query("notifications")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .order("desc")
        .take(50); // Get recent 50 notifications
    } catch (e) {
      return []; // Return empty array if unauthenticated to avoid hard crashes on mount
    }
  },
});

export const markAsRead = mutation({
  args: { notificationId: v.id("notifications") },
  handler: async (ctx, args) => {
    const userId = await getUserId(ctx);
    const notification = await ctx.db.get(args.notificationId);
    
    if (!notification || notification.userId !== userId) {
      throw new Error("Notification not found or unauthorized");
    }
    
    await ctx.db.patch(args.notificationId, { isRead: true });
  },
});

export const markAllAsRead = mutation({
  handler: async (ctx) => {
    const userId = await getUserId(ctx);
    const unreadNotifications = await ctx.db
      .query("notifications")
      .withIndex("by_user_read", (q) => q.eq("userId", userId).eq("isRead", false))
      .collect();
      
    for (const notif of unreadNotifications) {
      await ctx.db.patch(notif._id, { isRead: true });
    }
  },
});

export const clearAll = mutation({
  handler: async (ctx) => {
    const userId = await getUserId(ctx);
    const notifications = await ctx.db
      .query("notifications")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
      
    for (const notif of notifications) {
      await ctx.db.delete(notif._id);
    }
  },
});

export const createDummy = mutation({
  args: {
    title: v.string(),
    message: v.string(),
    type: v.union(v.literal("info"), v.literal("success"), v.literal("warning"), v.literal("error")),
  },
  handler: async (ctx, args) => {
    const userId = await getUserId(ctx);
    return await ctx.db.insert("notifications", {
      userId,
      title: args.title,
      message: args.message,
      type: args.type,
      isRead: false,
    });
  },
});
