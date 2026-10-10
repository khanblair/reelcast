import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * public/sw.js must only ever serve the static install assets. Pages, RSC payloads, build chunks and the API must
 * fall through to the network: caching them served stale HTML that never hydrated.
 */
const SW_SOURCE = readFileSync(join(import.meta.dir, "../../public/sw.js"), "utf8");
const ORIGIN = "https://reelcast.example";

type Listener = (event: Record<string, unknown>) => void;

function loadServiceWorker(initialCaches: Record<string, string[]> = {}) {
  const listeners = new Map<string, Listener>();
  const store = new Map<string, Set<string>>(Object.entries(initialCaches).map(([name, urls]) => [name, new Set(urls)]));
  const networkCalls: string[] = [];
  const state = { skippedWaiting: false, claimed: false };

  const caches = {
    open: async (name: string) => {
      if (!store.has(name)) store.set(name, new Set());
      const cache = store.get(name)!;
      return { add: async (path: string) => void cache.add(new URL(path, ORIGIN).href) };
    },
    keys: async () => [...store.keys()],
    delete: async (name: string) => store.delete(name),
    match: async (request: { url: string }) => {
      for (const urls of store.values()) if (urls.has(request.url)) return `cached:${request.url}`;
      return undefined;
    },
  };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    skipWaiting: () => void (state.skippedWaiting = true),
    clients: { claim: async () => void (state.claimed = true) },
  };
  const fetchStub = async (request: { url: string }) => {
    networkCalls.push(request.url);
    return `network:${request.url}`;
  };

  new Function("self", "caches", "fetch", SW_SOURCE)(self, caches, fetchStub);

  async function lifecycle(type: "install" | "activate") {
    const waits: Promise<unknown>[] = [];
    listeners.get(type)!({ waitUntil: (promise: Promise<unknown>) => waits.push(promise) });
    await Promise.all(waits);
  }

  /** Fire a fetch event; resolves to what the worker answered, or "passthrough" if it left the request alone. */
  async function request(path: string, init: { method?: string; headers?: Record<string, string>; mode?: string } = {}) {
    const url = path.startsWith("http") ? path : new URL(path, ORIGIN).href;
    let answered: Promise<unknown> | undefined;
    listeners.get("fetch")!({
      request: { url, method: init.method ?? "GET", mode: init.mode ?? "cors", headers: new Headers(init.headers) },
      respondWith: (promise: Promise<unknown>) => void (answered = promise),
    });
    return answered ? await answered : "passthrough";
  }

  return { store, networkCalls, state, lifecycle, request };
}

describe("service worker", () => {
  test("precaches only static install assets, never a page", async () => {
    const sw = loadServiceWorker();
    await sw.lifecycle("install");
    const cached = [...sw.store.get("reelcast-v3")!].map((href) => new URL(href).pathname);
    expect(cached).toContain("/manifest.json");
    expect(cached).toContain("/icons/icon-192x192.png");
    expect(cached).not.toContain("/");
    expect(cached).not.toContain("/dashboard");
    expect(cached.every((path) => path === "/manifest.json" || path.startsWith("/icons/"))).toBe(true);
    expect(sw.state.skippedWaiting).toBe(true);
  });

  test("activation purges the old page-HTML caches and keeps the current one", async () => {
    const sw = loadServiceWorker({ "reelcast-v2": [`${ORIGIN}/dashboard`], "reelcast-v3": [`${ORIGIN}/manifest.json`] });
    await sw.lifecycle("activate");
    expect([...sw.store.keys()]).toEqual(["reelcast-v3"]);
    expect(sw.state.claimed).toBe(true);
  });

  test("serves static assets cache-first, and fetches them if they are not cached yet", async () => {
    const sw = loadServiceWorker({ "reelcast-v3": [`${ORIGIN}/manifest.json`] });
    expect(await sw.request("/manifest.json")).toBe(`cached:${ORIGIN}/manifest.json`);
    expect(sw.networkCalls).toEqual([]);
    expect(await sw.request("/icons/icon-512x512.png")).toBe(`network:${ORIGIN}/icons/icon-512x512.png`);
  });

  test("never answers page navigations, even when an old cache has that page", async () => {
    const sw = loadServiceWorker({ "reelcast-v2": [`${ORIGIN}/dashboard`, `${ORIGIN}/`] });
    expect(await sw.request("/dashboard", { mode: "navigate" })).toBe("passthrough");
    expect(await sw.request("/", { mode: "navigate" })).toBe("passthrough");
    expect(await sw.request("/video/abc", { mode: "navigate" })).toBe("passthrough");
  });

  test("never answers Next.js RSC payloads, build chunks or the API", async () => {
    const sw = loadServiceWorker({ "reelcast-v2": [`${ORIGIN}/dashboard?_rsc=1x2y3`] });
    expect(await sw.request("/dashboard?_rsc=1x2y3", { headers: { RSC: "1" } })).toBe("passthrough");
    expect(await sw.request("/_next/static/chunks/app.js")).toBe("passthrough");
    expect(await sw.request("/_next/image?url=%2Ficons%2Flogo.png&w=48&q=75")).toBe("passthrough");
    expect(await sw.request("/api/rpc")).toBe("passthrough");
    expect(await sw.request("/icons/logo.png")).toBe("passthrough");
  });

  test("ignores non-GET and cross-origin requests", async () => {
    const sw = loadServiceWorker({ "reelcast-v3": [`${ORIGIN}/manifest.json`] });
    expect(await sw.request("/manifest.json", { method: "POST" })).toBe("passthrough");
    expect(await sw.request("https://res.cloudinary.com/demo/manifest.json")).toBe("passthrough");
  });
});
