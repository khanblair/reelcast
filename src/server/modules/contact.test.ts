import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { contactSubmissions } from "@/db/schema";
import { callRpc, inRolledBackTx } from "../testing";

setDefaultTimeout(60_000);

const form = (email: string, over: Record<string, string> = {}) => ({ name: "Ada", email, subject: "Hello", message: "I have a question.", ...over });
const submit = (tx: Parameters<typeof callRpc>[2]["tx"], args: unknown) => callRpc("contact.submit", args, { user: null, tx });

describe("contact.submit", () => {
  test("public: stores a trimmed submission as status new", async () => {
    await inRolledBackTx(async ({ tx }) => {
      const email = `ada-${randomUUID()}@example.com`;
      await submit(tx, form(`  ${email} `, { name: "  Ada  " }));
      const rows = await tx.select().from(contactSubmissions).where(sql`email = ${email}`);
      expect(rows.length).toBe(1);
      expect(rows[0]).toMatchObject({ name: "Ada", subject: "Hello", status: "new" });
    });
  });

  test("validation messages are friendly", async () => {
    await inRolledBackTx(async ({ tx }) => {
      await expect(submit(tx, form("a@b.co", { name: "   " }))).rejects.toMatchObject({ code: "BAD_REQUEST", message: "All fields are required." });
      await expect(submit(tx, form("not-an-email"))).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Please enter a valid email address." });
      await expect(submit(tx, form("a@b.co", { message: "x".repeat(5001) }))).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(submit(tx, { name: "a" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });
  });

  test("rate limit: 3 per email per hour (case-insensitive), other emails unaffected", async () => {
    await inRolledBackTx(async ({ tx }) => {
      const email = `spam-${randomUUID()}@example.com`;
      await submit(tx, form(email));
      await submit(tx, form(email.toUpperCase()));
      await submit(tx, form(email));
      await expect(submit(tx, form(email))).rejects.toMatchObject({ code: "RATE_LIMITED" });
      const rows = await tx.select().from(contactSubmissions).where(sql`lower(email) = ${email}`);
      expect(rows.length).toBe(3);

      await submit(tx, form(`other-${randomUUID()}@example.com`)); // different sender still fine
    });
  });

  test("old submissions do not count against the hourly limit", async () => {
    await inRolledBackTx(async ({ tx }) => {
      const email = `old-${randomUUID()}@example.com`;
      const old = new Date(Date.now() - 2 * 3_600_000);
      await tx.insert(contactSubmissions).values([1, 2, 3].map(() => ({ name: "n", email, subject: "s", message: "m", createdAt: old })));
      await submit(tx, form(email));
    });
  });

  test("global hourly cap", async () => {
    await inRolledBackTx(async ({ tx }) => {
      await tx.insert(contactSubmissions).values(Array.from({ length: 60 }, (_, i) => ({ name: "n", email: `bulk${i}-${randomUUID()}@example.com`, subject: "s", message: "m" })));
      await expect(submit(tx, form(`fresh-${randomUUID()}@example.com`))).rejects.toMatchObject({ code: "RATE_LIMITED" });
    });
  });
});
