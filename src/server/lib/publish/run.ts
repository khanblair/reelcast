/**
 * The `publish` job: upload one video to YouTube.
 *
 * Properties the runner relies on (the queue is at-least-once and a host function lives ~300s):
 *  - IDEMPOTENT: a video that already has `published_video_id` is only "finished" (status, cleanup,
 *    notification), never uploaded again. The id is persisted the instant Google returns it.
 *  - RESUMABLE: the file streams to YouTube in chunks (never buffered whole). Each run uploads what
 *    fits in its time budget, keeps the upload session in `jobs.metadata.upload`, and returns
 *    `{ deferMs }`; the next run asks Google what it already holds and continues.
 *  - EXCLUSIVE: a lease in `jobs.metadata.lease` stops two simultaneous runs of one job.
 *  - The video is marked 'failed' (and the user told) only when retries are exhausted or the cause
 *    is permanent; transient errors are rethrown and the queue retries with backoff.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { DbLike } from "@/db/client";
import { videos, youtubeChannels } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/server/crypto";
import { NonRetryableError, type JobResult } from "@/server/jobs/handlers";
import type { JobRow } from "@/server/jobs/queue";
import { isAllowedMediaUrl } from "@/server/lib/cloudinary";
import { initiateResumableUpload, YOUTUBE_UPLOAD_QUOTA_UNITS, YouTubeApiError, type YouTubeVideoMetadata } from "@/server/lib/youtube";
import { bestEffort, defaultDeps, type PublishDeps } from "./deps";
import { describeFailure, MSG_FILE_GONE, MSG_NO_CHANNEL } from "./errors";
import { failVideo, finalizePublished, recordYoutubeId, type VideoRow } from "./finalize";
import { acquireLease, releaseLease, setJobMetadataKey } from "./lease";
import { getPrimaryChannelRow } from "@/server/lib/youtube/tokens";
import { getSourceSize } from "./source";
import { setStorageHealth } from "./storage";
import { DEFAULT_CHUNK_BYTES, uploadSlice, assertValidChunkSize } from "./upload";

export type PublishCtx = { db: DbLike; now: Date; /** Absolute deadline (epoch ms) of the surrounding tick, if the runner provides one. */ deadline?: number };

export type PublishRunOptions = {
  /** Time budget for the upload loop of ONE run. Default 200s (host limit ~300s). */
  budgetMs?: number;
  chunkSize?: number;
};

export const DEFAULT_RUN_BUDGET_MS = 200_000;
/** Held while a run is alive: budget + the 60s hard-timeout margin + finishing work. */
const LEASE_TTL_MS = 290_000;
const DEFER_MS = 2_000;
const LEASE_BUSY_DEFER_MS = 15_000;
/** Runs in a row that moved no bytes before the job is failed instead of looping forever. */
const MAX_STALLED_RUNS = 5;
/** States a video may be in when its publish job runs (enqueuers already moved it to 'publishing'). */
const RUNNABLE_STATES = ["publishing", "failed", "ready", "scheduled"] as const;

// ─── persisted upload state (jobs.metadata.upload) ───────────────────────────

export type UploadState = {
  v: 1;
  sourceUrl: string;
  channelRowId: string;
  totalSize: number;
  chunkSize: number;
  /** The resumable session URI is a bearer capability: stored encrypted, like every other secret. */
  sessionUriEnc: string;
  /** Last confirmed offset (advisory: Google's answer is authoritative). */
  offset: number;
  stalls: number;
  startedAt: string;
};

function parseUploadState(raw: unknown): UploadState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Record<string, unknown>;
  if (s.v !== 1) return null;
  if (typeof s.sourceUrl !== "string" || typeof s.channelRowId !== "string" || typeof s.sessionUriEnc !== "string") return null;
  if (typeof s.totalSize !== "number" || typeof s.chunkSize !== "number" || typeof s.offset !== "number") return null;
  return {
    v: 1,
    sourceUrl: s.sourceUrl,
    channelRowId: s.channelRowId,
    totalSize: s.totalSize,
    chunkSize: s.chunkSize,
    sessionUriEnc: s.sessionUriEnc,
    offset: s.offset,
    stalls: typeof s.stalls === "number" ? s.stalls : 0,
    startedAt: typeof s.startedAt === "string" ? s.startedAt : new Date().toISOString(),
  };
}

function sessionUriOf(state: UploadState): string | null {
  try {
    return decryptSecret(state.sessionUriEnc);
  } catch {
    return null;
  }
}

// ─── channel selection ───────────────────────────────────────────────────────

/**
 * Which connected channel publishes this video: the one named by `videos.youtube_channel_id` (that
 * column holds the YouTube channel id, not the row uuid) when it belongs to the owner, else the
 * owner's PRIMARY channel (strict, like the UI's "connected" state), else none.
 */
export async function resolveChannelRow(db: DbLike, video: Pick<VideoRow, "userId" | "youtubeChannelId">): Promise<{ id: string; channelId: string } | null> {
  if (video.youtubeChannelId) {
    const [named] = await db
      .select({ id: youtubeChannels.id, channelId: youtubeChannels.channelId })
      .from(youtubeChannels)
      .where(and(eq(youtubeChannels.userId, video.userId), eq(youtubeChannels.channelId, video.youtubeChannelId)))
      .limit(1);
    if (named) return named;
  }
  const primary = await getPrimaryChannelRow(db, video.userId);
  return primary ? { id: primary.id, channelId: primary.channelId } : null;
}

// ─── the job ─────────────────────────────────────────────────────────────────

export async function runPublishJob(
  job: JobRow,
  ctx: PublishCtx,
  deps: PublishDeps = defaultDeps(),
  opts: PublishRunOptions = {},
): Promise<JobResult> {
  const { db } = ctx;

  // (1) Re-read. Anything already on YouTube is only finished, never re-uploaded.
  const [video] = await db
    .select()
    .from(videos)
    .where(and(eq(videos.id, job.videoId), eq(videos.userId, job.userId)))
    .limit(1);
  if (!video) return { metadata: { skipped: "video no longer exists" } };
  if (video.publishedVideoId) {
    await finalizePublished(db, deps, video, video.publishedVideoId);
    return { metadata: { youtubeVideoId: video.publishedVideoId } };
  }

  // Runner contract: `ctx.deadline` is the tick's claim deadline and a handler may run up to ~55s past it
  // (the host kills a function at ~300s). One slice can overrun its budget by the 60s hard-timeout
  // margin plus a few seconds of finishing work, hence the 10s reserve. Too little time left: let
  // the next tick take the job (a defer costs no attempt).
  let budgetMs = opts.budgetMs ?? DEFAULT_RUN_BUDGET_MS;
  if (ctx.deadline !== undefined) {
    const left = ctx.deadline - deps.now() - 10_000;
    if (left < 10_000) return { deferMs: DEFER_MS };
    budgetMs = Math.min(budgetMs, left);
  }

  // (2) Exclusive lease on the job.
  const lease = await acquireLease(db, job.id, LEASE_TTL_MS);
  if (!lease) return { deferMs: LEASE_BUSY_DEFER_MS };

  let clearUpload = false;
  const used: { channelRowId?: string } = {};
  try {
    return await publishOnce(job, ctx, deps, lease.metadata, budgetMs, opts.chunkSize ?? DEFAULT_CHUNK_BYTES, used);
  } catch (e) {
    const failure = describeFailure(e);
    if (failure.storageMissing) await bestEffort("flag missing storage", () => setStorageHealth(db, job.videoId, true));
    // Google rejected a token we believed valid: make the next attempt refresh it, which also
    // reveals a revoked grant (getValidAccessToken then fails permanently instead of looping on 401).
    if (e instanceof YouTubeApiError && e.status === 401 && used.channelRowId) {
      const channelRowId = used.channelRowId;
      await bestEffort("expire rejected token", () =>
        db.update(youtubeChannels).set({ tokenExpiry: new Date(Date.now() - 60_000) }).where(eq(youtubeChannels.id, channelRowId)),
      );
    }

    // (6) Out of attempts (or the cause is permanent): the video stops being "publishing".
    const exhausted = !failure.retryable || job.attempts >= job.maxAttempts;
    if (exhausted) {
      // A permanent failure may come from the session's own metadata, so a manual retry starts fresh.
      // A transient one keeps the session: Google still holds the bytes and "Retry" resumes them.
      clearUpload = !failure.retryable;
      const attemptsLabel = job.attempts <= 1 ? "1 attempt" : `${job.attempts} attempts`;
      await failVideo(db, deps, video, failure.userMessage, attemptsLabel);
    }
    throw failure.error;
  } finally {
    await bestEffort("release lease", () => releaseLease(db, job.id, lease.token, { clearUpload }));
  }
}

async function publishOnce(
  job: JobRow,
  ctx: PublishCtx,
  deps: PublishDeps,
  leaseMetadata: Record<string, unknown>,
  budgetMs: number,
  defaultChunkSize: number,
  used: { channelRowId?: string },
): Promise<JobResult> {
  const { db } = ctx;

  // (3) Claim: compare-and-swap into 'publishing' (the enqueuers usually did it already; a manual
  // retry or `jobs.create` may find the video ready/scheduled/failed). Never touches a published video.
  const [claimed] = await db
    .update(videos)
    .set({ status: "publishing", updatedAt: new Date() })
    .where(
      and(
        eq(videos.id, job.videoId),
        eq(videos.userId, job.userId),
        isNull(videos.publishedVideoId),
        inArray(videos.status, [...RUNNABLE_STATES]),
      ),
    )
    .returning();
  if (!claimed) {
    const [now] = await db.select().from(videos).where(and(eq(videos.id, job.videoId), eq(videos.userId, job.userId))).limit(1);
    if (now?.publishedVideoId) {
      await finalizePublished(db, deps, now, now.publishedVideoId);
      return { metadata: { youtubeVideoId: now.publishedVideoId } };
    }
    return { metadata: { skipped: now ? `video is ${now.status}` : "video no longer exists" } };
  }

  // Pre-flight: fail fast, before any network call, when the file is known to be gone.
  if (claimed.cloudinaryDeletedAt || claimed.storageMissing === true) throw new NonRetryableError(MSG_FILE_GONE);
  const sourceUrl = claimed.processedFileKey ?? claimed.rawFileKey;
  if (!isAllowedMediaUrl(sourceUrl)) throw new NonRetryableError("The video file location is missing or is not a supported storage URL.");

  const channel = await resolveChannelRow(db, claimed);
  if (!channel) throw new NonRetryableError(MSG_NO_CHANNEL);
  used.channelRowId = channel.id;
  const { accessToken } = await deps.getValidAccessToken(db, channel.id);

  const metadata: YouTubeVideoMetadata = {
    title: claimed.aiTitle ?? claimed.title,
    description: claimed.aiDescription ?? claimed.description ?? "",
    tags: claimed.aiTags ?? claimed.tags ?? [],
    privacyStatus: claimed.privacyStatus ?? "public",
    publishAs: claimed.publishAs ?? "short",
  };

  // (4) Resume the saved session if it is for this file and channel, else start one.
  let state = parseUploadState(leaseMetadata.upload);
  let sessionUri: string | null = null;
  if (state && state.sourceUrl === sourceUrl && state.channelRowId === channel.id) {
    try {
      assertValidChunkSize(state.chunkSize);
      sessionUri = sessionUriOf(state);
    } catch {
      sessionUri = null;
    }
  }
  if (!sessionUri) state = null;

  const startSession = async (): Promise<{ state: UploadState; sessionUri: string }> => {
    const totalSize = await getSourceSize(sourceUrl, deps.fetch);
    const uri = await initiateResumableUpload(deps.fetch, { accessToken, metadata, totalSize });
    const fresh: UploadState = {
      v: 1,
      sourceUrl,
      channelRowId: channel.id,
      totalSize,
      chunkSize: defaultChunkSize,
      sessionUriEnc: encryptSecret(uri),
      offset: 0,
      stalls: 0,
      startedAt: new Date().toISOString(),
    };
    // Persist the session BEFORE sending any bytes: a run killed mid-upload resumes it instead of
    // starting (and being billed for) a second one.
    await setJobMetadataKey(db, job.id, "upload", fresh);
    await bestEffort("quota accounting", () => deps.addYoutubeQuota(db, job.userId, YOUTUBE_UPLOAD_QUOTA_UNITS));
    return { state: fresh, sessionUri: uri };
  };

  let current: { state: UploadState; sessionUri: string } = state && sessionUri ? { state, sessionUri } : await startSession();

  for (let restarts = 0; ; restarts++) {
    const base = current.state;
    const outcome = await uploadSlice({
      f: deps.fetch,
      accessToken,
      sourceUrl,
      session: { sessionUri: current.sessionUri, totalSize: base.totalSize, chunkSize: base.chunkSize },
      budgetMs,
      now: deps.now,
      sleep: deps.sleep,
      onProgress: (offset) =>
        bestEffort("save upload progress", () => setJobMetadataKey(db, job.id, "upload", { ...base, offset })),
    });

    if (outcome.kind === "expired") {
      // The session URI is gone (404/410): start over from byte 0 with a fresh session, once per run.
      if (restarts >= 1) throw new Error("YouTube upload session expired twice in one run");
      current = await startSession();
      continue;
    }

    if (outcome.kind === "done") {
      // (5) Persist the YouTube id FIRST; only then flip status, clean up storage and notify.
      const youtubeVideoId = await recordYoutubeId(db, claimed.id, outcome.videoId);
      await finalizePublished(db, deps, claimed, youtubeVideoId);
      return { metadata: { youtubeVideoId, bytes: base.totalSize } };
    }

    // Time budget spent, file not finished: save where we are and come back.
    const stalls = outcome.offset > base.offset ? 0 : base.stalls + 1;
    if (stalls >= MAX_STALLED_RUNS) throw new Error("YouTube upload is not making progress");
    const saved: UploadState = { ...base, offset: outcome.offset, stalls };
    return {
      deferMs: DEFER_MS,
      metadata: {
        upload: saved,
        progress: { bytesUploaded: outcome.offset, totalBytes: base.totalSize, percent: Math.floor((outcome.offset / base.totalSize) * 100) },
      },
    };
  }
}
