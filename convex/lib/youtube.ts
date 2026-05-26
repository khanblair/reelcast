"use node";

export interface YouTubeUploadOptions {
  accessToken: string;
  title: string;
  description: string;
  tags: string[];
  videoUrl: string;
}

export async function uploadToYouTube(options: YouTubeUploadOptions): Promise<string> {
  const { accessToken, title, description, tags, videoUrl } = options;

  const videoResponse = await fetch(videoUrl);
  if (!videoResponse.ok) {
    throw new Error(`Failed to fetch video from storage: ${videoResponse.statusText}`);
  }
  const videoBuffer = await videoResponse.arrayBuffer();
  const contentLength = videoBuffer.byteLength;

  const initResponse = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-Upload-Content-Type": "video/*",
        "X-Upload-Content-Length": String(contentLength),
      },
      body: JSON.stringify({
        snippet: {
          title,
          description,
          tags,
          categoryId: "22", // People & Blogs
        },
        status: {
          privacyStatus: "private",
        },
      }),
    }
  );

  if (!initResponse.ok) {
    const error = await initResponse.text();
    throw new Error(`YouTube upload initiation failed: ${error}`);
  }

  const uploadUrl = initResponse.headers.get("Location");
  if (!uploadUrl) throw new Error("YouTube did not return an upload URL");

  const uploadResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "video/*",
      "Content-Length": String(contentLength),
    },
    body: videoBuffer,
  });

  if (!uploadResponse.ok) {
    const error = await uploadResponse.text();
    throw new Error(`YouTube video upload failed: ${error}`);
  }

  const data = await uploadResponse.json();
  if (!data.id) throw new Error("YouTube did not return a video ID");
  return data.id as string;
}

export async function refreshYouTubeToken(
  refreshToken: string
): Promise<{ accessToken: string; expiresIn: number }> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`YouTube token refresh failed: ${error}`);
  }

  const data = await response.json();
  return { accessToken: data.access_token as string, expiresIn: data.expires_in as number };
}
