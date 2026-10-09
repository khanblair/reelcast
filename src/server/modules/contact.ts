// Port of convex/contact.ts. Export ONLY rpc definitions from this file.
// Public (the form lives on the pre-login marketing site). Abuse limit without a new table:
// the insert only happens while the recent submissions for this email and overall are under a cap.
import { sql } from "drizzle-orm";
import { z } from "zod";
import { RpcError, badRequest } from "../rpc/errors";
import { mutation } from "../rpc/define";

const PER_EMAIL_PER_HOUR = 3;
const GLOBAL_PER_HOUR = 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const submit = mutation({
  auth: "public",
  // Hard upper bounds only; friendly validation (and its messages) happens in the handler because
  // the contact form shows err.message verbatim.
  input: z.object({
    name: z.string().max(5_000),
    email: z.string().max(5_000),
    subject: z.string().max(5_000),
    message: z.string().max(50_000),
  }),
  handler: async (ctx, args) => {
    const name = args.name.trim();
    const email = args.email.trim();
    const subject = args.subject.trim();
    const message = args.message.trim();

    if (!name || !email || !subject || !message) throw badRequest("All fields are required.");
    if (!EMAIL_RE.test(email) || email.length > 320) throw badRequest("Please enter a valid email address.");
    if (name.length > 200) throw badRequest("Name is too long (200 characters max).");
    if (subject.length > 300) throw badRequest("Subject is too long (300 characters max).");
    if (message.length > 5_000) throw badRequest("Message is too long (5000 characters max).");

    const rows = (await ctx.db.execute(sql`
      insert into contact_submissions (name, email, subject, message)
      select ${name}, ${email}, ${subject}, ${message}
      where (select count(*) from contact_submissions
              where lower(email) = lower(${email}) and created_at > now() - interval '1 hour') < ${PER_EMAIL_PER_HOUR}
        and (select count(*) from contact_submissions
              where created_at > now() - interval '1 hour') < ${GLOBAL_PER_HOUR}
      returning id
    `)) as unknown as { id: string }[];

    if (rows.length === 0) throw new RpcError("RATE_LIMITED", "Too many messages. Please try again in an hour.");
  },
});
