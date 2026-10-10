import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { ALL_RPC_KEY } from "../billing-poll";
import { invalidateForWrite, invalidationFor, narrowedWritePaths } from "./invalidation";
import { pollingOptions, staleTimeFor } from "./polling";

// ─── What the server actually exports (the registry maps modules/<a>/<b>.ts to path "a.b.<export>") ───

const MODULES_DIR = join(import.meta.dir, "../../server/modules");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [full] : [];
  });
}

type Kind = "query" | "mutation" | "action";
const SERVER_FNS = new Map<string, Kind>();
for (const file of sourceFiles(MODULES_DIR)) {
  const prefix = relative(MODULES_DIR, file).replace(/\.ts$/, "").split("/").join(".");
  for (const m of readFileSync(file, "utf8").matchAll(/^export const (\w+) = (query|mutation|action)\(/gm)) {
    SERVER_FNS.set(`${prefix}.${m[1]}`, m[2] as Kind);
  }
}
const QUERY_PATHS = [...SERVER_FNS].filter(([, k]) => k === "query").map(([p]) => p);

const EXPECTED = {
  "notifications.markAsRead": ["notifications.get"],
  "notifications.markAllAsRead": ["notifications.get"],
  "notifications.clearAll": ["notifications.get"],
  "ideas.create": ["ideas.list"],
  "ideas.update": ["ideas.list"],
  "ideas.remove": ["ideas.list"],
  "ideas.linkVideo": ["ideas.list"],
  "aiSessions.create": ["aiSessions.list", "aiMessages.getContext"],
  "aiSessions.updateTitle": ["aiSessions.list", "aiMessages.getContext"],
  "aiSessions.remove": ["aiSessions.list", "aiMessages.getContext"],
} as const;

const CHAT_TARGETS = [
  "aiSessions.list",
  "aiMessages.getContext",
  "billing.getStatus",
  "usageLedger.getUsageSummary",
  "admin.usageLedger.getOverview",
  "admin.usageLedger.getSummary",
];

const paths = (keys: ReturnType<typeof invalidationFor>) => keys?.map((k) => k[1]);

describe("invalidationFor", () => {
  test("mapped writes return exactly the expected prefixes, each ['rpc', <full path>]", () => {
    for (const [path, expected] of Object.entries(EXPECTED)) {
      expect(paths(invalidationFor(path))).toEqual([...expected]);
      for (const k of invalidationFor(path)!) expect(k[0]).toBe("rpc");
    }
  });

  test("the assistant chat action also refreshes every reader of the usage counters", () => {
    expect(paths(invalidationFor("actions.aiAssistant.chat"))).toEqual(CHAT_TARGETS);
  });

  test("the table holds exactly these writes and nothing else", () => {
    expect(narrowedWritePaths().sort()).toEqual([...Object.keys(EXPECTED), "actions.aiAssistant.chat"].sort());
  });

  test("unknown paths fall back to invalidate-everything (undefined), including Object.prototype names", () => {
    for (const path of ["videos.list", "", "notifications", "notifications.get", "notifications.getX", "constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(invalidationFor(path)).toBeUndefined();
    }
  });

  test("writes that feed several views keep invalidating everything", () => {
    const narrowed = new Set(narrowedWritePaths());
    const writes = [...SERVER_FNS].filter(([, k]) => k !== "query").map(([p]) => p);
    expect(writes.length).toBeGreaterThan(40); // the scan really found the server surface
    for (const path of writes) {
      if (narrowed.has(path)) continue;
      expect(invalidationFor(path)).toBeUndefined();
    }
    for (const path of [
      "actions.publishNow.publishNow",
      "actions.generateThumbnail.generateThumbnail",
      "videos.update",
      "settings.update",
      "billing.cancel",
      "billing.createCheckout",
      "youtubeChannels.disconnect",
    ]) {
      if (SERVER_FNS.has(path)) expect(invalidationFor(path)).toBeUndefined();
    }
  });
});

describe("the table agrees with the server code", () => {
  test("every narrowed write is a real mutation/action and every target is a real query", () => {
    for (const path of narrowedWritePaths()) {
      const kind = SERVER_FNS.get(path);
      expect(kind === "mutation" || kind === "action").toBe(true);
      for (const target of paths(invalidationFor(path))!) expect(SERVER_FNS.get(target)).toBe("query");
    }
  });

  test("aiMessages has no writes, so there is nothing to map for it", () => {
    const aiMessageWrites = [...SERVER_FNS].filter(([p, k]) => p.startsWith("aiMessages.") && k !== "query");
    expect(aiMessageWrites).toEqual([]);
  });
});

describe("invalidateForWrite against a real QueryClient", () => {
  function seeded() {
    const qc = new QueryClient();
    const keys: Record<string, readonly unknown[][]> = {};
    for (const path of QUERY_PATHS) {
      keys[path] = [
        ["rpc", path, {}],
        ["rpc", path, { id: "x" }],
        ["rpc", path, null],
      ];
      for (const k of keys[path]) qc.setQueryData(k, { path });
    }
    // Decoys that only differ from a real target by a suffix: a prefix match on strings would catch them.
    for (const decoy of ["notifications.getX", "notifications.get2", "ideas.listAll", "billing.getStatusX"]) {
      keys[decoy] = [["rpc", decoy, {}]];
      qc.setQueryData(keys[decoy][0], 1);
    }
    const invalidated = () => Object.entries(keys).filter(([, ks]) => ks.some((k) => qc.getQueryState(k)?.isInvalidated)).map(([p]) => p);
    return { qc, keys, invalidated };
  }

  test("a mapped write invalidates only its targets (all arg variants), never a path that merely starts the same", async () => {
    for (const [path, expected] of Object.entries(EXPECTED)) {
      const { qc, keys, invalidated } = seeded();
      await invalidateForWrite(qc, path);
      expect(invalidated().sort()).toEqual([...expected].sort());
      for (const target of expected) for (const k of keys[target]) expect(qc.getQueryState(k)?.isInvalidated).toBe(true);
    }
  });

  test("chat invalidates the session list, the conversation and every usage reader", async () => {
    const { qc, invalidated } = seeded();
    await invalidateForWrite(qc, "actions.aiAssistant.chat");
    expect(invalidated().sort()).toEqual([...CHAT_TARGETS].sort());
  });

  test("an unmapped write invalidates every rpc query (the safe default)", async () => {
    const { qc, keys, invalidated } = seeded();
    qc.setQueryData(["unrelated"], 1);
    await invalidateForWrite(qc, "videos.update");
    expect(invalidated().sort()).toEqual(Object.keys(keys).sort());
    expect(qc.getQueryState(["unrelated"])?.isInvalidated).toBe(false);
  });

  test("only active mapped queries are refetched, and the write waits for them", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const calls: Record<string, number> = {};
    const observe = (path: string, delayMs: number) => {
      const observer = new QueryObserver(qc, {
        queryKey: ["rpc", path, {}],
        queryFn: async () => {
          calls[path] = (calls[path] ?? 0) + 1;
          await new Promise((r) => setTimeout(r, delayMs));
          return calls[path];
        },
      });
      return observer.subscribe(() => {});
    };
    const unsubscribers = [observe("notifications.get", 20), observe("videos.list", 20), observe("jobs.list", 20)];
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toEqual({ "notifications.get": 1, "videos.list": 1, "jobs.list": 1 });

    await invalidateForWrite(qc, "notifications.markAsRead");
    // The refetch had finished by the time the write resolved, and nothing else was touched.
    expect(qc.getQueryData<number>(["rpc", "notifications.get", {}])).toBe(2);
    expect(calls).toEqual({ "notifications.get": 2, "videos.list": 1, "jobs.list": 1 });

    await invalidateForWrite(qc, "videos.update");
    expect(calls).toEqual({ "notifications.get": 3, "videos.list": 2, "jobs.list": 2 });
    for (const off of unsubscribers) off();
  });
});

describe("a write still refreshes data that stays fresh for a long time", () => {
  // The observers use exactly the timing options useQuery passes (polling.ts), staleTime included.
  function harness() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const calls: Record<string, number> = {};
    const observer = (path: string) =>
      new QueryObserver(qc, {
        queryKey: ["rpc", path, {}],
        queryFn: async () => {
          calls[path] = (calls[path] ?? 0) + 1;
          return calls[path];
        },
        ...pollingOptions(path),
      });
    const watch = (path: string) => observer(path).subscribe(() => {});
    const settle = () => new Promise((r) => setTimeout(r, 5));
    return { qc, calls, observer, watch, settle };
  }

  test("the paths under test really do stay fresh for at least a minute", () => {
    for (const path of ["ideas.list", "users.current", "settings.get", "aiSessions.list", "youtubeChannels.list"]) {
      expect(staleTimeFor(path)).toBeGreaterThanOrEqual(60_000);
    }
  });

  test("without a write the data is reused for its whole staleTime, then refetched", async () => {
    const { calls, watch, settle } = harness();
    const realNow = Date.now;
    const t0 = realNow();
    let elapsed = 0;
    Date.now = () => t0 + elapsed;
    const off: (() => void)[] = [];
    try {
      off.push(watch("ideas.list"), watch("users.current"), watch("videos.list"));
      await settle();

      elapsed = 30_000;
      off.push(watch("ideas.list"), watch("users.current"), watch("videos.list")); // another component mounts the same queries
      await settle();
      // 30 s on: the 60 s ones are reused, videos.list (10 s) was refetched.
      expect(calls).toEqual({ "ideas.list": 1, "users.current": 1, "videos.list": 2 });

      elapsed = 61_000;
      off.push(watch("ideas.list"), watch("users.current"));
      await settle();
      expect(calls).toEqual({ "ideas.list": 2, "users.current": 2, "videos.list": 2 });
    } finally {
      Date.now = realNow;
      for (const o of off) o();
    }
  });

  test("an unmapped write refreshes every long-lived query that is on screen, and the write waits for them", async () => {
    const { qc, calls, watch, settle } = harness();
    const off = [watch("ideas.list"), watch("users.current"), watch("settings.get"), watch("analytics.getDashboardStats")];
    await settle();
    await invalidateForWrite(qc, "videos.update");
    expect(calls).toEqual({ "ideas.list": 2, "users.current": 2, "settings.get": 2, "analytics.getDashboardStats": 2 });
    for (const o of off) o();
  });

  test("a mapped write refreshes only its targets (ideas.create -> ideas.list)", async () => {
    const { qc, calls, watch, settle } = harness();
    const off = [watch("ideas.list"), watch("users.current"), watch("aiSessions.list")];
    await settle();
    await invalidateForWrite(qc, "ideas.create");
    expect(calls).toEqual({ "ideas.list": 2, "users.current": 1, "aiSessions.list": 1 });
    await invalidateForWrite(qc, "aiSessions.create");
    expect(calls).toEqual({ "ideas.list": 2, "users.current": 1, "aiSessions.list": 2 });
    for (const o of off) o();
  });

  test("a query nobody is looking at is marked stale, so the next screen to need it refetches instead of using the cache", async () => {
    const { qc, calls, watch, settle } = harness();
    const off = watch("ideas.list");
    await settle();
    off(); // the ideas page is closed; the data is still cached and still within its staleTime
    expect(calls["ideas.list"]).toBe(1);

    await invalidateForWrite(qc, "ideas.create"); // e.g. made from the assistant panel
    expect(qc.getQueryState(["rpc", "ideas.list", {}])?.isInvalidated).toBe(true);
    expect(calls["ideas.list"]).toBe(1); // nobody watching: no request yet

    const back = watch("ideas.list"); // the ideas page opens again
    await settle();
    expect(calls["ideas.list"]).toBe(2);
    back();
  });

  test("the billing page's refresh-everything step reaches users.current and settings.get too", async () => {
    const { qc, calls, watch, settle } = harness();
    const off = [watch("users.current"), watch("settings.get"), watch("billing.getStatus")];
    await settle();
    await qc.invalidateQueries({ queryKey: ALL_RPC_KEY });
    expect(calls).toEqual({ "users.current": 2, "settings.get": 2, "billing.getStatus": 2 });
    for (const o of off) o();
  });
});
