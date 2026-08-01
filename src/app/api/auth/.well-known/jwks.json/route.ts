import { NextResponse } from "next/server";

const JWK = {
  kty: "RSA",
  n: "l1ONlPsRK6m6AwxU3EBI0zmd_wQd42ehc5hkrb5XYbaAsv8yU0l_7NCwIvSXHHRnfeM8CtTjfbKehnP96sbNqCuzf9ZvzHt9EfRhR5dPTNZQ5T79Qe84AQKj-aFDHqvLer0z3GsGJ-eD0MfxjmdDeEUVaJe3m-vHTWHei6JKzwcT8L_1yhZXFyPDtziQltVhst2HHTe-1_Aqmac5ItMk3o1BVqVmOWBsyu8coysT8RaM4BNJGNGEHqr-n7ua1KwNI1GN_ZH4mnsiYlcp0tOM2lWk9NwpdzrgpjUm0cZeUBvkIcKHgcwI7X_9ek7tA7LO8yQX7qlxiUqkNOMuiwAMWw",
  e: "AQAB",
  use: "sig",
  alg: "RS256",
  kid: "reelcast-1",
};

export async function GET() {
  return NextResponse.json(
    { keys: [JWK] },
    { headers: { "Cache-Control": "public, max-age=3600" } }
  );
}
