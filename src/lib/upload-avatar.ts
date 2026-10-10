/**
 * Browser side of a profile-picture upload: ask the server for a signature for ONE upload into the caller's own avatar
 * folder (/api/cloudinary/sign-avatar), send the already-cropped picture straight to Cloudinary, and return its URL.
 * The URL is then given to users.updateProfile, which checks it again before saving.
 */
type Signed = {
  signature: string;
  apiKey: string;
  cloudName: string;
  maxBytes: number;
  allowed_formats: string;
  folder: string;
  public_id: string;
  timestamp: number;
  transformation: string;
};

export async function uploadAvatar(blob: Blob): Promise<string> {
  const signRes = await fetch("/api/cloudinary/sign-avatar", { method: "POST" });
  if (!signRes.ok) throw new Error("We could not start the upload. Please try again.");
  const signed = (await signRes.json()) as Signed;
  if (blob.size > signed.maxBytes) throw new Error("That picture is too large (5 MB maximum).");

  const form = new FormData();
  // Every field below is covered by the signature; the file and api_key are not.
  for (const key of ["allowed_formats", "folder", "public_id", "timestamp", "transformation"] as const) form.append(key, String(signed[key]));
  form.append("api_key", signed.apiKey);
  form.append("signature", signed.signature);
  form.append("file", blob, "avatar.jpg");

  let res: Response;
  try {
    res = await fetch(`https://api.cloudinary.com/v1_1/${signed.cloudName}/image/upload`, { method: "POST", body: form });
  } catch {
    throw new Error("The upload failed. Check your connection and try again.");
  }
  if (!res.ok) throw new Error("The upload failed. Please try again.");
  const body = (await res.json()) as { secure_url?: unknown };
  if (typeof body.secure_url !== "string") throw new Error("The upload failed. Please try again.");
  return body.secure_url;
}
