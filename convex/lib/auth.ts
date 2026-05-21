import { QueryCtx, MutationCtx, ActionCtx } from "../_generated/server";

export async function getCurrentUserOrThrow(ctx: QueryCtx | MutationCtx | ActionCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new Error("Unauthenticated call");
  }
  
  // Note: Depending on Convex/Clerk setup, identity.subject is usually the clerk userId
  return identity;
}

export async function getCurrentUser(ctx: QueryCtx | MutationCtx | ActionCtx) {
  const identity = await ctx.auth.getUserIdentity();
  return identity;
}
