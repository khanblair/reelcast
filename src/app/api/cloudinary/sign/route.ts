import { NextResponse } from "next/server";
import { v2 as cloudinary } from "cloudinary";
import { PLAN_UPLOAD_LIMIT_BYTES } from "@/lib/plan-limits";
import { getSessionUser } from "@/server/auth";
import { videoUploadParams } from "@/server/lib/videoUpload";

/**
 * Signs ONE video upload. The browser never chooses anything: the folder is the caller's own (`reelcast/videos/<id>`),
 * the public id is random, only video formats are accepted, an existing file is never overwritten, and the size limit
 * comes from the user's plan (users.plan, set only by billing code or an admin). All of it is covered by the signature,
 * so the browser must send exactly the `params` returned here (src/lib/upload-video.ts does) or Cloudinary refuses it.
 * The upload URL is returned too, so the resource type (video) is fixed here as well: Cloudinary does not sign it.
 */
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
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const cloudName = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME;
  if (!apiSecret || !apiKey || !cloudName) {
    return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
  }

  const maxFileSize = PLAN_UPLOAD_LIMIT_BYTES[user.plan] ?? PLAN_UPLOAD_LIMIT_BYTES.free;

  try {
    const params = videoUploadParams(user.id, maxFileSize);
    const signature = cloudinary.utils.api_sign_request(params, apiSecret);
    return NextResponse.json(
      { uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/video/upload`, apiKey, signature, params },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error: unknown) {
    console.error("Cloudinary signature generation failed:", error);
    return NextResponse.json({ error: "Failed to generate upload signature" }, { status: 500 });
  }
}
