import type { JobStatus, JobType } from "@/lib/constants";

export interface Job {
  _id: string;
  _creationTime: number;
  userId: string;
  videoId: string;
  type: JobType;
  status: JobStatus;
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

export const JOB_TYPE_LABELS: Record<JobType, string> = {
  generation: "AI Generation",
  publish: "YouTube Publish",
};

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  pending: "Pending",
  processing: "Processing",
  completed: "Completed",
  failed: "Failed",
};
