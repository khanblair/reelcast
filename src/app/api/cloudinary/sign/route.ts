import { NextResponse } from "next/server";
import { v2 as cloudinary } from "cloudinary";
import { getSessionUser } from "@/server/auth";
import { PLAN_UPLOAD_LIMIT_BYTES } from "@/server/lib/usage";

cloudinary.config({
  cloud_name: process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export async function POST() {
  let user: Awaited<ReturnType<typeof getSessionUser>> = null;
  try {
    user = await getSessionUser();
  } catch {
    user = null;
  }
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!apiSecret) {
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  // Upload size limit comes from the user's plan (users.plan, set only by billing code or an admin).
  const maxFileSize = PLAN_UPLOAD_LIMIT_BYTES[user.plan] ?? PLAN_UPLOAD_LIMIT_BYTES.free;

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
