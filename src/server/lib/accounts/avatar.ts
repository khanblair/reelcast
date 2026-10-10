/**
 * Profile pictures. Each user's pictures live in their own Cloudinary folder, `reelcast/avatars/<userId>/`, under a
 * random public id, so the URL of a new picture is never the URL of an old one (no stale CDN copies) and everything a
 * user ever uploaded can be removed by prefix when the account is deleted.
 *
 * The browser uploads straight to Cloudinary with a signature from /api/cloudinary/sign-avatar, then tells the server
 * the resulting URL. The server never trusts that URL: it must be one of the caller's own avatar URLs in our cloud
 * (`parseAvatarUrl`) and Cloudinary must confirm the file exists and is a sane image (`checkAvatarFile`).
 */
import { randomBytes } from "node:crypto";
import { badRequest } from "@/server/rpc/errors";
import type { CloudinaryImageInfo } from "@/server/lib/cloudinary";

export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
export const AVATAR_MIN_SIDE = 64;
export const AVATAR_MAX_SIDE = 4096;
export const AVATAR_FORMATS = ["jpg", "jpeg", "png", "webp"] as const;

export const avatarFolder = (userId: string) => `reelcast/avatars/${userId}`;
/** Trailing slash on purpose: a prefix delete must never match another user's folder. */
export const avatarPrefix = (userId: string) => `${avatarFolder(userId)}/`;

/** A fresh random public id (the last path segment, 24 hex characters). */
export const newAvatarId = () => randomBytes(12).toString("hex");

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `https://res.cloudinary.com/<cloud>/image/upload/v123/reelcast/avatars/<userId>/<24 hex>.jpg`
 * -> its public id, or null for anything else (another user's folder, another cloud, a transformation URL,
 * a different host, http, a stray query string...).
 */
export function parseAvatarUrl(
  url: string,
  userId: string,
  cloudName: string | undefined = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME,
): { publicId: string; format: string } | null {
  if (!cloudName) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname !== "res.cloudinary.com" || u.port !== "" || u.username !== "" || u.password !== "") return null;
  if (u.search !== "" || u.hash !== "") return null;
  const re = new RegExp(
    `^/${escapeRegExp(cloudName)}/image/upload/(?:v\\d+/)?(${escapeRegExp(avatarFolder(userId))}/[a-f0-9]{24})\\.(jpg|jpeg|png|webp)$`,
  );
  const m = re.exec(u.pathname);
  return m ? { publicId: m[1], format: m[2] } : null;
}

/** Reject files Cloudinary reports as the wrong kind, too big, too small or too large. Throws BAD_REQUEST. */
export function checkAvatarFile(info: CloudinaryImageInfo | null): void {
  if (!info) throw badRequest("That image was not found. Upload it again.");
  if (info.resourceType !== "image" || info.type !== "upload") throw badRequest("That file is not a picture.");
  if (!(AVATAR_FORMATS as readonly string[]).includes(info.format)) throw badRequest("Use a JPG, PNG or WebP picture.");
  if (info.bytes > AVATAR_MAX_BYTES) throw badRequest("That picture is too large (5 MB maximum).");
  if (info.width < AVATAR_MIN_SIDE || info.height < AVATAR_MIN_SIDE) throw badRequest(`That picture is too small (at least ${AVATAR_MIN_SIDE}px).`);
  if (info.width > AVATAR_MAX_SIDE || info.height > AVATAR_MAX_SIDE) throw badRequest(`That picture is too large (${AVATAR_MAX_SIDE}px maximum).`);
}
