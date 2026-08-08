import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { mintConvexJwt } from "@/lib/convex-jwt";
import { fetchQuery } from "convex/nextjs";
import { api } from "../../../../../convex/_generated/api";
import { v2 as cloudinary } from "cloudinary";

cloudinary.config({
  cloud_name: process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Upload size limits in bytes per plan
const PLAN_SIZE_LIMITS: Record<string, number> = {
  free: 100 * 1024 * 1024,    // 100 MB
  pro: 500 * 1024 * 1024,     // 500 MB
  elite: 2 * 1024 * 1024 * 1024, // 2 GB
};

export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!apiSecret) {
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  // Fetch user plan from Convex to enforce upload size limit
  let planKey = "free";
  try {
    const convexToken = mintConvexJwt(
      user.id,
      user.email,
      user.user_metadata?.full_name ?? user.email,
      user.user_metadata?.avatar_url,
    );
    const convexUser = await fetchQuery(api.users.current, {}, { token: convexToken });
    planKey = (convexUser as any)?.plan ?? "free";
  } catch {
    // Non-fatal: default to free limits if Convex lookup fails
  }

  const maxFileSize = PLAN_SIZE_LIMITS[planKey] ?? PLAN_SIZE_LIMITS.free;

  try {
    const timestamp = Math.round(Date.now() / 1000);
    const signParams: Record<string, unknown> = { timestamp, max_file_size: maxFileSize };
    const signature = cloudinary.utils.api_sign_request(signParams, apiSecret);
    return NextResponse.json({
      signature,
      timestamp,
      apiKey: process.env.CLOUDINARY_API_KEY,
      cloudName: process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME,
      maxFileSize,
    });
  } catch (error: unknown) {
    console.error("Cloudinary signature generation failed:", error);
    return NextResponse.json({ error: "Failed to generate upload signature" }, { status: 500 });
  }
}
