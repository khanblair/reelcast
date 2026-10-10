// Port of convex/videos.ts (user-facing functions only). Export ONLY rpc definitions from this file.
// Internal Convex functions (internal*, processDueSchedules, ...) are now plain helpers in
// src/server/lib/content/* or live with the job handlers that use them.
import { and, desc, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { videos } from "@/db/schema";
import { kickRunner } from "@/server/jobs/kick";
import { cancelTask, enqueueTask } from "@/server/jobs/queue";
import { LIST_LIMIT, videoListColumns } from "@/server/lib/content/dto";
import { listMetadataHistory, metadataTaskKey } from "@/server/lib/content/metadata";
import {
  aiConfigSchema,
  generationConfigSchema,
  isCloudinaryUrl,
  isUuid,
  privacyStatusSchema,
  publishAsSchema,
  tagsSchema,
  uuidSchema,
} from "@/server/lib/content/schemas";
import { saveVideoMetadata } from "@/server/lib/ai/metadata";
import { consumeQuota, getUsage } from "@/server/lib/usage";
import { mutation, query } from "../rpc/define";
import { badRequest, conflict, notFound, planLimit } from "../rpc/errors";

/** Videos may be scheduled at most this far ahead (also guards against out-of-range Dates). */
const MAX_SCHEDULE_AHEAD_MS = 10 * 365 * 24 * 3_600_000;

function toScheduleDate(ms: number): Date {
  if (!Number.isFinite(ms) || ms <= 0 || ms > Date.now() + MAX_SCHEDULE_AHEAD_MS) throw badRequest("Invalid schedule time");
  return new Date(ms);
}

// ─── create ──────────────────────────────────────────────────────────────────

/** Register an uploaded file. Counts against the plan's monthly upload quota. */
export const create = mutation({
  input: z.object({
    title: z.string().max(1000),
    description: z.string().max(10_000).optional(),
    tags: tagsSchema.optional(),
    rawFileKey: z.string().max(2000).refine(isCloudinaryUrl, "rawFileKey must be a Cloudinary https URL"),
    rawFileSize: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    duration: z.number().min(0).max(1_000_000).optional(),
  }),
  handler: async (ctx, args) =>
    // One transaction: if the insert fails the quota unit is rolled back with it (no refund needed).
    ctx.db.transaction(async (tx) => {
      // ctx.user is read fresh on every request, so its plan is current: no extra `users` read.
      await consumeQuota(tx, ctx.userId, "videosUploaded", ctx.user.plan);
      const [row] = await tx
        .insert(videos)
        .values({
          userId: ctx.userId,
          title: args.title.trim() || "Untitled video",
          description: args.description,
          tags: args.tags,
          rawFileKey: args.rawFileKey,
          rawFileSize: args.rawFileSize,
          duration: args.duration,
          status: "draft",
          sourceType: "upload",
        })
        .returning({ id: videos.id });
      return row.id;
    }),
});

/**
 * Create the placeholder row for an AI-generated (Veo) video. The Veo quota is consumed when the
 * generation job starts (once per attempt); here we only fail fast for plans with no allowance left.
 */
export const createGenerated = mutation({
  input: z.object({
    title: z.string().max(1000),
    aiConfig: generationConfigSchema,
  }),
  handler: async (ctx, args) => {
    const usage = await getUsage(ctx.db, ctx.userId);
    if (usage.used.veoGenerated >= usage.limits.veoGenerated) {
      throw planLimit(`PLAN_LIMIT_EXCEEDED:veoGenerated:${usage.plan}`);
    }
    const [row] = await ctx.db
      .insert(videos)
      .values({
        userId: ctx.userId,
        title: args.title.trim() || "Untitled video",
        rawFileKey: "",
        rawFileSize: 0,
        status: "draft",
        aiConfig: args.aiConfig,
        sourceType: "generate",
      })
      .returning({ id: videos.id });
    return row.id;
  },
});

// ─── reads ───────────────────────────────────────────────────────────────────

/** The user's videos, newest first (capped at LIST_LIMIT). No caption transcripts: use `get`. */
export const list = query({
  auth: "public",
  handler: async (ctx) => {
    if (!ctx.userId) return [];
    return ctx.db
      .select(videoListColumns)
      .from(videos)
      .where(eq(videos.userId, ctx.userId))
      .orderBy(desc(videos.createdAt))
      .limit(LIST_LIMIT);
  },
});

/**
 * One video with its metadata history (newest first, last 10). `null` when it doesn't exist or
 * belongs to someone else: the detail page renders "Video not found" for null, whereas a thrown
 * error would go to the error boundary (and an error would distinguish "exists" from "not yours").
 */
export const get = query({
  input: z.object({ id: z.string() }),
  handler: async (ctx, { id }) => {
    if (!isUuid(id)) return null;
    // Both reads go out together. The history of a video that is not the caller's is fetched but dropped below:
    // it is only returned together with the owner-scoped video row, so nothing leaks.
    const [[row], metadataHistory] = await Promise.all([
      ctx.db
        .select()
        .from(videos)
        .where(and(eq(videos.id, id), eq(videos.userId, ctx.userId)))
        .limit(1),
      listMetadataHistory(ctx.db, id),
    ]);
    if (!row) return null;
    return { ...row, metadataHistory };
  },
});

/** Every video that has (or had) a publish time, newest first. Includes published/failed ones. */
export const listScheduled = query({
  auth: "public",
  handler: async (ctx) => {
    if (!ctx.userId) return [];
    return ctx.db
      .select(videoListColumns)
      .from(videos)
      .where(and(eq(videos.userId, ctx.userId), isNotNull(videos.scheduledPublishAt)))
      .orderBy(desc(videos.createdAt))
      .limit(LIST_LIMIT);
  },
});

// ─── simple owner-scoped updates ─────────────────────────────────────────────

/**
 * What the UI may set by hand. Everything else has its own path: scheduled (schedulePublish),
 * publishing/published (the publisher), generating/failed (generation jobs).
 * Each target lists the states it may be reached from (compare-and-swap).
 */
const STATUS_SOURCES = {
  draft: ["draft", "ready", "failed"],
  queued: ["draft", "queued", "failed"],
  ready: ["draft", "ready", "failed"],
} as const;

export const updateStatus = mutation({
  input: z.object({ id: uuidSchema, status: z.enum(["draft", "queued", "ready"]) }),
  handler: async (ctx, { id, status }) => {
    const sources = STATUS_SOURCES[status];
    const rows = await ctx.db
      .update(videos)
      .set({ status, updatedAt: new Date() })
      .where(
        and(
          eq(videos.id, id),
          eq(videos.userId, ctx.userId),
          inArray(videos.status, [...sources]),
          // A video without any playable file must not become publishable.
          status === "ready"
            ? or(eq(videos.status, "ready"), ne(videos.rawFileKey, ""), and(isNotNull(videos.processedFileKey), ne(videos.processedFileKey, "")))
            : undefined,
        ),
      )
      .returning({ id: videos.id });
    if (rows[0]) return;

    const [v] = await ctx.db
      .select({ status: videos.status })
      .from(videos)
      .where(and(eq(videos.id, id), eq(videos.userId, ctx.userId)))
      .limit(1);
    if (!v) throw notFound("Video not found");
    if (!(sources as readonly string[]).includes(v.status)) throw badRequest(`A ${v.status} video can't be changed to ${status}.`);
    throw badRequest("This video has no file yet, so it can't be marked ready.");
  },
});

export const updatePrivacyStatus = mutation({
  input: z.object({ id: uuidSchema, privacyStatus: privacyStatusSchema }),
  handler: async (ctx, { id, privacyStatus }) => {
    const rows = await ctx.db
      .update(videos)
      .set({ privacyStatus, updatedAt: new Date() })
      .where(and(eq(videos.id, id), eq(videos.userId, ctx.userId)))
      .returning({ id: videos.id });
    if (!rows[0]) throw notFound("Video not found");
  },
});

export const updatePublishAs = mutation({
  input: z.object({ id: uuidSchema, publishAs: publishAsSchema }),
  handler: async (ctx, { id, publishAs }) => {
    const rows = await ctx.db
      .update(videos)
      .set({ publishAs, updatedAt: new Date() })
      .where(and(eq(videos.id, id), eq(videos.userId, ctx.userId)))
      .returning({ id: videos.id });
    if (!rows[0]) throw notFound("Video not found");
  },
});

export const updateAiConfig = mutation({
  input: z.object({ id: uuidSchema, aiConfig: aiConfigSchema.optional() }),
  handler: async (ctx, { id, aiConfig }) => {
    const rows = await ctx.db
      .update(videos)
      .set({ aiConfig: aiConfig ?? null, updatedAt: new Date() })
      .where(and(eq(videos.id, id), eq(videos.userId, ctx.userId)))
      .returning({ id: videos.id });
    if (!rows[0]) throw notFound("Video not found");
  },
});

// ─── manual metadata edit ────────────────────────────────────────────────────

const YT_TITLE_MAX = 100;
const YT_DESCRIPTION_MAX_BYTES = 5_000;
const YT_TAGS_MAX_CHARS = 500;
const noAngleBrackets = (value: string) => !/[<>]/.test(value);

/** Trim, drop blanks and de-duplicate (case-insensitive), keeping the first spelling and the order. */
function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().replace(/\s+/g, " ");
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out;
}

/** YouTube counts the commas between tags and the quotes it adds around tags that contain spaces. */
function youtubeTagChars(tags: string[]): number {
  return tags.reduce((n, t) => n + t.length + (/\s/.test(t) ? 2 : 0), 0) + Math.max(tags.length - 1, 0);
}

/**
 * Edit a video's title, description and/or tags by hand. Publishing sends `ai_title ?? title` (and
 * the matching description/tags), so edits are stored in the same fields the AI writes; the values
 * they replace are pushed into the metadata history, exactly like a regeneration, so nothing is lost.
 * Only the fields you pass change. Not allowed once a video is publishing or published.
 */
export const updateMetadata = mutation({
  input: z
    .object({
      id: uuidSchema,
      title: z
        .string()
        .trim()
        .min(1, "Title is required")
        .max(YT_TITLE_MAX, `Title can be at most ${YT_TITLE_MAX} characters`)
        .refine(noAngleBrackets, "Title can't contain < or >")
        .optional(),
      description: z
        .string()
        .refine((d) => Buffer.byteLength(d, "utf8") <= YT_DESCRIPTION_MAX_BYTES, "Description is too long (YouTube allows 5,000 bytes)")
        .refine(noAngleBrackets, "Description can't contain < or >")
        .optional(),
      tags: z.array(z.string().max(100, "A tag can be at most 100 characters")).max(50, "At most 50 tags").optional(),
    })
    .refine((a) => a.title !== undefined || a.description !== undefined || a.tags !== undefined, "Nothing to update"),
  handler: async (ctx, args) => {
    const tags = args.tags ? normalizeTags(args.tags) : undefined;
    if (tags && youtubeTagChars(tags) > YT_TAGS_MAX_CHARS) {
      throw badRequest("Tags are too long: YouTube allows 500 characters in total (commas and quotes count).");
    }

    await ctx.db.transaction(async (tx) => {
      const [video] = await tx
        .select({
          id: videos.id,
          status: videos.status,
          title: videos.title,
          description: videos.description,
          tags: videos.tags,
          aiTitle: videos.aiTitle,
          aiDescription: videos.aiDescription,
          aiTags: videos.aiTags,
        })
        .from(videos)
        .where(and(eq(videos.id, args.id), eq(videos.userId, ctx.userId)))
        .for("update")
        .limit(1);
      if (!video) throw notFound("Video not found");
      if (video.status === "publishing" || video.status === "published") {
        throw conflict("This video is already publishing or published, so its details can't be changed here.");
      }

      const current = {
        title: video.aiTitle ?? video.title,
        description: video.aiDescription ?? video.description ?? "",
        tags: video.aiTags ?? video.tags ?? [],
      };
      const next = {
        title: args.title ?? current.title,
        description: args.description ?? current.description,
        tags: tags ?? current.tags,
      };
      const unchanged =
        next.title === current.title &&
        next.description === current.description &&
        next.tags.length === current.tags.length &&
        next.tags.every((t, i) => t === current.tags[i]);
      if (unchanged) return; // don't add an identical entry to the history

      await saveVideoMetadata(tx, video.id, next);
    });
  },
});

// ─── scheduling ──────────────────────────────────────────────────────────────

/**
 * Schedule a ready video. This only records the intent (status + scheduled_publish_at): the
 * publish sweep turns due rows into publish jobs, so there is nothing to cancel in a scheduler.
 */
export const schedulePublish = mutation({
  input: z.object({ id: uuidSchema, scheduledAt: z.number(), privacyStatus: privacyStatusSchema.optional() }),
  handler: async (ctx, { id, scheduledAt, privacyStatus }) => {
    const at = toScheduleDate(scheduledAt);
    const rows = await ctx.db
      .update(videos)
      .set({ status: "scheduled", scheduledPublishAt: at, updatedAt: new Date(), ...(privacyStatus ? { privacyStatus } : {}) })
      .where(and(eq(videos.id, id), eq(videos.userId, ctx.userId), eq(videos.status, "ready")))
      .returning({ id: videos.id });
    if (rows[0]) {
      // Due right now: let the runner's schedule sweep look immediately instead of at the next tick.
      if (at.getTime() <= Date.now() + 5_000) kickRunner();
      return;
    }

    const [v] = await ctx.db.select({ id: videos.id }).from(videos).where(and(eq(videos.id, id), eq(videos.userId, ctx.userId))).limit(1);
    if (!v) throw notFound("Video not found");
    throw badRequest("Only ready videos can be scheduled for publishing");
  },
});

/** Back to `ready`. Only valid while still `scheduled`: once the sweep has started publishing it can't be stopped here. */
export const cancelSchedule = mutation({
  input: z.object({ id: uuidSchema }),
  handler: async (ctx, { id }) => {
    const rows = await ctx.db
      .update(videos)
      .set({ status: "ready", scheduledPublishAt: null, updatedAt: new Date() })
      .where(and(eq(videos.id, id), eq(videos.userId, ctx.userId), eq(videos.status, "scheduled")))
      .returning({ id: videos.id });
    if (rows[0]) return;

    const [v] = await ctx.db
      .select({ status: videos.status })
      .from(videos)
      .where(and(eq(videos.id, id), eq(videos.userId, ctx.userId)))
      .limit(1);
    if (!v) throw notFound("Video not found");
    if (v.status === "ready") return; // already unscheduled (double click)
    throw badRequest(
      v.status === "publishing" || v.status === "published"
        ? "This video is already being published, so it can't be unscheduled."
        : "Only scheduled videos can be unscheduled.",
    );
  },
});

/** Queue AI-metadata generation for a draft at a future time (a `metadata.generate` task). */
export const scheduleMetadataForVideo = mutation({
  input: z.object({ id: uuidSchema, scheduledAt: z.number() }),
  handler: async (ctx, { id, scheduledAt }) => {
    const at = toScheduleDate(scheduledAt);
    const key = metadataTaskKey(id);

    await ctx.db.transaction(async (tx) => {
      const rows = await tx
        .update(videos)
        .set({ metadataScheduledAt: at, updatedAt: new Date() })
        .where(
          and(
            eq(videos.id, id),
            eq(videos.userId, ctx.userId),
            eq(videos.status, "draft"),
            or(isNull(videos.metadataScheduledAt), lte(videos.metadataScheduledAt, new Date())),
          ),
        )
        .returning({ id: videos.id });

      if (!rows[0]) {
        const [v] = await tx
          .select({ status: videos.status })
          .from(videos)
          .where(and(eq(videos.id, id), eq(videos.userId, ctx.userId)))
          .limit(1);
        if (!v) throw notFound("Video not found");
        if (v.status !== "draft") throw badRequest("Only draft videos can be queued for metadata generation");
        throw badRequest("Video already has a pending metadata job scheduled");
      }

      // A stale pending task (its time passed without running) would otherwise keep its old run_at.
      await cancelTask(tx, key);
      const { created } = await enqueueTask(tx, {
        kind: "metadata.generate",
        payload: { videoId: id },
        userId: ctx.userId,
        runAt: at,
        dedupeKey: key,
      });
      if (!created) throw conflict("Metadata generation is already running for this video.");
    });
  },
});

// ─── bulk operations (single statements) ─────────────────────────────────────

/** Draft -> ready for every draft that has a usable file. Placeholder rows (no file yet) are skipped. */
export const bulkMarkDraftsReady = mutation({
  handler: async (ctx) => {
    const rows = await ctx.db
      .update(videos)
      .set({ status: "ready", updatedAt: new Date() })
      .where(
        and(
          eq(videos.userId, ctx.userId),
          eq(videos.status, "draft"),
          or(ne(videos.rawFileKey, ""), and(isNotNull(videos.processedFileKey), ne(videos.processedFileKey, ""))),
        ),
      )
      .returning({ id: videos.id });
    return { count: rows.length };
  },
});

/** Videos longer than 60s that haven't been given an explicit publish type become regular videos. */
export const bulkSwitchLongVideosToVideo = mutation({
  handler: async (ctx) => {
    const rows = await ctx.db
      .update(videos)
      .set({ publishAs: "video", updatedAt: new Date() })
      .where(and(eq(videos.userId, ctx.userId), sql`${videos.duration} > 60`, sql`${videos.publishAs} is null`))
      .returning({ id: videos.id });
    return { switched: rows.length };
  },
});
