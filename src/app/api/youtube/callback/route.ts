import { createClient } from "@/lib/supabase/server";
import { mintConvexJwt } from "@/lib/convex-jwt";
import { fetchMutation } from "convex/nextjs";
import { api } from "../../../../../convex/_generated/api";

function getAppOrigin(request: Request) {
  if (process.env.NEXT_PUBLIC_APP_URL) {
    return process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  }
  return new URL(request.url).origin;
}

export async function GET(request: Request) {
  const origin = getAppOrigin(request);
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    return Response.redirect(`${origin}/settings?youtube=error&reason=${encodeURIComponent(error)}`, 302);
  }

  if (!code) {
    return Response.redirect(`${origin}/settings?youtube=error&reason=missing_code`, 302);
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return Response.redirect(`${origin}/settings?youtube=error&reason=server_config`, 302);
  }

  const redirectUri = `${origin}/api/youtube/callback`;

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    console.error("YouTube token exchange failed:", errorText);
    return Response.redirect(`${origin}/settings?youtube=error&reason=token_exchange`, 302);
  }

  const tokens = await tokenResponse.json();

  // Fetch connected channel name
  let channelName: string | undefined;
  try {
    const channelRes = await fetch(
      "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
      { headers: { Authorization: `Bearer ${tokens.access_token}` } }
    );
    if (channelRes.ok) {
      const channelData = await channelRes.json();
      channelName = channelData.items?.[0]?.snippet?.title as string | undefined;
    }
  } catch {
    // Non-fatal, still save the tokens
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return Response.redirect(`${origin}/sign-in?redirect_url=/settings`, 302);
  }

  // Mint a proper Convex RS256 JWT (the Supabase access_token uses a different
  // issuer and would be rejected by our Convex auth config)
  const convexToken = mintConvexJwt(
    user.id,
    user.email,
    user.user_metadata?.full_name ?? user.email,
    user.user_metadata?.avatar_url,
  );

  try {
    await fetchMutation(
      api.users.saveYoutubeTokens,
      {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresIn: tokens.expires_in,
        channelName,
      },
      { token: convexToken }
    );
  } catch (err) {
    console.error("Failed to save YouTube tokens to Convex:", err);
    return Response.redirect(`${origin}/settings?youtube=error&reason=save_failed`, 302);
  }

  return Response.redirect(`${origin}/settings?youtube=connected`, 302);
}
