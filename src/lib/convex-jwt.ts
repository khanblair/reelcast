import { createSign } from "crypto";

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
  return `${signing}.${sig.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")}`;
}

export function mintConvexJwt(
  userId: string,
  email?: string,
  name?: string,
  picture?: string,
): string {
  const privateKeyPem = Buffer.from(process.env.CONVEX_AUTH_PRIVATE_KEY!, "base64").toString("utf-8");
  const now = Math.floor(Date.now() / 1000);
  return signRS256(
    { alg: "RS256", typ: "JWT", kid: "reelcast-1" },
    {
      iss: process.env.NEXT_PUBLIC_CONVEX_SITE_URL!,
      aud: "reelcast",
      sub: userId,
      email,
      name,
      picture,
      iat: now,
      exp: now + 3600,
    },
    privateKeyPem,
  );
}
