import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { platformSettings } from "@/db/schema";
import { inRolledBackTx } from "@/server/testing";
import { setEnv, setPlatformKeys } from "./generation/testkit";
import { getPlatformKey } from "./platformKeys";

setDefaultTimeout(60_000);

let restore: () => void;
beforeEach(() => {
  restore = setEnv({ GEMINI_API_KEY: undefined });
});
afterEach(() => restore());

describe("getPlatformKey", () => {
  test("decrypts the stored key; gemini falls back to the env var, deepseek does not", async () => {
    await inRolledBackTx(async ({ tx }) => {
      await setPlatformKeys(tx, { gemini: "gem-123", deepseek: "ds-456" });
      expect(await getPlatformKey(tx, "gemini")).toBe("gem-123");
      expect(await getPlatformKey(tx, "deepseek")).toBe("ds-456");

      await setPlatformKeys(tx, { gemini: null, deepseek: null });
      expect(await getPlatformKey(tx, "gemini")).toBeNull();
      expect(await getPlatformKey(tx, "deepseek")).toBeNull();

      process.env.GEMINI_API_KEY = "env-gem";
      expect(await getPlatformKey(tx, "gemini")).toBe("env-gem");
      expect(await getPlatformKey(tx, "deepseek")).toBeNull();
      await setPlatformKeys(tx, { gemini: "gem-123" });
      expect(await getPlatformKey(tx, "gemini")).toBe("gem-123"); // stored key wins over env
    });
  });

  test("an undecryptable value behaves as 'not configured' and never throws", async () => {
    await inRolledBackTx(async ({ tx }) => {
      await setPlatformKeys(tx, {});
      await tx.update(platformSettings).set({ geminiApiKey: "v1:garbage:garbage:garbage" });
      expect(await getPlatformKey(tx, "gemini")).toBeNull();
      process.env.GEMINI_API_KEY = "env-gem";
      expect(await getPlatformKey(tx, "gemini")).toBe("env-gem");
    });
  });
});
