/**
 * The one structured log line per RPC call, and the auth-lookup warning.
 *
 *   {"evt":"rpc","path":"videos.list","ok":true,"code":null,"ms":123,"stmts":4,"uid":"<uuid>"}
 *
 * Fields are fixed on purpose so the line can never carry input arguments, emails, tokens, error messages or stacks:
 * `path` is the function name (length-capped, it is client supplied), `uid` is a user id only, `code` is the wire code.
 * Level: log for success, warn for client errors (4xx), error for INTERNAL / unexpected.
 */

export type RpcLogRecord = {
  path: string;
  ok: boolean;
  /** Wire error code, null on success. */
  code: string | null;
  ms: number;
  /** SQL statements the call ran. */
  stmts: number;
  uid: string | null;
};

const MAX_PATH = 120;

// Unit tests call hundreds of RPCs; their output would drown everything else. They switch it on to test the line itself.
let enabled = process.env.NODE_ENV !== "test";

/** Turn the RPC log lines on or off; returns the previous setting. Only tests need this. */
export function setRpcLogging(on: boolean): boolean {
  const previous = enabled;
  enabled = on;
  return previous;
}

const capPath = (path: unknown) => (typeof path === "string" && path.length > 0 ? path.slice(0, MAX_PATH) : "(none)");

/** Logging must never break a call: any failure here is swallowed. */
export function logRpcCall(rec: RpcLogRecord): void {
  if (!enabled) return;
  try {
    const line = JSON.stringify({
      evt: "rpc",
      path: capPath(rec.path),
      ok: rec.ok,
      code: rec.code,
      ms: Math.max(0, Math.round(rec.ms)),
      stmts: rec.stmts,
      uid: rec.uid,
    });
    if (rec.ok) console.log(line);
    else if (rec.code === "INTERNAL") console.error(line);
    else console.warn(line);
  } catch {
    // never throw from logging
  }
}

/**
 * `getSessionUser()` failed on a public function. The call goes on as signed-out (unchanged behaviour), but an auth or
 * database outage must not stay invisible. Only the error name and its code are logged, never its message
 * (database messages can echo input values).
 */
export function logRpcAuthError(path: string, err: unknown): void {
  if (!enabled) return;
  try {
    const e = err as { name?: unknown; code?: unknown } | null;
    const name = typeof e?.name === "string" ? e.name : typeof err;
    const code = typeof e?.code === "string" || typeof e?.code === "number" ? String(e.code) : null;
    console.warn(JSON.stringify({ evt: "rpc_auth_error", path: capPath(path), error: name.slice(0, 80), code: code?.slice(0, 40) ?? null }));
  } catch {
    // never throw from logging
  }
}
