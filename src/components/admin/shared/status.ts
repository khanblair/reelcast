import type { Tone } from "@/components/admin/billing/format";

export type StatusInfo = { label: string; tone: Tone };

/** Explicit labels so multi-word statuses read as sentence case ("Token expired") without CSS tricks. */
const VIDEO: Record<string, StatusInfo> = {
  draft: { label: "Draft", tone: "neutral" },
  queued: { label: "Queued", tone: "pending" },
  generating: { label: "Generating", tone: "pending" },
  ready: { label: "Ready", tone: "neutral" },
  scheduled: { label: "Scheduled", tone: "pending" },
  publishing: { label: "Publishing", tone: "pending" },
  published: { label: "Published", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
};

const JOB: Record<string, StatusInfo> = {
  pending: { label: "Pending", tone: "pending" },
  processing: { label: "Processing", tone: "pending" },
  completed: { label: "Completed", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
};

const OAUTH: Record<string, StatusInfo> = {
  connected: { label: "Connected", tone: "success" },
  token_expired: { label: "Token expired", tone: "pending" },
  revoked: { label: "Revoked", tone: "danger" },
  unknown: { label: "Unknown", tone: "neutral" },
};

/** Fallback for a status this file does not know about: "some_status" -> "Some status". */
function fallback(status: string): StatusInfo {
  const text = status.replace(/_/g, " ");
  return { label: text.charAt(0).toUpperCase() + text.slice(1), tone: "neutral" };
}

export const videoStatus = (status: string): StatusInfo => VIDEO[status] ?? fallback(status);
export const jobStatus = (status: string): StatusInfo => JOB[status] ?? fallback(status);
export const oauthStatus = (status: string): StatusInfo => OAUTH[status] ?? fallback(status);

/** "publish" -> "Publish". Job types are plain words. */
export const jobTypeLabel = (type: string): string => type.charAt(0).toUpperCase() + type.slice(1);
