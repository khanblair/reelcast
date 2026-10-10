/**
 * Browser side of a video upload: the pure pieces the upload page needs (no server imports).
 *
 * /api/cloudinary/sign decides everything about the upload and signs it. The browser must send EXACTLY the signed
 * `params` plus the API key, the signature and the file, or Cloudinary answers "Invalid Signature". Building the form
 * from the returned `params` object (instead of naming fields here) keeps the two sides from drifting apart.
 */

/** The answer of POST /api/cloudinary/sign. */
export type SignedVideoUpload = {
  /** Where to POST the form (fixes the resource type: Cloudinary does not sign it). */
  uploadUrl: string;
  apiKey: string;
  signature: string;
  /** Every field covered by the signature, as it must be sent. */
  params: Record<string, string | number>;
};

/** The multipart form for one upload. The file and `api_key` are the only fields that are not signed. */
export function buildVideoUploadForm(file: Blob, signed: SignedVideoUpload): FormData {
  const form = new FormData();
  form.append("file", file);
  for (const [key, value] of Object.entries(signed.params)) form.append(key, String(value));
  form.append("api_key", signed.apiKey);
  form.append("signature", signed.signature);
  return form;
}

/**
 * What to tell the user when Cloudinary refuses an upload. Its JSON error message is the useful part (for example a
 * format that is not allowed is only reported once the whole file has gone up); a rejected signature gets a plain
 * sentence instead of the signing details Cloudinary echoes back.
 */
export function describeUploadFailure(status: number, responseText: string): string {
  let message = "";
  try {
    const parsed = JSON.parse(responseText) as { error?: { message?: unknown } } | null;
    if (typeof parsed?.error?.message === "string") message = parsed.error.message.trim();
  } catch {
    // Not JSON (a proxy error page, an empty body): fall back to the status.
  }
  if (/signature/i.test(message)) return "Upload failed: the upload was not authorised or has expired. Please try again.";
  if (message) return `Upload failed: ${message.slice(0, 200)}`;
  return `Upload failed: ${status}`;
}
