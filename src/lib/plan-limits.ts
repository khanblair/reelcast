/**
 * Plan limits as plain data (no server or database imports), so the server (metering) and the
 * public marketing/billing copy read the SAME numbers and cannot drift apart.
 */
export type UsageField = "videosUploaded" | "metadataGenerated" | "veoGenerated" | "aiMessagesUsed";
export type Plan = "free" | "pro" | "elite";

/** Limits at or above this mean "unlimited". */
export const UNLIMITED = 999_999;

/** Monthly usage limits per plan. */
export const PLAN_LIMITS: Record<Plan, Record<UsageField, number>> = {
  free: { videosUploaded: 10, metadataGenerated: 5, veoGenerated: 0, aiMessagesUsed: 0 },
  pro: { videosUploaded: UNLIMITED, metadataGenerated: UNLIMITED, veoGenerated: 5, aiMessagesUsed: 200 },
  elite: { videosUploaded: UNLIMITED, metadataGenerated: UNLIMITED, veoGenerated: UNLIMITED, aiMessagesUsed: 1000 },
};

/** Max upload size per plan, in bytes (used by the Cloudinary signing route). */
export const PLAN_UPLOAD_LIMIT_BYTES: Record<Plan, number> = {
  free: 100 * 1024 * 1024,
  pro: 500 * 1024 * 1024,
  elite: 2 * 1024 * 1024 * 1024,
};
