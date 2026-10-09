/**
 * Thin client for the YouTube Analytics API v2 `reports.query` endpoint.
 * https://developers.google.com/youtube/analytics/channel_reports
 * https://developers.google.com/youtube/analytics/reference/reports/query
 *
 * Verified against the docs:
 *  - `ids=channel==<CHANNEL_ID>`; `filters=video==ID1,ID2,...` (up to 500 ids);
 *  - a report with `dimensions=day` is valid with a `video` filter; with several video ids the
 *    `video` filter may also be added to `dimensions` ("even if not listed as supported");
 *  - scope: https://www.googleapis.com/auth/yt-analytics.readonly (monetary metrics need another
 *    scope and are NOT requested here);
 *  - impressions / impressionClickThroughRate are Studio-only: they are never requested, and the
 *    app must never invent them.
 *  - no `rows` in the response = no data for the query.
 */

const REPORTS_URL = "https://youtubeanalytics.googleapis.com/v2/reports";

export type YtErrorKind = "auth" | "forbidden" | "rate_limited" | "bad_request" | "server";

export class YtAnalyticsError extends Error {
  readonly kind: YtErrorKind;
  readonly status: number;
  constructor(kind: YtErrorKind, status: number, message: string) {
    super(message);
    this.name = "YtAnalyticsError";
    this.kind = kind;
    this.status = status;
  }
}

export type ReportTable = {
  headers: string[];
  rows: (string | number)[][];
};

export type ReportParams = {
  channelId: string;
  startDate: string;
  endDate: string;
  metrics: readonly string[];
  dimensions?: readonly string[];
  videoIds?: readonly string[];
  sort?: string;
};

/** Metrics for lifetime per-video snapshots (the same set the Convex version fetched). */
export const SNAPSHOT_METRICS = [
  "views",
  "estimatedMinutesWatched",
  "averageViewDuration",
  "likes",
  "comments",
  "subscribersGained",
] as const;

/** Metrics for per-day deltas. */
export const DAILY_METRICS = [...SNAPSHOT_METRICS, "subscribersLost"] as const;

const REQUEST_TIMEOUT_MS = 15_000;

function kindFor(status: number): YtErrorKind {
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server";
  return "bad_request";
}

/** Run one report. Throws YtAnalyticsError on any non-2xx; never includes the access token in messages. */
export async function runReport(accessToken: string, p: ReportParams): Promise<ReportTable> {
  const qs = new URLSearchParams({
    ids: `channel==${p.channelId}`,
    startDate: p.startDate,
    endDate: p.endDate,
    metrics: p.metrics.join(","),
  });
  if (p.dimensions?.length) qs.set("dimensions", p.dimensions.join(","));
  if (p.videoIds?.length) qs.set("filters", `video==${p.videoIds.join(",")}`);
  if (p.sort) qs.set("sort", p.sort);

  let res: Response;
  try {
    res = await fetch(`${REPORTS_URL}?${qs}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    throw new YtAnalyticsError("server", 0, `YouTube Analytics request failed: ${e instanceof Error ? e.name : "network error"}`);
  }

  if (!res.ok) {
    // The body of an error response can echo request details; keep only a short prefix.
    const body = (await res.text().catch(() => "")).slice(0, 200);
    throw new YtAnalyticsError(kindFor(res.status), res.status, `YouTube Analytics API error ${res.status}${body ? `: ${body}` : ""}`);
  }

  const data = (await res.json().catch(() => ({}))) as {
    columnHeaders?: { name: string }[];
    rows?: (string | number)[][];
  };
  return { headers: (data.columnHeaders ?? []).map((h) => h.name), rows: data.rows ?? [] };
}

/** Index a row by column name. */
export function rowToRecord(headers: string[], row: (string | number)[]): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  headers.forEach((h, i) => {
    out[h] = row[i];
  });
  return out;
}

/** UTC calendar day, YYYY-MM-DD. */
export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}
