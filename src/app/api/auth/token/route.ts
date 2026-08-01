import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createSign } from "crypto";

const PRIVATE_KEY_B64 = process.env.CONVEX_AUTH_PRIVATE_KEY!;
// iss must match auth.config.ts domain exactly — both point to the public convex.site URL
const CONVEX_SITE_URL = process.env.NEXT_PUBLIC_CONVEX_SITE_URL!;
const KID = "reelcast-1";

function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function signRS256(header: object, payload: object, privateKeyPem: string): string {
  const h = base64url(JSON.stringify(header));
  const p = base64url(JSON.stringify(payload));
  const signing = `${h}.${p}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signing);
  const sig = signer.sign(privateKeyPem, "base64");
  const sigUrl = sig.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  return `${signing}.${sigUrl}`;
}

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();

  if (error || !user) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  const privateKeyPem = Buffer.from(PRIVATE_KEY_B64, "base64").toString("utf-8");
  const now = Math.floor(Date.now() / 1000);

  const token = signRS256(
    { alg: "RS256", typ: "JWT", kid: KID },
    {
      iss: CONVEX_SITE_URL,
      aud: "reelcast",
      sub: user.id,
      email: user.email,
      name: user.user_metadata?.full_name ?? user.email,
      picture: user.user_metadata?.avatar_url,
      iat: now,
      exp: now + 60 * 60, // 1 hour
    },
    privateKeyPem
  );

  return NextResponse.json({ token });
}
