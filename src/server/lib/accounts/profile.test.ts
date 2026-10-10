import { describe, expect, test } from "bun:test";
import { NAME_MAX_LENGTH, normalizeName, profileInput } from "./profile";

const parse = (v: unknown) => profileInput.safeParse(v);

describe("profile name", () => {
  test("is trimmed and has inner whitespace collapsed", () => {
    expect(parse({ name: "  Ada   Lovelace \n" })).toMatchObject({ success: true, data: { name: "Ada Lovelace" } });
    expect(normalizeName("a\t\tb")).toBe("a b");
  });

  test("keeps real-world names: accents, non-Latin scripts, punctuation, emoji", () => {
    for (const name of ["José Ñandú", "Zoë O'Brien-Smith", "山田 太郎", "Мария", "A. B. Cooper Jr.", "Blair 🎬"]) {
      expect(parse({ name })).toMatchObject({ success: true, data: { name } });
    }
  });

  test("must not be empty or blank", () => {
    expect(parse({ name: "" }).success).toBe(false);
    expect(parse({ name: "   \n\t " }).success).toBe(false);
  });

  test(`is limited to ${NAME_MAX_LENGTH} characters, counting an emoji as one`, () => {
    expect(parse({ name: "a".repeat(NAME_MAX_LENGTH) }).success).toBe(true);
    expect(parse({ name: "a".repeat(NAME_MAX_LENGTH + 1) }).success).toBe(false);
    expect(parse({ name: "🎬".repeat(NAME_MAX_LENGTH) }).success).toBe(true);
  });

  test("rejects control characters and angle brackets", () => {
    for (const name of ["bad\u0000name", "bad‮name", "bad​name", "<script>", "a>b", "a<b"]) {
      expect(parse({ name }).success).toBe(false);
    }
  });
});

describe("profile input", () => {
  test("needs at least one field", () => {
    expect(parse({}).success).toBe(false);
  });

  test("accepts a picture URL string or null (remove) on its own", () => {
    expect(parse({ imageUrl: null }).success).toBe(true);
    expect(parse({ imageUrl: "https://res.cloudinary.com/x/image/upload/a.jpg" }).success).toBe(true);
    expect(parse({ imageUrl: "x".repeat(501) }).success).toBe(false);
  });

  test("never accepts an email (or any unknown field): the email is not editable", () => {
    expect(parse({ name: "Ada", email: "new@example.com" }).success).toBe(false);
    expect(parse({ email: "new@example.com" }).success).toBe(false);
    expect(parse({ name: "Ada", isAdmin: true }).success).toBe(false);
    expect(parse({ name: "Ada", plan: "elite" }).success).toBe(false);
  });
});
