/**
 * One time-boxed slice of a resumable YouTube upload.
 *
 * A publish job calls `uploadSlice` once per run. It resumes from what Google says it holds (never
 * from a stored counter), pushes as many fixed-size chunks as fit in the budget, and reports where
 * it stopped. The job layer then re-runs the job (deferJob) until Google answers 200/201.
 */
import {
  CHUNK_GRANULARITY,
  isTransientUploadFailure,
  putResumableChunk,
  queryResumableUpload,
  type FetchLike,
  type ResumableStatus,
} from "@/server/lib/youtube";
import { readSourceRange } from "./source";

/** 64 x 256 KiB. Large enough to keep request overhead low, small enough to hold in memory. */
export const DEFAULT_CHUNK_BYTES = 16 * 1024 * 1024;

const CHUNK_PUT_TIMEOUT_MS = 120_000;
const CHUNK_READ_TIMEOUT_MS = 60_000;
/** Transient failures (network cut, 5xx) tolerated within one slice before giving up for this run. */
const MAX_TRANSIENT_RECOVERIES = 3;

export type UploadSession = { sessionUri: string; totalSize: number; chunkSize: number };

export type SliceOutcome =
  | { kind: "done"; videoId: string }
  | { kind: "progress"; offset: number }
  | { kind: "expired" };

export type SliceOptions = {
  f: FetchLike;
  accessToken: string;
  sourceUrl: string;
  session: UploadSession;
  /** Wall-clock budget for this slice, ms. */
  budgetMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Called after each confirmed chunk so progress survives a killed run. */
  onProgress?: (offset: number) => Promise<void>;
};

export function assertValidChunkSize(chunkSize: number): void {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0 || chunkSize % CHUNK_GRANULARITY !== 0) {
    throw new Error(`Chunk size must be a positive multiple of ${CHUNK_GRANULARITY} bytes`);
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function uploadSlice(o: SliceOptions): Promise<SliceOutcome> {
  assertValidChunkSize(o.session.chunkSize);
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? defaultSleep;
  const { sessionUri, totalSize, chunkSize } = o.session;
  const deadline = now() + o.budgetMs;
  // Never let a hung socket outlive the budget by more than a minute.
  const hardDeadline = deadline + 60_000;
  const timeoutFor = (cap: number) => Math.max(5_000, Math.min(cap, hardDeadline - now()));

  const query = () => queryResumableUpload(o.f, { sessionUri, totalSize, accessToken: o.accessToken });

  let status: ResumableStatus = await queryWithRecovery(query, sleep);
  let transient = 0;
  let lastChunkMs = 0;
  let stalls = 0;

  for (;;) {
    if (status.kind === "done") return { kind: "done", videoId: status.videoId };
    if (status.kind === "expired") return { kind: "expired" };

    const offset = status.offset;
    if (offset >= totalSize) {
      // Google holds every byte yet has not finalised. Ask again once; a persistent state is a stall.
      if (++stalls > 2) return { kind: "progress", offset };
      await sleep(1_000);
      status = await queryWithRecovery(query, sleep);
      continue;
    }

    // Stop when another chunk (estimated from the last one) would not fit.
    if (now() >= deadline || (lastChunkMs > 0 && now() + lastChunkMs * 1.25 > deadline)) {
      return { kind: "progress", offset };
    }

    const length = Math.min(chunkSize, totalSize - offset);
    const started = now();
    const chunk = await readSourceRange(o.sourceUrl, offset, offset + length - 1, o.f, timeoutFor(CHUNK_READ_TIMEOUT_MS));

    try {
      status = await putResumableChunk(o.f, {
        sessionUri,
        accessToken: o.accessToken,
        chunk,
        start: offset,
        totalSize,
        timeoutMs: timeoutFor(CHUNK_PUT_TIMEOUT_MS),
      });
    } catch (e) {
      if (!isTransientUploadFailure(e) || ++transient > MAX_TRANSIENT_RECOVERIES) throw e;
      // Outcome unknown: Google may or may not have stored the chunk. Ask, then resume from its answer.
      await sleep(Math.min(1_000 * 2 ** (transient - 1), 8_000));
      status = await queryWithRecovery(query, sleep);
      continue;
    }

    lastChunkMs = now() - started;
    if (status.kind === "incomplete") {
      if (status.offset <= offset) {
        if (++stalls > 2) throw new Error("YouTube is not accepting upload data (no progress after several attempts)");
      } else {
        stalls = 0;
      }
      await o.onProgress?.(status.offset);
    }
  }
}

/** A status query is idempotent: retry it a couple of times on transient failures. */
async function queryWithRecovery(query: () => Promise<ResumableStatus>, sleep: (ms: number) => Promise<void>): Promise<ResumableStatus> {
  let lastError: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      return await query();
    } catch (e) {
      if (!isTransientUploadFailure(e)) throw e;
      lastError = e;
      await sleep(Math.min(1_000 * 2 ** i, 4_000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("YouTube upload status check failed");
}
