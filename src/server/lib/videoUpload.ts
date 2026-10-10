/**
 * Video uploads. The browser sends the file straight to Cloudinary with a signature from /api/cloudinary/sign, and
 * everything that matters about that upload is decided here and covered by the signature, so the browser cannot change it
 * (the same design as profile pictures, see accounts/avatar.ts):
 *
 *  - the folder is the caller's own, `reelcast/videos/<userId>`, and the public id is random: one signature can only
 *    ever create one file in one user's folder, never overwrite anything (`overwrite=false`), and never touch another
 *    user's files or the avatar folders;
 *  - only video formats are accepted (`allowed_formats`), so the signature cannot be used to host arbitrary files;
 *  - `max_file_size` carries the plan's limit.
 *
 * Nothing downstream depends on WHERE a video lives. A video row stores the file's delivery URL, and every consumer
 * (`isAllowedMediaUrl`, publishing, storage checks, account deletion) works from that URL and the public id in it, so
 * files uploaded before this folder existed (public id at the root) keep working unchanged.
 */
import { randomBytes } from "node:crypto";

/**
 * What a video upload may be, as Cloudinary names formats. Wide on purpose (anything a browser calls `video/*` that
 * YouTube also takes); to allow another one, add it here.
 */
export const VIDEO_FORMATS = ["mp4", "mov", "webm", "mkv", "avi", "wmv", "flv", "m4v", "mpg", "mpeg", "3gp"] as const;

export const videoFolder = (userId: string) => `reelcast/videos/${userId}`;
/** Trailing slash on purpose: a prefix operation must never match another user's folder. */
export const videoPrefix = (userId: string) => `${videoFolder(userId)}/`;

/** A fresh random public id (the last path segment, 24 hex characters). */
export const newVideoPublicId = () => randomBytes(12).toString("hex");

/** The Cloudinary upload parameters the server signs. Values are strings or numbers exactly as they go on the wire. */
export type VideoUploadParams = {
  allowed_formats: string;
  folder: string;
  max_file_size: number;
  overwrite: string;
  public_id: string;
  timestamp: number;
};

/**
 * `now` and `publicId` are injectable for tests. `resource_type` is deliberately absent: Cloudinary takes it from the
 * URL (`/video/upload`) and never signs it.
 */
export function videoUploadParams(
  userId: string,
  maxFileSize: number,
  now: number = Date.now(),
  publicId: string = newVideoPublicId(),
): VideoUploadParams {
  return {
    allowed_formats: VIDEO_FORMATS.join(","),
    folder: videoFolder(userId),
    max_file_size: maxFileSize,
    overwrite: "false",
    public_id: publicId,
    timestamp: Math.round(now / 1000),
  };
}
