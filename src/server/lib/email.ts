/**
 * Email notifications over the Resend REST API (BYOK: the user's own Resend key).
 * Ports convex/actions/email.ts (templates + sendEmail). No SDK: plain `fetch`.
 *
 * Server-only. The API key is passed in decrypted by the caller and is never logged.
 */

const DEFAULT_APP_URL = "https://reelcast.app";
const DEFAULT_FROM = "notifications@reelcast.app";
const RESEND_URL = "https://api.resend.com/emails";
const RESEND_TIMEOUT_MS = 10_000;

export function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? DEFAULT_APP_URL).replace(/\/+$/, "");
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function emailTemplate(body: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #111827; background: #ffffff;">
  <div style="margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid #e5e7eb;">
    <span style="font-size: 20px; font-weight: 700; color: #111827;">Reelcast</span>
  </div>
  <div style="margin-bottom: 32px;">
    ${body}
  </div>
  <div style="border-top: 1px solid #e5e7eb; padding-top: 16px; font-size: 12px; color: #6b7280;">
    You're receiving this because you enabled email notifications in your Reelcast settings.
  </div>
</body>
</html>`;
}

const BTN_DARK = "display: inline-block; background: #111827; color: #ffffff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 600;";
const BTN_RED = "display: inline-block; background: #ef4444; color: #ffffff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 600;";

export type EmailContent = { subject: string; html: string; text: string };

/** Only http(s) links may be placed in an href (a `javascript:` URL from data must never reach the DOM). */
function safeHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : "#";
}

export function publishSuccessEmail(d: { title: string; url: string; thumbnailUrl?: string }): EmailContent {
  const body = `
      <h2 style="margin: 0 0 16px; font-size: 18px;">Your video is live!</h2>
      ${d.thumbnailUrl ? `<img src="${escapeHtml(safeHref(d.thumbnailUrl))}" alt="Video thumbnail" style="width: 100%; max-width: 480px; border-radius: 8px; margin-bottom: 16px; display: block;">` : ""}
      <p style="margin: 0 0 8px;"><strong>${escapeHtml(d.title)}</strong> has been successfully published to YouTube.</p>
      <p style="margin: 0 0 24px;">
        <a href="${escapeHtml(safeHref(d.url))}" style="${BTN_RED}">Watch on YouTube</a>
      </p>
    `;
  return {
    subject: `Published: ${d.title}`,
    html: emailTemplate(body),
    text: `Your video "${d.title}" has been published to YouTube. Watch it here: ${d.url}`,
  };
}

export function publishFailureEmail(d: { title: string; error: string }): EmailContent {
  const historyUrl = `${appUrl()}/history`;
  const body = `
      <h2 style="margin: 0 0 16px; font-size: 18px;">Publish failed</h2>
      <p style="margin: 0 0 8px;"><strong>${escapeHtml(d.title)}</strong> could not be published to YouTube.</p>
      <p style="margin: 0 0 16px; padding: 12px; background: #fef2f2; border-left: 4px solid #dc2626; border-radius: 4px; color: #991b1b;">
        <strong>Error:</strong> ${escapeHtml(d.error)}
      </p>
      <p style="margin: 0 0 24px;">
        <a href="${escapeHtml(historyUrl)}" style="${BTN_DARK}">View in History &amp; Retry</a>
      </p>
    `;
  return {
    subject: `Publish failed: ${d.title}`,
    html: emailTemplate(body),
    text: `Publishing "${d.title}" failed.\n\nError: ${d.error}\n\nView your history and retry at: ${historyUrl}`,
  };
}

export function metadataReadyEmail(d: { title: string; videoId?: string }): EmailContent {
  const videoUrl = d.videoId ? `${appUrl()}/video/${d.videoId}` : `${appUrl()}/history`;
  const body = `
      <h2 style="margin: 0 0 16px; font-size: 18px;">Metadata ready for review</h2>
      <p style="margin: 0 0 8px;">AI-generated metadata for <strong>${escapeHtml(d.title)}</strong> is ready.</p>
      <p style="margin: 0 0 8px; color: #6b7280;">Review and edit the title, description, and tags before publishing.</p>
      <p style="margin: 16px 0 24px;">
        <a href="${escapeHtml(videoUrl)}" style="${BTN_DARK}">Review Metadata</a>
      </p>
    `;
  return {
    subject: `Metadata ready: ${d.title}`,
    html: emailTemplate(body),
    text: `AI-generated metadata for "${d.title}" is ready for review.\n\nReview it at: ${videoUrl}`,
  };
}

export function videoGeneratedEmail(d: { title: string; videoId?: string; withMetadata?: boolean }): EmailContent {
  const videoUrl = d.videoId ? `${appUrl()}/video/${d.videoId}` : `${appUrl()}/history`;
  const body = `
      <h2 style="margin: 0 0 16px; font-size: 18px;">Your generated video is ready</h2>
      <p style="margin: 0 0 8px;"><strong>${escapeHtml(d.title)}</strong> finished generating${d.withMetadata ? ", and AI metadata was created for it" : ""}.</p>
      <p style="margin: 0 0 8px; color: #6b7280;">Review it, adjust the details and publish when you are ready.</p>
      <p style="margin: 16px 0 24px;">
        <a href="${escapeHtml(videoUrl)}" style="${BTN_DARK}">Open video</a>
      </p>
    `;
  return {
    subject: `Video generated: ${d.title}`,
    html: emailTemplate(body),
    text: `"${d.title}" finished generating${d.withMetadata ? " and AI metadata was created for it" : ""}.\n\nOpen it at: ${videoUrl}`,
  };
}

export function metadataFailedEmail(d: { title: string; error: string; videoId?: string }): EmailContent {
  const videoUrl = d.videoId ? `${appUrl()}/video/${d.videoId}` : `${appUrl()}/history`;
  const body = `
      <h2 style="margin: 0 0 16px; font-size: 18px;">Metadata generation failed</h2>
      <p style="margin: 0 0 8px;">We could not generate metadata for <strong>${escapeHtml(d.title)}</strong>. The video remains a draft.</p>
      <p style="margin: 0 0 16px; padding: 12px; background: #fef2f2; border-left: 4px solid #dc2626; border-radius: 4px; color: #991b1b;">
        <strong>Error:</strong> ${escapeHtml(d.error)}
      </p>
      <p style="margin: 0 0 24px;">
        <a href="${escapeHtml(videoUrl)}" style="${BTN_DARK}">Open video</a>
      </p>
    `;
  return {
    subject: `Metadata failed: ${d.title}`,
    html: emailTemplate(body),
    text: `Metadata generation for "${d.title}" failed: ${d.error}\n\nOpen it at: ${videoUrl}`,
  };
}

export function storageWarningEmail(d: { message: string }): EmailContent {
  const historyUrl = `${appUrl()}/history`;
  const body = `
      <h2 style="margin: 0 0 16px; font-size: 18px;">Storage warning</h2>
      <p style="margin: 0 0 16px; white-space: pre-line;">${escapeHtml(d.message)}</p>
      <p style="margin: 0 0 24px;">
        <a href="${escapeHtml(historyUrl)}" style="${BTN_DARK}">View History</a>
      </p>
    `;
  return {
    subject: "Reelcast storage warning",
    html: emailTemplate(body),
    text: `${d.message}\n\nView your history at: ${historyUrl}`,
  };
}

export type WeeklyDigestData = {
  videosPublished: number;
  totalViews?: number;
  topVideoTitle?: string;
  topVideoViews?: number;
};

export function weeklyDigestEmail(d: WeeklyDigestData): EmailContent {
  const historyUrl = `${appUrl()}/history`;
  const videoLabel = d.videosPublished === 1 ? "video" : "videos";

  const statsRows = [
    `<tr><td style="padding: 8px 0; color: #6b7280;">Videos published</td><td style="padding: 8px 0; text-align: right; font-weight: 600;">${d.videosPublished}</td></tr>`,
    d.totalViews !== undefined
      ? `<tr><td style="padding: 8px 0; color: #6b7280;">Total views (so far)</td><td style="padding: 8px 0; text-align: right; font-weight: 600;">${d.totalViews.toLocaleString("en-US")}</td></tr>`
      : "",
  ].join("");

  const topVideoSection = d.topVideoTitle
    ? `<p style="margin: 16px 0 0; padding: 12px; background: #f9fafb; border-radius: 6px;"><strong>Top video:</strong> ${escapeHtml(d.topVideoTitle)}${d.topVideoViews !== undefined ? ` — ${d.topVideoViews.toLocaleString("en-US")} views` : ""}</p>`
    : "";

  const body = `
      <h2 style="margin: 0 0 16px; font-size: 18px;">Your weekly digest</h2>
      <p style="margin: 0 0 16px; color: #6b7280;">Here's how your channel did this past week.</p>
      <table style="width: 100%; border-collapse: collapse; margin-bottom: 8px;">
        ${statsRows}
      </table>
      ${topVideoSection}
      <p style="margin: 24px 0 0;">
        <a href="${escapeHtml(historyUrl)}" style="${BTN_DARK}">View Full History</a>
      </p>
    `;

  const textLines = [
    `You published ${d.videosPublished} ${videoLabel} this week.`,
    d.totalViews !== undefined ? `Total views so far: ${d.totalViews}` : undefined,
    d.topVideoTitle ? `Top video: ${d.topVideoTitle}${d.topVideoViews !== undefined ? ` (${d.topVideoViews} views)` : ""}` : undefined,
    `View your history at: ${historyUrl}`,
  ].filter((line): line is string => Boolean(line));

  return {
    subject: `Your weekly digest: ${d.videosPublished} ${videoLabel} published`,
    html: emailTemplate(body),
    text: textLines.join("\n\n"),
  };
}

export type SendEmailResult = { sent: boolean; reason?: string; error?: string };

/** POST one message through Resend. Never throws; the key is never included in the result or logs. */
export async function sendResendEmail(opts: {
  apiKey: string;
  from?: string | null;
  to: string;
  content: EmailContent;
}): Promise<SendEmailResult> {
  try {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: opts.from?.trim() || DEFAULT_FROM,
        to: [opts.to],
        subject: opts.content.subject,
        html: opts.content.html,
        text: opts.content.text,
      }),
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
      redirect: "error",
    });
    if (res.ok) return { sent: true };
    console.error("[email] Resend API error:", res.status);
    return { sent: false, reason: "api_error", error: `Resend responded ${res.status}` };
  } catch (e) {
    console.error("[email] Resend request failed:", e instanceof Error ? e.name : "error");
    return { sent: false, reason: "network_error", error: e instanceof Error ? e.message : "Network error." };
  }
}
