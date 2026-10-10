/**
 * Crash safety of the billing expiry sweep (Q-1).
 *
 * Every test runs inside a rolled-back transaction on its own synthetic users, and EVERY sweep call is
 * restricted to those users (`userId` / `userIds`): this suite never selects or changes a row it did not
 * create. Faults are injected by wrapping the handle (see src/server/testing-faults.ts), so the production
 * code under test carries no test seam.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { notifications, users } from "@/db/schema";
import { inRolledBackTx } from "@/server/testing";
import { InjectedFault, failOn } from "@/server/testing-faults";
import { runExpirySweep } from "./core";
import { DAY, HOUR, getSub, getUser, mkSub, resetUser } from "./testkit";

setDefaultTimeout(120_000);

const countNotifications = async (d: DbLike, userId: string, title: string) =>
  (await d.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.title, title)))).length;

/** The users row last changed `agoMs` ago (the sweep leaves a row alone while it is this fresh). */
const idleSince = (d: DbLike, userId: string, agoMs: number) =>
  d.update(users).set({ updatedAt: new Date(Date.now() - agoMs) }).where(eq(users.id, userId));

describe("expiry sweep: status change and downgrade are one unit", () => {
  test("cancel at period end: a failed downgrade rolls the status change back, the next sweep completes it exactly once", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await resetUser(tx, user.id, "pro", "subscription");
      const sub = await mkSub(tx, user.id, { periodEnd: new Date(Date.now() - HOUR), cancelAtPeriodEnd: true });
      const now = new Date();

      // The process "dies" at the downgrade: the sweep rejects ...
      await expect(runExpirySweep(failOn(tx, "update", users), { now, userId: user.id })).rejects.toBeInstanceOf(InjectedFault);
      // ... and NOTHING moved: the subscription is still live and the plan still paid, so the next sweep selects it again.
      expect(await getSub(tx, sub.id)).toMatchObject({ status: "active", cancelAtPeriodEnd: true });
      expect(await getUser(tx, user.id)).toMatchObject({ plan: "pro", planSource: "subscription" });
      expect(await countNotifications(tx, user.id, "Subscription ended")).toBe(0);

      expect(await runExpirySweep(tx, { now, userId: user.id })).toMatchObject({ cancelled: 1, healed: 0 });
      expect(await getSub(tx, sub.id)).toMatchObject({ status: "cancelled" });
      expect(await getUser(tx, user.id)).toMatchObject({ plan: "free", planSource: "default" });
      expect(await countNotifications(tx, user.id, "Subscription ended")).toBe(1);

      // a third run finds nothing to do and does not notify again
      expect(await runExpirySweep(tx, { now, userId: user.id })).toMatchObject({ cancelled: 0, expired: 0, healed: 0 });
      expect(await countNotifications(tx, user.id, "Subscription ended")).toBe(1);
    });
  });

  test("grace over: a failed downgrade rolls the expiry back, the next sweep completes it exactly once", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await resetUser(tx, user.id, "pro", "subscription");
      const end = new Date(Date.now() - 5 * DAY);
      const sub = await mkSub(tx, user.id, { status: "past_due", periodEnd: end, graceUntil: new Date(end.getTime() + 3 * DAY) });
      const now = new Date();

      await expect(runExpirySweep(failOn(tx, "update", users), { now, userId: user.id })).rejects.toBeInstanceOf(InjectedFault);
      expect(await getSub(tx, sub.id)).toMatchObject({ status: "past_due" });
      expect(await getUser(tx, user.id)).toMatchObject({ plan: "pro", planSource: "subscription" });
      expect(await countNotifications(tx, user.id, "Subscription expired")).toBe(0);

      expect(await runExpirySweep(tx, { now, userId: user.id })).toMatchObject({ expired: 1, healed: 0 });
      expect(await getSub(tx, sub.id)).toMatchObject({ status: "expired" });
      expect(await getUser(tx, user.id)).toMatchObject({ plan: "free", planSource: "default" });
      expect(await countNotifications(tx, user.id, "Subscription expired")).toBe(1);

      expect(await runExpirySweep(tx, { now, userId: user.id })).toMatchObject({ expired: 0, healed: 0 });
      expect(await countNotifications(tx, user.id, "Subscription expired")).toBe(1);
    });
  });

  test("a whole batch is one unit: one failed downgrade leaves every subscription of the batch untouched", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const people = [user, await makeUser(), await makeUser()];
      const subs: Awaited<ReturnType<typeof mkSub>>[] = [];
      for (const [i, p] of people.entries()) {
        await resetUser(tx, p.id, "pro", "subscription");
        subs.push(await mkSub(tx, p.id, { periodEnd: new Date(Date.now() - (i + 1) * HOUR), cancelAtPeriodEnd: true }));
      }
      const ids = people.map((p) => p.id);

      await expect(runExpirySweep(failOn(tx, "update", users), { userIds: ids })).rejects.toBeInstanceOf(InjectedFault);
      for (const [i, p] of people.entries()) {
        expect((await getSub(tx, subs[i].id)).status).toBe("active");
        expect(await getUser(tx, p.id)).toMatchObject({ plan: "pro", planSource: "subscription" });
      }

      expect(await runExpirySweep(tx, { userIds: ids })).toMatchObject({ cancelled: 3 });
      for (const [i, p] of people.entries()) {
        expect((await getSub(tx, subs[i].id)).status).toBe("cancelled");
        expect(await getUser(tx, p.id)).toMatchObject({ plan: "free", planSource: "default" });
        expect(await countNotifications(tx, p.id, "Subscription ended")).toBe(1);
      }
    });
  });

  test("an admin-granted plan survives the same failed-and-retried sweep", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await resetUser(tx, user.id, "elite", "admin");
      await mkSub(tx, user.id, { plan: "elite", periodEnd: new Date(Date.now() - HOUR), cancelAtPeriodEnd: true });
      await expect(runExpirySweep(failOn(tx, "update", users), { userId: user.id })).rejects.toBeInstanceOf(InjectedFault);
      expect(await runExpirySweep(tx, { userId: user.id })).toMatchObject({ cancelled: 1, healed: 0 });
      expect(await getUser(tx, user.id)).toMatchObject({ plan: "elite", planSource: "admin" });
    });
  });
});

describe("expiry sweep: heals subscriptions an earlier non-atomic sweep left half-done", () => {
  test("a paid plan with no live subscription behind it is downgraded by ONE sweep, and only once", async () => {
    await inRolledBackTx(async ({ tx, makeUser }) => {
      for (const status of ["expired", "cancelled", null] as const) {
        const u = await makeUser();
        await resetUser(tx, u.id, "pro", "subscription");
        // The old sweep committed the status change and died before the downgrade; or the row is simply gone.
        if (status) await mkSub(tx, u.id, { status, periodEnd: new Date(Date.now() - 10 * DAY) });
        await idleSince(tx, u.id, HOUR);

        expect(await runExpirySweep(tx, { userId: u.id })).toMatchObject({ healed: 1, cancelled: 0, expired: 0 });
        expect(await getUser(tx, u.id)).toMatchObject({ plan: "free", planSource: "default" });
        expect(await runExpirySweep(tx, { userId: u.id })).toMatchObject({ healed: 0 });
      }
    });
  });

  test("never touches a plan the subscription does not own, or one that a live subscription still backs", async () => {
    await inRolledBackTx(async ({ tx, makeUser }) => {
      const future = new Date(Date.now() + 10 * DAY);
      const past = new Date(Date.now() - HOUR);
      const cases: { name: string; plan: "free" | "pro" | "elite"; source: "default" | "subscription" | "admin"; sub?: Parameters<typeof mkSub>[2] }[] = [
        { name: "admin plan, no subscription", plan: "elite", source: "admin" },
        { name: "admin plan, expired subscription", plan: "pro", source: "admin", sub: { status: "expired", periodEnd: past } },
        { name: "default plan", plan: "free", source: "default" },
        { name: "paid plan whose source is default", plan: "pro", source: "default" },
        { name: "active subscription", plan: "pro", source: "subscription", sub: { status: "active", periodEnd: future } },
        { name: "past_due subscription inside grace", plan: "pro", source: "subscription", sub: { status: "past_due", periodEnd: past, graceUntil: future } },
        { name: "open checkout (approval_pending)", plan: "pro", source: "subscription", sub: { status: "approval_pending", periodEnd: future } },
      ];
      for (const c of cases) {
        const u = await makeUser();
        await resetUser(tx, u.id, c.plan, c.source);
        if (c.sub) await mkSub(tx, u.id, c.sub);
        await idleSince(tx, u.id, HOUR);
        const r = await runExpirySweep(tx, { userId: u.id });
        expect({ case: c.name, healed: r.healed }).toEqual({ case: c.name, healed: 0 });
        expect({ case: c.name, ...(await getUser(tx, u.id)) }).toMatchObject({ case: c.name, plan: c.plan, planSource: c.source });
      }
    });
  });

  test("a users row changed moments ago is left alone (a payment may be applying), and healed once it has been idle", async () => {
    await inRolledBackTx(async ({ tx, user }) => {
      await resetUser(tx, user.id, "pro", "subscription"); // updated_at = now
      expect(await runExpirySweep(tx, { userId: user.id })).toMatchObject({ healed: 0 });
      expect(await getUser(tx, user.id)).toMatchObject({ plan: "pro", planSource: "subscription" });

      expect(await runExpirySweep(tx, { userId: user.id, now: new Date(Date.now() + 10 * 60_000) })).toMatchObject({ healed: 1 });
      expect(await getUser(tx, user.id)).toMatchObject({ plan: "free", planSource: "default" });
    });
  });

  test("is restricted by userId like every other phase: another half-done user is not touched", async () => {
    await inRolledBackTx(async ({ tx, user, makeUser }) => {
      const other = await makeUser();
      for (const u of [user, other]) {
        await resetUser(tx, u.id, "pro", "subscription");
        await idleSince(tx, u.id, HOUR);
      }
      expect(await runExpirySweep(tx, { userId: user.id })).toMatchObject({ healed: 1 });
      expect(await getUser(tx, user.id)).toMatchObject({ plan: "free" });
      expect(await getUser(tx, other.id)).toMatchObject({ plan: "pro", planSource: "subscription" });
    });
  });
});
