"use node";

import { action } from "../_generated/server";
import { api } from "../_generated/api";
import { getCurrentUserOrThrow } from "../lib/auth";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://reelcast.app";

/**
 * Creates a Lemon Squeezy hosted checkout URL for the current authenticated
 * user to upgrade to Pro.
 *
 * Requires these Convex-side env vars (set via `npx convex env set ...`,
 * NOT via .env.local — Convex actions run in Convex's own deployment and
 * read process.env from Convex's own env store):
 *   LEMONSQUEEZY_API_KEY
 *   LEMONSQUEEZY_STORE_ID
 *   LEMONSQUEEZY_PRO_VARIANT_ID
 *
 * checkout_data.custom.user_id is set to the Convex user's _id so the
 * webhook handler (convex/http.ts) can map the subscription back to this
 * user via meta.custom_data on subsequent webhook events.
 */
export const createCheckoutUrl = action({
  args: {},
  handler: async (ctx): Promise<{ url: string }> => {
    // Gate: only authenticated users may generate a checkout link tied to
    // their own user id.
    await getCurrentUserOrThrow(ctx);
    const user = await ctx.runQuery(api.users.current, {});
    if (!user) {
      throw new Error("User not found.");
    }

    const apiKey = process.env.LEMONSQUEEZY_API_KEY;
    const storeId = process.env.LEMONSQUEEZY_STORE_ID;
    const variantId = process.env.LEMONSQUEEZY_PRO_VARIANT_ID;

    if (!apiKey || !storeId || !variantId) {
      throw new Error(
        "Lemon Squeezy is not configured. Set LEMONSQUEEZY_API_KEY, LEMONSQUEEZY_STORE_ID, " +
          "and LEMONSQUEEZY_PRO_VARIANT_ID via `npx convex env set`.",
      );
    }

    const response = await fetch("https://api.lemonsqueezy.com/v1/checkouts", {
      method: "POST",
      headers: {
        Accept: "application/vnd.api+json",
        "Content-Type": "application/vnd.api+json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        data: {
          type: "checkouts",
          attributes: {
            checkout_data: {
              email: user.email,
              custom: {
                user_id: user._id,
              },
            },
            product_options: {
              redirect_url: `${APP_URL}/settings?billing=success`,
            },
          },
          relationships: {
            store: {
              data: { type: "stores", id: String(storeId) },
            },
            variant: {
              data: { type: "variants", id: String(variantId) },
            },
          },
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error("[billing] Lemon Squeezy checkout creation failed:", response.status, text);
      throw new Error(`Failed to create checkout: ${response.status}`);
    }

    const body = (await response.json()) as {
      data?: { attributes?: { url?: string } };
    };

    const url = body.data?.attributes?.url;
    if (!url) {
      throw new Error("Lemon Squeezy did not return a checkout URL.");
    }

    return { url };
  },
});
