import { v } from "convex/values";
import { mutation } from "./_generated/server";

// Public mutation — the contact form lives on the pre-login marketing site,
// so this intentionally does NOT require an authenticated user.
export const submit = mutation({
  args: {
    name: v.string(),
    email: v.string(),
    subject: v.string(),
    message: v.string(),
  },
  handler: async (ctx, args) => {
    const name = args.name.trim();
    const email = args.email.trim();
    const subject = args.subject.trim();
    const message = args.message.trim();

    if (!name || !email || !subject || !message) {
      throw new Error("All fields are required.");
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error("Please enter a valid email address.");
    }

    await ctx.db.insert("contactSubmissions", {
      name,
      email,
      subject,
      message,
      status: "new",
    });
  },
});
