/**
 * Turn whatever a publish run threw into (a) the error the job layer should see and (b) the sentence
 * shown to the user. Classification uses error TYPES and structured data (HTTP status, Google's
 * `error.errors[0].reason`), never message text.
 *
 * Permanent => NonRetryableError (the queue fails the job at once, no further attempts).
 * Everything else is retried by the queue with backoff until the job's attempts run out.
 */
import { NonRetryableError } from "@/server/jobs/handlers";
import { YouTubeApiError } from "@/server/lib/youtube";
import { SourceMissingError, SourcePermanentError } from "./source";

export const MSG_FILE_GONE =
  "The video file is no longer in storage (it may have been cleaned up after a previous publish). Re-upload the video to publish it again.";
export const MSG_NO_CHANNEL = "YouTube account is not connected. Go to Settings → YouTube Channels to connect it.";
export const MSG_QUOTA =
  "YouTube's daily upload quota is used up. It resets at midnight Pacific time, then the video can be published again.";

export type Failure = {
  /** Throw this from the job handler. */
  error: Error;
  retryable: boolean;
  /** Safe, human-readable reason for notifications. */
  userMessage: string;
  /** The source file is gone: flag the video's storage as missing. */
  storageMissing: boolean;
};

const permanent = (message: string, storageMissing = false): Failure => ({
  error: new NonRetryableError(message),
  retryable: false,
  userMessage: message,
  storageMissing,
});

export function describeFailure(e: unknown): Failure {
  if (e instanceof NonRetryableError) return { error: e, retryable: false, userMessage: e.message, storageMissing: false };
  if (e instanceof SourceMissingError) return permanent(MSG_FILE_GONE, true);
  if (e instanceof SourcePermanentError) return permanent(`Could not read the video file: ${e.message}`);
  if (e instanceof YouTubeApiError) {
    const userMessage =
      e.reason === "quotaExceeded" || e.reason === "dailyLimitExceeded" || e.reason === "uploadLimitExceeded"
        ? MSG_QUOTA
        : `YouTube rejected the upload: ${e.message}`;
    if (!e.retryable) return { error: new NonRetryableError(e.message), retryable: false, userMessage, storageMissing: false };
    return { error: e, retryable: true, userMessage, storageMissing: false };
  }
  const error = e instanceof Error ? e : new Error(String(e));
  return { error, retryable: true, userMessage: error.message, storageMissing: false };
}
