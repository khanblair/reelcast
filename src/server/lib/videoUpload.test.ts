/**
 * Videos uploaded into the per-user folder must be recognised everywhere a video URL is checked or used, and videos
 * uploaded before the folder existed must keep working. Everything here is pure: the only environment is the cloud name.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { extractCloudinaryPublicId, isAllowedMediaUrl } from "@/server/lib/cloudinary";
import { isCloudinaryUrl as isContentCloudinaryUrl } from "@/server/lib/content/schemas";
import { frameUrl, isCloudinaryUrl as isAiCloudinaryUrl } from "@/server/lib/ai/video";
import { avatarPrefix } from "@/server/lib/accounts/avatar";
import { VIDEO_FORMATS, newVideoPublicId, videoFolder, videoPrefix, videoUploadParams } from "./videoUpload";

const CLOUD = "demo-cloud";
const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ID = "0123456789abcdef01234567";
const url = (path: string, cloud = CLOUD) => `https://res.cloudinary.com/${cloud}/video/upload/${path}`;

let previousCloud: string | undefined;
beforeEach(() => {
  previousCloud = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME;
  process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME = CLOUD;
});
afterEach(() => {
  if (previousCloud === undefined) delete process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME;
  else process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME = previousCloud;
});

describe("folders, ids and parameters", () => {
  test("the folder is per user and the prefix ends with a slash, so a prefix operation cannot reach another user", () => {
    expect(videoFolder(ME)).toBe(`reelcast/videos/${ME}`);
    expect(videoPrefix(ME)).toBe(`${videoFolder(ME)}/`);
    expect(`${videoFolder(OTHER)}/x`.startsWith(videoPrefix(ME))).toBe(false);
    expect(videoPrefix(ME).startsWith(avatarPrefix(ME))).toBe(false);
    expect(avatarPrefix(ME).startsWith(videoPrefix(ME))).toBe(false);
  });

  test("new ids are 24 lower-case hex characters and differ each time", () => {
    const a = newVideoPublicId();
    expect(a).toMatch(/^[a-f0-9]{24}$/);
    expect(newVideoPublicId()).not.toBe(a);
  });

  test("the parameters are fixed by the server: folder, id, formats, no overwrite, size, whole-second timestamp", () => {
    const p = videoUploadParams(ME, 123, 1_760_000_000_400, ID);
    expect(p).toEqual({
      allowed_formats: VIDEO_FORMATS.join(","),
      folder: `reelcast/videos/${ME}`,
      max_file_size: 123,
      overwrite: "false",
      public_id: ID,
      timestamp: 1_760_000_000,
    });
  });

  test("only video formats are allowed", () => {
    expect(new Set(VIDEO_FORMATS).size).toBe(VIDEO_FORMATS.length);
    for (const f of VIDEO_FORMATS) expect(f).toMatch(/^[a-z0-9]+$/);
    for (const bad of ["jpg", "png", "gif", "svg", "webp", "html", "js", "php", "exe", "pdf", "zip", "txt"]) {
      expect(VIDEO_FORMATS as readonly string[]).not.toContain(bad);
    }
  });
});

describe("a file uploaded to the new folder is recognised everywhere a video URL is used", () => {
  const fresh = (ext = "mp4") => url(`v1760000000/reelcast/videos/${ME}/${ID}.${ext}`);

  test("videos.create's rawFileKey rule, the SSRF rule used by publish / storage checks / deletion, and the AI rule", () => {
    for (const ext of ["mp4", "mov", "webm", "mkv", "m4v"]) {
      expect(isContentCloudinaryUrl(fresh(ext))).toBe(true);
      expect(isAllowedMediaUrl(fresh(ext))).toBe(true);
      expect(isAiCloudinaryUrl(fresh(ext))).toBe(true);
    }
  });

  test("the public id that deletion and publishing use keeps the folder path and loses only the extension", () => {
    // Account deletion, single-video deletion, publish cleanup and the duration backfill all start from this value.
    expect(extractCloudinaryPublicId(fresh("mp4"))).toBe(`reelcast/videos/${ME}/${ID}`);
    expect(extractCloudinaryPublicId(fresh("mov"))).toBe(`reelcast/videos/${ME}/${ID}`);
    expect(extractCloudinaryPublicId(url(`reelcast/videos/${ME}/${ID}.mp4`))).toBe(`reelcast/videos/${ME}/${ID}`); // no version segment
  });

  test("the public id of a new-folder file sits inside that user's video prefix and nobody else's", () => {
    const id = extractCloudinaryPublicId(fresh()) as string;
    expect(id.startsWith(videoPrefix(ME))).toBe(true);
    expect(id.startsWith(videoPrefix(OTHER))).toBe(false);
  });

  test("the AI frame URL is built from it as before (folder path kept, extension swapped for .jpg)", () => {
    expect(frameUrl(fresh(), "so_2")).toBe(url(`v1760000000/reelcast/videos/${ME}/${ID}.jpg`).replace("/upload/", "/upload/so_2,w_640,h_360,c_fill/"));
  });

  test("a file in someone else's cloud is still refused", () => {
    expect(isAllowedMediaUrl(url(`v1/reelcast/videos/${ME}/${ID}.mp4`, "someone-elses-cloud"))).toBe(false);
    expect(isContentCloudinaryUrl(url(`v1/reelcast/videos/${ME}/${ID}.mp4`, "someone-elses-cloud"))).toBe(false);
  });
});

describe("videos uploaded before the folder existed keep working", () => {
  const old = [
    url("v1700000000/abcdefghij0123456789.mp4"), //            signed upload with no folder: random id at the root
    url("v1700000000/GroupedClip_x7k2.mov"),
    url("abcdefghij0123456789.mp4"), //                         no version segment
    url("v1699999999/generated/video-uuid_gen-uuid.mp4"), //    Veo output, already in a folder
  ];

  test("they pass the same three URL rules", () => {
    for (const u of old) {
      expect(isContentCloudinaryUrl(u)).toBe(true);
      expect(isAllowedMediaUrl(u)).toBe(true);
      expect(isAiCloudinaryUrl(u)).toBe(true);
    }
  });

  test("their public ids are unchanged", () => {
    expect(extractCloudinaryPublicId(old[0])).toBe("abcdefghij0123456789");
    expect(extractCloudinaryPublicId(old[1])).toBe("GroupedClip_x7k2");
    expect(extractCloudinaryPublicId(old[2])).toBe("abcdefghij0123456789");
    expect(extractCloudinaryPublicId(old[3])).toBe("generated/video-uuid_gen-uuid");
  });
});
