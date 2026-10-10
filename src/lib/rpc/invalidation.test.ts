import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { invalidateForWrite, invalidationFor, narrowedWritePaths } from "./invalidation";

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
