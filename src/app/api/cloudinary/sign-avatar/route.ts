import { NextResponse } from "next/server";
import { v2 as cloudinary } from "cloudinary";
import { getSessionUser } from "@/server/auth";
import { AVATAR_FORMATS, AVATAR_MAX_BYTES, avatarFolder, newAvatarId } from "@/server/lib/accounts/avatar";

/**
 * Signs ONE profile-picture upload. Everything that matters is fixed here and covered by the signature, so the
 * browser cannot change it: the folder is the caller's own avatar folder, the id is random, only JPG/PNG/WebP are
 * accepted, and Cloudinary shrinks anything larger than 1024px before storing it. The save step (users.updateProfile)
 * checks the uploaded file again.
 */
export async function POST() {
  let user: Awaited<ReturnType<typeof getSessionUser>> = null;
  try {
    user = await getSessionUser();
  } catch {
    user = null;
  }
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const cloudName = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME;
  if (!apiSecret || !apiKey || !cloudName) return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });

  const params = {
    allowed_formats: AVATAR_FORMATS.join(","),
    folder: avatarFolder(user.id),
    public_id: newAvatarId(),
    timestamp: Math.round(Date.now() / 1000),
    transformation: "c_limit,w_1024,h_1024",
  };
  const signature = cloudinary.utils.api_sign_request(params, apiSecret);
  return NextResponse.json({ ...params, signature, apiKey, cloudName, maxBytes: AVATAR_MAX_BYTES }, { headers: { "Cache-Control": "no-store" } });
}
