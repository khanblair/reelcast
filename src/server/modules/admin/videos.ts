// Port of convex/admin/videos.ts. Admin-only.
import { and, desc, eq, ilike, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { VIDEO_STATUSES, users, videos } from "@/db/schema";
import { destroyCloudinaryAsset, extractCloudinaryPublicId } from "@/server/lib/cloudinary";
import { mutation, query } from "../../rpc/define";
import { notFound } from "../../rpc/errors";

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Videos across all users, newest first; status and title/user search are applied in SQL. */
export const listAll = query({
  auth: "admin",
  input: z.object({
    limit: z.number().int().min(1).max(500).optional(),
    status: z.enum(VIDEO_STATUSES).optional(),
    search: z.string().trim().max(100).optional(),
  }),
  handler: async (ctx, args) => {
    const conds: SQL[] = [];
    if (args.status) conds.push(eq(videos.status, args.status));
    if (args.search) {
      const pat = `%${escapeLike(args.search)}%`;
      const m = or(ilike(videos.title, pat), ilike(users.email, pat), ilike(users.name, pat));
      if (m) conds.push(m);
    }
    const rows = await ctx.db
      .select({
        id: videos.id,
        createdAt: videos.createdAt,
        title: videos.title,
        status: videos.status,
        userId: videos.userId,
        userEmail: users.email,
        userName: users.name,
        rawFileSize: videos.rawFileSize,
        publishedAt: videos.publishedAt,
        scheduledPublishAt: videos.scheduledPublishAt,
        publishedVideoId: videos.publishedVideoId,
      })
      .from(videos)
      .leftJoin(users, eq(users.id, videos.userId))
      .where(and(...conds))
      .orderBy(desc(videos.createdAt))
      .limit(args.limit ?? 100);
    return rows.map((r) => ({ ...r, userEmail: r.userEmail ?? "unknown" }));
  },
});

/**
 * Hard-delete any video (admin). The DB row goes first (children cascade: jobs, generations,
 * analytics, metadata versions; ideas just unlink); Cloudinary cleanup is best-effort afterwards,
 * so a CDN failure can never leave a dangling row or block the delete.
 */
export const adminDelete = mutation({
  auth: "admin",
  input: z.object({ videoId: z.string().uuid() }),
  handler: async (ctx, args) => {
    const [row] = await ctx.db
      .delete(videos)
      .where(eq(videos.id, args.videoId))
      .returning({ rawFileKey: videos.rawFileKey, processedFileKey: videos.processedFileKey, cloudinaryDeletedAt: videos.cloudinaryDeletedAt });
    if (!row) throw notFound("Video not found");

    let attempted = 0;
    let failed = 0;
    if (!row.cloudinaryDeletedAt) {
      const keys = [row.rawFileKey, row.processedFileKey].filter((k): k is string => !!k && k.includes("cloudinary.com"));
      const results = await Promise.allSettled(
        keys.map(async (key) => {
          const publicId = extractCloudinaryPublicId(key);
          if (!publicId) return;
          attempted++;
          await destroyCloudinaryAsset(publicId, "video");
        }),
      );
      for (const r of results) {
        if (r.status === "rejected") {
          failed++;
          console.warn("[admin.videos.adminDelete] Cloudinary destroy failed", r.reason instanceof Error ? r.reason.message : r.reason);
        }
      }
    }
    return { deleted: true, cloudinaryAttempted: attempted, cloudinaryFailed: failed };
  },
});
