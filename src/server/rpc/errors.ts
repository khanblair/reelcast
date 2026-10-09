/** Errors that are safe to show to the browser. Anything else becomes "Internal error". */
export type RpcErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "PLAN_LIMIT_EXCEEDED"
  | "RATE_LIMITED"
  | "CONFLICT"
  | "INTERNAL";

const STATUS: Record<RpcErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  BAD_REQUEST: 400,
  PLAN_LIMIT_EXCEEDED: 402,
  RATE_LIMITED: 429,
  CONFLICT: 409,
  INTERNAL: 500,
};

export class RpcError extends Error {
  readonly code: RpcErrorCode;
  readonly status: number;
  constructor(code: RpcErrorCode, message?: string) {
    super(message ?? code);
    this.name = "RpcError";
    this.code = code;
    this.status = STATUS[code];
  }
}

export const unauthenticated = (m = "Unauthenticated call") => new RpcError("UNAUTHENTICATED", m);
export const forbidden = (m = "Forbidden") => new RpcError("FORBIDDEN", m);
export const notFound = (m = "Not found") => new RpcError("NOT_FOUND", m);
export const badRequest = (m = "Bad request") => new RpcError("BAD_REQUEST", m);
export const conflict = (m = "Conflict") => new RpcError("CONFLICT", m);
/**
 * The UI parses "PLAN_LIMIT_EXCEEDED" out of the message (upload page, assistant panel),
 * so the message must contain that literal token.
 */
export const planLimit = (m: string) =>
  new RpcError("PLAN_LIMIT_EXCEEDED", m.includes("PLAN_LIMIT_EXCEEDED") ? m : `PLAN_LIMIT_EXCEEDED: ${m}`);
