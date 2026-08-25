"use node";

// HEAD request only — avoids downloading the full video body just to check
// existence. Cloudinary returns a genuine 404 with x-cld-error for a deleted
// asset, matching what a GET would report.
export async function isFileMissing(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD" });
    return res.status === 404;
  } catch {
    // Network error is inconclusive — don't flag a video as missing on a
    // transient failure, or a healthy video could get wrongly excluded from
    // auto-publish.
    return false;
  }
}
