/** Edit the signed-in user's own profile (name and picture). The email is never editable here. */
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { DbLike } from "@/db/client";
import { users } from "@/db/schema";
import { destroyCloudinaryAssets, getCloudinaryImageInfo } from "@/server/lib/cloudinary";
import { badRequest } from "@/server/rpc/errors";
import type { UserRow } from "@/server/rpc/define";
import { NAME_MAX_LENGTH, nameProblem, normalizeName } from "@/lib/profile-name";
import { checkAvatarFile, parseAvatarUrl } from "./avatar";

// The name rules live in src/lib/profile-name.ts so the edit form and this check cannot drift apart.
export { NAME_MAX_LENGTH, normalizeName };

const nameSchema = z
  .string()
  .transform(normalizeName)
  .superRefine((n, ctx) => {
    const problem = nameProblem(n);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  });

export const profileInput = z
  .object({
    name: nameSchema.optional(),
    /** A URL from /api/cloudinary/sign-avatar uploads, or null to remove the picture. */
    imageUrl: z.string().max(500).nullable().optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.imageUrl !== undefined, "Nothing to update");

export type ProfileInput = z.infer<typeof profileInput>;

export type ProfileDeps = {
  getImageInfo: typeof getCloudinaryImageInfo;
  destroyAssets: typeof destroyCloudinaryAssets;
};
export const defaultProfileDeps = (): ProfileDeps => ({ getImageInfo: getCloudinaryImageInfo, destroyAssets: destroyCloudinaryAssets });

/**
 * Applies the change and returns what is now stored. A replaced or removed picture that we uploaded is deleted from
 * Cloudinary afterwards (best effort: a failure only leaves one orphan file, which account deletion sweeps up).
 */
export async function updateProfileForUser(
  db: DbLike,
  user: UserRow,
  input: ProfileInput,
  deps: ProfileDeps = defaultProfileDeps(),
): Promise<{ name: string | null; imageUrl: string | null }> {
  const patch: { name?: string; imageUrl?: string | null } = {};
  if (input.name !== undefined) patch.name = input.name;

  let newPublicId: string | null = null;
  if (input.imageUrl !== undefined) {
    if (input.imageUrl === null) {
      patch.imageUrl = null;
    } else {
      const parsed = parseAvatarUrl(input.imageUrl, user.id);
      if (!parsed) throw badRequest("That picture cannot be used. Upload it again.");
      let info;
      try {
        info = await deps.getImageInfo(parsed.publicId);
      } catch (err) {
        console.error("[profile] could not verify the uploaded picture:", err instanceof Error ? err.message : err);
        throw badRequest("We could not check that picture. Try again.");
      }
      checkAvatarFile(info);
      patch.imageUrl = input.imageUrl;
      newPublicId = parsed.publicId;
    }
  }

  const [row] = await db
    .update(users)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(users.id, user.id))
    .returning({ name: users.name, imageUrl: users.imageUrl });

  // The previous picture is only deleted when it was one of ours and is no longer the current one.
  if (input.imageUrl !== undefined && user.imageUrl && user.imageUrl !== row.imageUrl) {
    const old = parseAvatarUrl(user.imageUrl, user.id);
    if (old && old.publicId !== newPublicId) {
      try {
        await deps.destroyAssets([old.publicId], "image");
      } catch (err) {
        console.warn("[profile] could not delete the previous picture:", err instanceof Error ? err.message : err);
      }
    }
  }
  return row;
}
