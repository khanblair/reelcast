import { describe, expect, test } from "bun:test";
import { formatBytes } from "./format-bytes";
import { displayName, initialsFor } from "./user-display";

describe("user display", () => {
  test("initials come from the name, then the email, then a placeholder", () => {
    expect(initialsFor("Ada Lovelace", "x@y.z")).toBe("AL");
    expect(initialsFor("  ada   king   lovelace ", null)).toBe("AK");
    expect(initialsFor("blair", null)).toBe("B");
    expect(initialsFor(null, "blairryhs@gmail.com")).toBe("B");
    expect(initialsFor(null, "jane.doe@example.com")).toBe("JD");
    expect(initialsFor("", "")).toBe("?");
    expect(initialsFor(null, null)).toBe("?");
    expect(initialsFor("山田 太郎", null)).toBe("山太");
    expect(initialsFor("😀 Smile", null)).toBe("😀S");
  });

  test("the shown name falls back to the email's local part", () => {
    expect(displayName({ name: " Ada ", email: "a@b.c" })).toBe("Ada");
    expect(displayName({ name: null, email: "blairryhs@gmail.com" })).toBe("blairryhs");
    expect(displayName({})).toBe("Account");
  });

  test("byte sizes are readable", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(12 * 1024 ** 3)).toBe("12 GB");
  });
});
