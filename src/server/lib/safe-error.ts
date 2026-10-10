/**
 * Error text that is safe to log, store or hand to an error reporter.
 *
 * A database failure surfaces as Drizzle's "Failed query: <sql>\nparams: <bound values>", and the values are user data
 * (emails, tokens, ids). Printing the error object is no better: Node prints its own enumerable properties, and a
 * postgres.js error carries the server's `detail` ("Key (email)=(a@b.c) already exists") as one. Everything here keeps
 * the SQL text with its $1 placeholders and the database's own message, and never the values.
 */

/** Cut a message at its "params:" line when it is a Drizzle failed-query message; anything else is returned unchanged. */
export function stripQueryParams(text: string): string {
  if (!text.includes("Failed query:")) return text;
  const at = text.indexOf("\nparams:"); // the FIRST one: a bound value could itself contain the marker
  return at === -1 ? text : text.slice(0, at);
}

const firstLine = (s: string, max: number) => s.split("\n", 1)[0].slice(0, max);

/** One short line describing a thrown value, without bound query values. */
export function safeErrorMessage(err: unknown, max = 300): string {
  if (!(err instanceof Error)) return "Non-error value thrown";
  if (err.message.startsWith("Failed query:")) return firstLine(err.cause instanceof Error ? err.cause.message : "Failed query", max);
  return firstLine(err.message, max);
}

const codeOf = (e: unknown): string | null => {
  const code = (e as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" || typeof code === "number" ? String(code).slice(0, 40) : null;
};

/**
 * What to print for an unexpected error: its name, database/system code, safe message and the stack FRAMES only (the
 * stack's first lines repeat the message, params included). A string, so no console formatter can print hidden fields.
 */
export function unhandledErrorDetail(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  const code = codeOf(err) ?? (err instanceof Error ? codeOf(err.cause) : null);
  const head = `${name}${code ? ` [${code}]` : ""}: ${safeErrorMessage(err)}`;
  const frames = err instanceof Error && typeof err.stack === "string" ? err.stack.split("\n").filter((l) => /^\s+at /.test(l)).slice(0, 25) : [];
  return frames.length > 0 ? `${head}\n${frames.join("\n")}` : head;
}
