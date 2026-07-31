import { createClient } from "@/lib/supabase/server";
import { fetchMutation } from "convex/nextjs";
import { api } from "../../../../../convex/_generated/api";

function getAppOrigin(request: Request) {
  if (process.env.NEXT_PUBLIC_APP_URL) {
    return process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  }
  return new URL(request.url).origin;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");

  if (!code) {
    return new Response("Missing authorization code", { status: 400 });
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return new Response("Missing Google OAuth client credentials", { status: 500 });
  }

  const origin = getAppOrigin(request);
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
    return new Response(`Google token exchange failed: ${errorText}`, { status: 500 });
  }

  const tokens = await tokenResponse.json();

  // Fetch the connected channel name so we can display it in settings
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
    // Non-fatal — we still save the tokens even if the channel name fetch fails
  }

  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();

  if (!session) {
    return new Response("Not authenticated — please sign in first", { status: 401 });
  }

  await fetchMutation(
    api.users.saveYoutubeTokens,
    {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
      channelName,
    },
    { token: session.access_token }
  );

  return Response.redirect(`${origin}/settings?youtube=connected`, 302);
}
