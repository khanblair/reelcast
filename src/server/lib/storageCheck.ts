import { isAllowedMediaUrl } from "./cloudinary";
import type { FetchLike } from "./youtube";

/**
 * HEAD request only: avoids downloading the video body just to check existence. Cloudinary
 * returns a genuine 404 (with x-cld-error) for a deleted asset, matching what a GET would report.
 *
 * Anything that is not a Cloudinary https URL is never requested (SSRF guard) and reports
 * "not missing": we can neither prove nor disprove it.
 */
export async function isFileMissing(url: string, f: FetchLike = (i, o) => fetch(i, o)): Promise<boolean> {
  if (!isAllowedMediaUrl(url)) return false;
  try {
    const res = await f(url, { method: "HEAD", redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(10_000) });
    return res.status === 404;
  } catch {
    // Network error is inconclusive: don't flag a video as missing on a transient failure, or
    // a healthy video could get wrongly excluded from auto-publish.
    return false;
  }
}
