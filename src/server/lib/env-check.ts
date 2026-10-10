/**
 * Environment check (scaling ladder M-5): which variables the app needs and which of them are missing or unusable.
 *
 * Pure and import-free on purpose: it takes an env object (never reads `process.env` itself), so it can run from
 * `instrumentation.ts` at startup, from `/api/health`, and from a test with a synthetic object.
 *
 * It reports NAMES only. No value, no fragment of a value, no length ever leaves this module: the result goes to the
 * platform log and (behind the cron secret) to an HTTP response, and the values are database credentials and keys.
 */
export type EnvCheck = {
  /** Required variables that are unset, blank, or set to something the app cannot use (a bad key, a short secret). */
  missing: string[];
  /** Fixed sentences about optional variables, and why a required one is rejected. Informational: they never degrade health. */
  warnings: string[];
};

export type Env = Record<string, string | undefined>;

type Required = {
  name: string;
  /** Set but unusable? Return the reason (a fixed sentence containing no value), or null when the value is fine. */
  invalid?: (value: string, env: Env) => string | null;
};

/** A key must decode to 32 bytes exactly as src/server/crypto.ts decodes it (`Buffer.from(value, "base64")`). */
const KEY_BYTES = 32;
const CRON_SECRET_MIN_CHARS = 32;

const REQUIRED: readonly Required[] = [
  { name: "DATABASE_URL" },
  { name: "NEXT_PUBLIC_SUPABASE_URL" },
  { name: "NEXT_PUBLIC_SUPABASE_ANON_KEY" },
  {
    name: "APP_ENCRYPTION_KEY",
    invalid: (v) => (Buffer.from(v, "base64").length === KEY_BYTES ? null : "must be base64 that decodes to exactly 32 bytes (openssl rand -base64 32)"),
  },
  {
    name: "CRON_SECRET",
    invalid: (v) => (v.trim().length >= CRON_SECRET_MIN_CHARS ? null : "must be at least 32 characters (openssl rand -hex 32)"),
  },
  {
    name: "NEXT_PUBLIC_APP_URL",
    invalid: (v, env) => {
      let url: URL;
      try {
        url = new URL(v.trim());
      } catch {
        return "must be an absolute URL";
      }
      return env.NODE_ENV === "production" && url.protocol !== "https:" ? "must be an https URL in production" : null;
    },
  },
  { name: "NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME" },
  { name: "CLOUDINARY_API_KEY" },
  { name: "CLOUDINARY_API_SECRET" },
];

const OPTIONAL: readonly { name: string; consequence: string }[] = [
  { name: "GOOGLE_CLIENT_ID", consequence: "YouTube connect and publishing will not work" },
  { name: "GOOGLE_CLIENT_SECRET", consequence: "YouTube connect and publishing will not work" },
  {
    name: "GEMINI_API_KEY",
    // src/server/lib/platformKeys.ts: the key stored in Admin > Settings wins, the env var is the fallback.
    consequence: "AI features need a platform key, which can instead be stored in Admin > Settings (that one is used first)",
  },
  { name: "NEXT_PUBLIC_POSTHOG_KEY", consequence: "product analytics are disabled" },
];

const isSet = (env: Env, name: string): boolean => typeof env[name] === "string" && env[name]!.trim() !== "";

export function checkEnv(env: Env): EnvCheck {
  const missing: string[] = [];
  const warnings: string[] = [];
  for (const { name, invalid } of REQUIRED) {
    if (!isSet(env, name)) {
      missing.push(name);
      continue;
    }
    const reason = invalid?.(env[name]!, env) ?? null;
    if (reason) {
      missing.push(name);
      warnings.push(`${name} is set but unusable: ${reason}`);
    }
  }
  for (const { name, consequence } of OPTIONAL) {
    if (!isSet(env, name)) warnings.push(`${name} is not set: ${consequence}`);
  }
  return { missing, warnings };
}

export type StartupReport = {
  /** The one line to log, or null when nothing required is missing. */
  message: string | null;
  /** True when startup must be refused: something is missing AND the operator opted in with ENV_STRICT=1. */
  fatal: boolean;
};

/**
 * What the server says about its environment when it starts. A missing variable only warns by default: an optional
 * or half-configured variable must never take production down at deploy. `ENV_STRICT=1` is the opt-in for refusing to
 * start. The build ("next build" imports the server code without runtime secrets) is never checked.
 */
export function startupEnvReport(env: Env): StartupReport {
  if (env.NEXT_PHASE === "phase-production-build") return { message: null, fatal: false };
  const { missing } = checkEnv(env);
  if (missing.length === 0) return { message: null, fatal: false };
  const strict = env.ENV_STRICT === "1";
  const list = missing.join(", ");
  return {
    message: strict
      ? `[env] refusing to start (ENV_STRICT=1): missing or unusable required variables: ${list}`
      : `[env] missing or unusable required variables: ${list} (set ENV_STRICT=1 to refuse to start instead of warning)`,
    fatal: strict,
  };
}

/** `instrumentation.ts` calls this once per production server start: one `warn` line, or a throw under ENV_STRICT=1. */
export function runStartupEnvCheck(env: Env, warn: (message: string) => void = console.warn): void {
  const { message, fatal } = startupEnvReport(env);
  if (!message) return;
  if (fatal) throw new Error(message);
  warn(message);
}
