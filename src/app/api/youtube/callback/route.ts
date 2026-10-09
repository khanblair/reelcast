import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { db } from "@/db/client";
import { getSessionUser } from "@/server/auth";
import { saveYoutubeConnection } from "@/server/lib/accounts/channels";
import { RpcError } from "@/server/rpc/errors";

const STATE_COOKIE = "yt_oauth_state";
const GOOGLE_TIMEOUT_MS = 15_000;

function getAppOrigin(request: Request) {
  if (process.env.NEXT_PUBLIC_APP_URL) {
    return process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  }
  return new URL(request.url).origin;
}

/** Redirect and retire the one-time CSRF state cookie. */
function redirect(url: string) {
  const res = NextResponse.redirect(url, 302);
  res.cookies.set(STATE_COOKIE, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: 0, path: "/" });
  return res;
}

export async function GET(request: Request) {
  const origin = getAppOrigin(request);
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const stateParam = url.searchParams.get("state");

  // Validate CSRF state
  const cookieStore = await cookies();
  const stateCookie = cookieStore.get(STATE_COOKIE)?.value;
  if (!stateParam || !stateCookie || stateParam !== stateCookie) {
    return redirect(`${origin}/settings?youtube=error&reason=state_mismatch`);
  }

  if (error) {
    return redirect(`${origin}/settings?youtube=error&reason=${encodeURIComponent(error)}`);
  }

  if (!code) {
    return redirect(`${origin}/settings?youtube=error&reason=missing_code`);
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return redirect(`${origin}/settings?youtube=error&reason=server_config`);
  }

  // The session must still be valid before we spend the one-time authorization code.
  let user: Awaited<ReturnType<typeof getSessionUser>> = null;
  try {
    user = await getSessionUser();
  } catch {
    user = null;
  }
  if (!user) {
    return redirect(`${origin}/sign-in?redirect_url=/settings`);
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
    signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
  }).catch(() => null);

  if (!tokenResponse || !tokenResponse.ok) {
    console.error("YouTube token exchange failed:", tokenResponse ? tokenResponse.status : "network error");
    return redirect(`${origin}/settings?youtube=error&reason=token_exchange`);
  }

  const tokens = (await tokenResponse.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!tokens.access_token) {
    return redirect(`${origin}/settings?youtube=error&reason=token_exchange`);
  }

  // Fetch connected channel name + ID
  let channelName: string | undefined;
  let channelId: string | undefined;
  try {
    const channelRes = await fetch(
      "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
      { headers: { Authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS) }
    );
    if (channelRes.ok) {
      const channelData = await channelRes.json();
      channelName = channelData.items?.[0]?.snippet?.title as string | undefined;
      channelId = channelData.items?.[0]?.id as string | undefined;
    }
  } catch {
    // handled below: without a channel id there is nothing to store
  }

  // Every stored connection is tied to a channel id (unique across accounts). Convex could keep
  // channel-less tokens on the user row; here that would be an unusable, unrevocable orphan.
  if (!channelId) {
    return redirect(`${origin}/settings?youtube=error&reason=no_channel`);
  }

  try {
    await saveYoutubeConnection(db, user.id, {
      channelId,
      channelName,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in ?? 3600,
    });
  } catch (err) {
    if (err instanceof RpcError && err.code === "CONFLICT") {
      return redirect(`${origin}/settings?youtube=error&reason=channel_already_claimed`);
    }
    if (err instanceof RpcError && err.code === "PLAN_LIMIT_EXCEEDED") {
      return redirect(`${origin}/settings?youtube=error&reason=channel_limit`);
    }
    console.error("Failed to save YouTube connection:", err instanceof Error ? err.message : err);
    return redirect(`${origin}/settings?youtube=error&reason=save_failed`);
  }

  return redirect(`${origin}/settings?youtube=connected`);
}
