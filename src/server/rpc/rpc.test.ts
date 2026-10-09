import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { decryptSecret, encryptSecret, isEncrypted, maskSecret } from "../crypto";
import { inRolledBackTx, callRpc } from "../testing";
import { mutation, query } from "./define";
import { RpcError } from "./errors";
import { toWire } from "./wire";

describe("crypto", () => {
  test("round-trips and never stores plaintext", () => {
    const enc = encryptSecret("sk-live-abc123");
    expect(isEncrypted(enc)).toBe(true);
    expect(enc).not.toContain("abc123");
    expect(decryptSecret(enc)).toBe("sk-live-abc123");
  });
  test("random IV: same plaintext encrypts differently", () => {
    expect(encryptSecret("x")).not.toBe(encryptSecret("x"));
  });
  test("tampering is detected", () => {
    const parts = encryptSecret("secret").split(":");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });
  test("mask never reveals the middle", () => {
    expect(maskSecret("sk-abcdefghijkl")).toBe("sk-…ijkl");
    expect(maskSecret(null)).toBeNull();
  });
});

describe("wire format", () => {
  test("renames id, adds _creationTime, converts dates, drops nulls", () => {
    const d = new Date("2026-01-02T03:04:05Z");
    const out = toWire({ id: "a", createdAt: d, title: "t", description: null, nested: [{ id: "b", at: d }] }) as Record<string, unknown>;
    expect(out._id).toBe("a");
    expect(out._creationTime).toBe(d.getTime());
    expect(out.createdAt).toBe(d.getTime());
    expect("description" in out).toBe(false);
    expect((out.nested as Record<string, unknown>[])[0]).toEqual({ _id: "b", at: d.getTime() });
  });
});

const testApi = {
  open: query({ auth: "public", handler: async (ctx) => ({ who: ctx.userId }) }),
  mine: query({ handler: async (ctx) => ({ id: ctx.userId }) }),
  adminOnly: mutation({ auth: "admin", handler: async () => "ok" }),
  withInput: mutation({ input: z.object({ n: z.number().int().min(1) }), handler: async (_c, a) => a.n * 2 }),
  boom: query({ handler: async () => { throw new Error("secret internal detail"); } }),
  nested: { deep: { fn: query({ handler: async () => "deep" }) } },
};

describe("dispatch", () => {
  test("rejects unknown paths and non-function nodes", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await expect(callRpc("nope.nada", {}, { user, tx }, testApi)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(callRpc("nested.deep", {}, { user, tx }, testApi)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(callRpc("__proto__.constructor", {}, { user, tx }, testApi)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });
  test("walks nested registries", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      expect(await callRpc("nested.deep.fn", {}, { user, tx }, testApi)).toBe("deep");
    });
  });
  test("user fns require a session; public fns do not", async () => {
    await expect(callRpc("mine", {}, { user: null }, testApi)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    // null fields are omitted on the wire (Convex "optional field" semantics)
    expect(await callRpc("open", {}, { user: null }, testApi)).toEqual({});
  });
  test("admin fns reject non-admins (checked from the DB row)", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await expect(callRpc("adminOnly", {}, { user: { ...user, isAdmin: false }, tx }, testApi)).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await callRpc("adminOnly", {}, { user: { ...user, isAdmin: true }, tx }, testApi)).toBe("ok");
    });
  });
  test("validates input with zod and strips unknown behaviour", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await expect(callRpc("withInput", { n: 0 }, { user, tx }, testApi)).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(callRpc("withInput", { n: "x" }, { user, tx }, testApi)).rejects.toBeInstanceOf(RpcError);
      expect(await callRpc("withInput", { n: 4 }, { user, tx }, testApi)).toBe(8);
    });
  });
});

describe("users.current / settings.get (real registry, real DB)", () => {
  test("signed out -> null", async () => {
    expect(await callRpc("users.current", {}, { user: null })).toBeNull();
    expect(await callRpc("settings.get", {}, { user: null })).toBeNull();
  });
  test("signed in -> DTO without any secret fields", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      const me = (await callRpc("users.current", {}, { user, tx })) as Record<string, unknown>;
      expect(me._id).toBe(user.id);
      expect(me.youtubeConnected).toBe(false);
      for (const k of ["youtubeAccessToken", "youtubeRefreshToken", "accessToken", "refreshToken"]) expect(k in me).toBe(false);

      const s = (await callRpc("settings.get", {}, { user, tx })) as Record<string, unknown>;
      expect(s.notificationsEnabled).toBe(false);
      expect(s.hasResendApiKey).toBe(false);
      expect("resendApiKey" in s).toBe(false);
      expect("deepseekApiKey" in s).toBe(false);
    });
  });
});
