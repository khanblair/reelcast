import { v } from "convex/values";
import { mutation } from "../_generated/server";

const typeValidator = v.union(
  v.literal("info"),
  v.literal("success"),
  v.literal("warning"),
  v.literal("error"),
);

/**
 * Send a notification to every user in the system.
 */
export const broadcastToAll = mutation({
  args: {
    title:   v.string(),
    message: v.string(),
    type:    typeValidator,
    link:    v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const allUsers = await ctx.db.query("users").collect();
    await Promise.all(
      allUsers.map((user) =>
        ctx.db.insert("notifications", {
          userId:  user._id,
          title:   args.title,
          message: args.message,
          type:    args.type,
          isRead:  false,
          link:    args.link,
        }),
      ),
    );
    return { sent: allUsers.length };
  },
});

/**
 * Send a notification to a single specific user.
 */
export const sendToUser = mutation({
  args: {
    userId:  v.id("users"),
    title:   v.string(),
    message: v.string(),
    type:    typeValidator,
    link:    v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("notifications", {
      userId:  args.userId,
      title:   args.title,
      message: args.message,
      type:    args.type,
      isRead:  false,
      link:    args.link,
    });
  },
});
