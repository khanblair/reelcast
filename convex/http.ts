import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { Webhook } from "svix";
import type { WebhookEvent } from "@clerk/nextjs/server";

const http = httpRouter();

http.route({
  path: "/clerk",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const payloadString = await request.text();
    const headerPayload = request.headers;

    const svixId = headerPayload.get("svix-id");
    const svixIdTimeStamp = headerPayload.get("svix-timestamp");
    const svixSignature = headerPayload.get("svix-signature");
    if (!svixId || !svixIdTimeStamp || !svixSignature) {
      return new Response("Missing svix headers", { status: 400 });
    }

    const webhookSecret = process.env.CLERK_WEBHOOK_SECRET;
    if (!webhookSecret) {
      throw new Error("Missing CLERK_WEBHOOK_SECRET");
    }

    const wh = new Webhook(webhookSecret);
    let evt: WebhookEvent;
    try {
      evt = wh.verify(payloadString, {
        "svix-id": svixId,
        "svix-timestamp": svixIdTimeStamp,
        "svix-signature": svixSignature,
      }) as WebhookEvent;
    } catch {
      console.error("Error verifying webhook");
      return new Response("Error occurred", { status: 400 });
    }

    const eventType = evt.type;
    if (eventType === "user.created" || eventType === "user.updated") {
      const { id, email_addresses, first_name, last_name, image_url } = evt.data;
      const email = email_addresses[0]?.email_address;
      const name = [first_name, last_name].filter(Boolean).join(" ");
      
      await ctx.runMutation(internal.users.upsertFromClerk, {
        clerkId: id,
        email: email || "",
        name: name || undefined,
        imageUrl: image_url || undefined,
      });
    }

    if (eventType === "user.deleted") {
      const { id } = evt.data;
      if (id) {
        await ctx.runMutation(internal.users.deleteFromClerk, {
          clerkId: id,
        });
      }
    }

    return new Response("Webhook processed", { status: 200 });
  }),
});

export default http;
