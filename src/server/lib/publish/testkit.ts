/**
 * Test double for the outside world of a publish: Cloudinary (HEAD / ranged GET), YouTube's resumable
 * upload endpoints and channels.list. Verifies the protocol (contiguous Content-Range, chunk sizes,
 * byte-exact content) so a regression in the upload loop fails loudly. Never touches the network.
 */
import type { FetchLike } from "@/server/lib/youtube";

/** Same cloud name the allow-list expects (NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME), so test URLs pass it. */
export const cloudUrl = (path: string) => `https://res.cloudinary.com/${process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME || "demo"}/${path}`;
export const CLOUD_URL = cloudUrl("video/upload/v1/folder/clip.mp4");
export const KIB256 = 256 * 1024;

type Session = { id: number; received: number; complete: boolean; alive: boolean };
type PutFault = { type: "status"; status: number; stored?: boolean } | { type: "network"; stored?: boolean };

export class FakeWorld {
  readonly file: Uint8Array;
  readonly log: string[] = [];
  readonly sessions: Session[] = [];
  /** Content-Range of every chunk PUT, in order. */
  readonly chunkRanges: string[] = [];
  clock = 1_000_000;
  /** Simulated ms per fetch of a chunk (read or PUT). */
  costMs = 0;
  videoId = "yt_video_1";
  storage: { headStatus: number; supportsRange: boolean; rangeStatus?: number } = { headStatus: 200, supportsRange: true };
  initStatus = 200;
  initBody = "";
  channelsStatus = 200;
  /** Faults keyed by the 0-based index of the chunk PUT (not counting status queries). */
  faults = new Map<number, PutFault>();
  private putCount = 0;
  private gate: Promise<void> | null = null;
  /** Called at the start of every fetch (lets a test pause / observe). */
  onFetch?: (url: string, method: string) => Promise<void> | void;

  constructor(size: number) {
    this.file = new Uint8Array(size);
    for (let i = 0; i < size; i++) this.file[i] = (i * 31 + 7) & 0xff;
  }

  get fetchCalls(): number {
    return this.log.length;
  }
  get initiated(): number {
    return this.sessions.length;
  }
  now = () => this.clock;
  setGate(p: Promise<void> | null) {
    this.gate = p;
  }

  readonly fetch: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    this.log.push(`${method} ${url.split("?")[0]}`);
    await this.onFetch?.(url, method);
    if (this.gate) await this.gate;
    const headers = new Headers(init?.headers as HeadersInit | undefined);

    if (url === CLOUD_URL) return this.storageRequest(method, headers);
    if (url.startsWith("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable")) return this.initiate(method);
    if (url.includes("upload_id=")) return this.sessionRequest(url, method, headers, init?.body);
    if (url.startsWith("https://www.googleapis.com/youtube/v3/channels")) return new Response(null, { status: this.channelsStatus });
    throw new Error(`FakeWorld: unexpected fetch ${method} ${url}`);
  };

  private storageRequest(method: string, headers: Headers): Response {
    if (this.storage.headStatus !== 200) return new Response(null, { status: this.storage.headStatus });
    if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-length": String(this.file.length) } });
    const range = /^bytes=(\d+)-(\d+)$/.exec(headers.get("range") ?? "");
    this.clock += this.costMs;
    if (!range) return new Response(this.file as unknown as BodyInit, { status: 200 });
    const start = Number(range[1]);
    const end = Math.min(Number(range[2]), this.file.length - 1);
    const slice = this.file.slice(start, end + 1);
    if (!this.storage.supportsRange) return new Response(this.file as unknown as BodyInit, { status: 200 });
    return new Response(slice as unknown as BodyInit, {
      status: this.storage.rangeStatus ?? 206,
      headers: { "content-range": `bytes ${start}-${end}/${this.file.length}`, "content-length": String(slice.length) },
    });
  }

  private initiate(method: string): Response {
    if (method !== "POST") throw new Error("init must be POST");
    if (this.initStatus !== 200) return new Response(this.initBody, { status: this.initStatus });
    const s: Session = { id: this.sessions.length + 1, received: 0, complete: false, alive: true };
    this.sessions.push(s);
    return new Response(null, { status: 200, headers: { Location: `https://www.googleapis.com/upload/youtube/v3/videos?upload_id=S${s.id}` } });
  }

  private status(s: Session): Response {
    if (s.complete) return Response.json({ id: this.videoId, kind: "youtube#video" }, { status: 200 });
    return new Response(null, s.received > 0 ? { status: 308, headers: { Range: `bytes=0-${s.received - 1}` } } : { status: 308 });
  }

  private sessionRequest(url: string, method: string, headers: Headers, body: BodyInit | null | undefined): Response {
    if (method !== "PUT") throw new Error("session requests must be PUT");
    const s = this.sessions[Number(/upload_id=S(\d+)/.exec(url)?.[1]) - 1];
    if (!s || !s.alive) return new Response("session gone", { status: 404 });
    const cr = headers.get("content-range") ?? "";
    if (/^bytes \*\/\d+$/.test(cr)) return this.status(s);

    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr);
    if (!m) return new Response("bad content-range", { status: 400 });
    const [start, end, total] = [Number(m[1]), Number(m[2]), Number(m[3])];
    this.clock += this.costMs;
    const index = this.putCount++;
    this.chunkRanges.push(cr);
    if (total !== this.file.length) return new Response("bad total", { status: 400 });
    const bytes = body as Uint8Array;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== end - start + 1) return new Response("bad length", { status: 400 });
    const isLast = end + 1 === total;
    if (!isLast && bytes.byteLength % KIB256 !== 0) return new Response("chunk must be a multiple of 256KiB", { status: 400 });
    const expected = this.file.subarray(start, end + 1);
    if (!bytes.every((b, i) => b === expected[i])) return new Response("content mismatch", { status: 400 });

    const store = () => {
      if (start !== s.received) return false;
      s.received = end + 1;
      if (s.received === total) s.complete = true;
      return true;
    };

    const fault = this.faults.get(index);
    if (fault) {
      if (fault.stored) store();
      if (fault.type === "network") throw new TypeError("fetch failed");
      return new Response("injected failure", { status: fault.status });
    }
    if (start !== s.received) return new Response("non-contiguous upload", { status: 400 });
    store();
    return this.status(s);
  }
}
