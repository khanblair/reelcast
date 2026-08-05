import { query } from "../_generated/server";

const FREE_LIMITS = { videosUploaded: 10, metadataGenerated: 5, veoGenerated: 0 };
const PRO_LIMITS  = { videosUploaded: 999_999, metadataGenerated: 999_999, veoGenerated: 5 };

/**
 * Current-month usage overview for all users.
 */
export const getOverview = query({
  args: {},
  handler: async (ctx) => {
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    const allUsers = await ctx.db.query("users").collect();

    return Promise.all(
      allUsers.map(async (user) => {
        const ledger = await ctx.db
          .query("usageLedger")
          .withIndex("by_user_month", (q) =>
            q.eq("userId", user._id).eq("month", month),
          )
          .unique();

        const plan = user.plan ?? "free";
        const limits = plan === "pro" ? PRO_LIMITS : FREE_LIMITS;

        return {
          userId: user._id,
          email: user.email,
          name: user.name,
          plan,
          month,
          videosUploaded:    ledger?.videosUploaded    ?? 0,
          metadataGenerated: ledger?.metadataGenerated ?? 0,
          veoGenerated:      ledger?.veoGenerated      ?? 0,
          limits,
        };
      }),
    );
  },
});
