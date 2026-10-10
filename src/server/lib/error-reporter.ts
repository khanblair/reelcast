/**
 * Pluggable hook for unexpected server errors. Nothing is installed by default (a no-op), so the app has no
 * external reporting dependency; a later change registers one (Sentry, a webhook, ...) with `setErrorReporter`
 * once at startup. The RPC dispatcher calls it for INTERNAL / unexpected errors only, never for client errors.
 *
 * The report carries no input arguments and no stack: `message` is already sanitised by the caller.
 */
export type ErrorReport = {
  /** The RPC path, e.g. "videos.list". */
  path: string;
  /** Wire error code; always "INTERNAL" today. */
  code: string;
  message: string;
  /** Signed-in user id, or null. Never an email. */
  uid: string | null;
};

export type ErrorReporter = (report: ErrorReport) => void | Promise<void>;

const noop: ErrorReporter = () => {};
let current: ErrorReporter = noop;

/** Install a reporter (null restores the no-op). Returns the previous one so a test can put it back. */
export function setErrorReporter(fn: ErrorReporter | null): ErrorReporter {
  const previous = current;
  current = fn ?? noop;
  return previous;
}

/** Call the reporter. A reporter that throws or rejects must never change what the caller sees, so both are swallowed. */
export function reportError(report: ErrorReport): void {
  try {
    const out = current(report);
    if (out && typeof (out as Promise<void>).catch === "function") (out as Promise<void>).catch(() => {});
  } catch {
    // reporting is best effort
  }
}
