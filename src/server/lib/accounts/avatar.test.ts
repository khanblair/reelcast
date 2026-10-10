import { describe, expect, test } from "bun:test";
import { RpcError } from "@/server/rpc/errors";
import { avatarFolder, avatarPrefix, checkAvatarFile, newAvatarId, parseAvatarUrl, AVATAR_MAX_BYTES } from "./avatar";

const CLOUD = "demo-cloud";
const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ID = "0123456789abcdef01234567";
const url = (path: string) => `https://res.cloudinary.com/${CLOUD}/image/upload/${path}`;
const mine = url(`v1700000000/reelcast/avatars/${ME}/${ID}.jpg`);

describe("parseAvatarUrl", () => {
  test("accepts a user's own avatar URL, with or without a version segment", () => {
    expect(parseAvatarUrl(mine, ME, CLOUD)).toEqual({ publicId: `reelcast/avatars/${ME}/${ID}`, format: "jpg" });
    expect(parseAvatarUrl(url(`reelcast/avatars/${ME}/${ID}.webp`), ME, CLOUD)?.format).toBe("webp");
    expect(parseAvatarUrl(url(`v1/reelcast/avatars/${ME}/${ID}.png`), ME, CLOUD)?.format).toBe("png");
  });

  test("rejects another user's folder, another cloud, and a missing cloud name", () => {
    expect(parseAvatarUrl(mine, OTHER, CLOUD)).toBeNull();
    expect(parseAvatarUrl(mine, ME, "someone-elses-cloud")).toBeNull();
    expect(parseAvatarUrl(mine, ME, undefined)).toBeNull();
  });

  test("rejects anything that is not a plain https res.cloudinary.com delivery URL", () => {
    const base = `v1/reelcast/avatars/${ME}/${ID}.jpg`;
    for (const bad of [
      `http://res.cloudinary.com/${CLOUD}/image/upload/${base}`,
      `https://evil.example/${CLOUD}/image/upload/${base}`,
      `https://res.cloudinary.com.evil.example/${CLOUD}/image/upload/${base}`,
      `https://user:pw@res.cloudinary.com/${CLOUD}/image/upload/${base}`,
      `https://res.cloudinary.com:8443/${CLOUD}/image/upload/${base}`,
      `${url(base)}?x=1`,
      `${url(base)}#frag`,
      url(`c_fill,w_100/${base}`), // a transformation URL is not a stored file
      url(`reelcast/avatars/${ME}/../${OTHER}/${ID}.jpg`),
      url(`reelcast/avatars/${ME}/${ID}.gif`),
      url(`reelcast/avatars/${ME}/${ID}`),
      url(`reelcast/avatars/${ME}/ABCDEF0123456789ABCDEF01.jpg`), // ids are lower-case hex
      url(`reelcast/avatars/${ME}/short.jpg`),
      url(`reelcast/avatars/${ME}/${ID}/nested.jpg`),
      `https://res.cloudinary.com/${CLOUD}/video/upload/${base}`,
      "not a url",
      "",
    ]) {
      expect(parseAvatarUrl(bad, ME, CLOUD)).toBeNull();
    }
  });
});

describe("avatar folders and ids", () => {
  test("the prefix ends with a slash so a prefix delete cannot reach another user's folder", () => {
    expect(avatarPrefix(ME)).toBe(`${avatarFolder(ME)}/`);
    expect(avatarPrefix(ME).endsWith("/")).toBe(true);
    expect(`${avatarFolder(OTHER)}/x`.startsWith(avatarPrefix(ME))).toBe(false);
  });

  test("new ids are 24 lower-case hex characters and differ each time", () => {
    const a = newAvatarId();
    expect(a).toMatch(/^[a-f0-9]{24}$/);
    expect(newAvatarId()).not.toBe(a);
  });
});

describe("checkAvatarFile", () => {
  const ok = { resourceType: "image", type: "upload", format: "png", bytes: 1000, width: 512, height: 512 };
  const rejects = (info: Parameters<typeof checkAvatarFile>[0]) => {
    try {
      checkAvatarFile(info);
    } catch (e) {
      expect(e).toBeInstanceOf(RpcError);
      expect((e as RpcError).code).toBe("BAD_REQUEST");
      return;
    }
    throw new Error("expected checkAvatarFile to reject");
  };

  test("accepts a normal square picture", () => {
    expect(() => checkAvatarFile(ok)).not.toThrow();
    expect(() => checkAvatarFile({ ...ok, format: "jpg", bytes: AVATAR_MAX_BYTES })).not.toThrow();
  });

  test("rejects a missing, non-image, non-uploaded, wrong-format, huge, tiny or oversized file", () => {
    rejects(null);
    rejects({ ...ok, resourceType: "video" });
    rejects({ ...ok, type: "private" });
    rejects({ ...ok, format: "gif" });
    rejects({ ...ok, format: "svg" });
    rejects({ ...ok, bytes: AVATAR_MAX_BYTES + 1 });
    rejects({ ...ok, width: 32 });
    rejects({ ...ok, height: 63 });
    rejects({ ...ok, width: 5000 });
  });
});
