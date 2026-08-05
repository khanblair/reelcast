"use node";

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://reelcast.app";

function escapeHtml(str: string): string {
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

export const sendEmail = internalAction({
  args: {
    userId: v.id("users"),
    subject: v.string(),
    html: v.string(),
    text: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ sent: boolean; reason?: string; error?: string }> => {
    const settings = await ctx.runQuery(internal.settings.getByVideoUserId, {
      userId: args.userId,
    });

    if (!settings?.resendApiKey || !settings.emailNotificationsEnabled) {
      return { sent: false, reason: "not_configured" };
    }

    const user = await ctx.runQuery(internal.users.internalGetById, {
      userId: args.userId,
    });

    if (!user?.email) {
      return { sent: false, reason: "not_configured" };
    }

    const fromAddress = settings.emailFromAddress ?? "notifications@reelcast.app";

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromAddress,
        to: [user.email],
        subject: args.subject,
        html: args.html,
        ...(args.text ? { text: args.text } : {}),
      }),
    });

    if (response.ok) {
      return { sent: true };
    }

    console.error("[email] Resend API error:", response.status, response.statusText);
    return { sent: false, reason: "api_error", error: response.statusText };
  },
});

export const sendPublishSuccess = internalAction({
  args: {
    userId: v.id("users"),
    videoTitle: v.string(),
    youtubeUrl: v.string(),
    thumbnailUrl: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    const safeTitle = escapeHtml(args.videoTitle);
    const safeUrl = escapeHtml(args.youtubeUrl);

    const body = `
      <h2 style="margin: 0 0 16px; font-size: 18px;">Your video is live!</h2>
      ${args.thumbnailUrl ? `<img src="${escapeHtml(args.thumbnailUrl)}" alt="Video thumbnail" style="width: 100%; max-width: 480px; border-radius: 8px; margin-bottom: 16px; display: block;">` : ""}
      <p style="margin: 0 0 8px;"><strong>${safeTitle}</strong> has been successfully published to YouTube.</p>
      <p style="margin: 0 0 24px;">
        <a href="${safeUrl}" style="display: inline-block; background: #ef4444; color: #ffffff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 600;">Watch on YouTube</a>
      </p>
    `;

    await ctx.runAction(internal.actions.email.sendEmail, {
      userId: args.userId,
      subject: `Published: ${args.videoTitle}`,
      html: emailTemplate(body),
      text: `Your video "${args.videoTitle}" has been published to YouTube. Watch it here: ${args.youtubeUrl}`,
    });
  },
});

export const sendPublishFailure = internalAction({
  args: {
    userId: v.id("users"),
    videoTitle: v.string(),
    errorMessage: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    const safeTitle = escapeHtml(args.videoTitle);
    const safeError = escapeHtml(args.errorMessage);
    const historyUrl = `${APP_URL}/history`;

    const body = `
      <h2 style="margin: 0 0 16px; font-size: 18px;">Publish failed</h2>
      <p style="margin: 0 0 8px;"><strong>${safeTitle}</strong> could not be published to YouTube.</p>
      <p style="margin: 0 0 16px; padding: 12px; background: #fef2f2; border-left: 4px solid #dc2626; border-radius: 4px; color: #991b1b;">
        <strong>Error:</strong> ${safeError}
      </p>
      <p style="margin: 0 0 24px;">
        <a href="${escapeHtml(historyUrl)}" style="display: inline-block; background: #111827; color: #ffffff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 600;">View in History &amp; Retry</a>
      </p>
    `;

    await ctx.runAction(internal.actions.email.sendEmail, {
      userId: args.userId,
      subject: `Publish failed: ${args.videoTitle}`,
      html: emailTemplate(body),
      text: `Publishing "${args.videoTitle}" failed.\n\nError: ${args.errorMessage}\n\nView your history and retry at: ${historyUrl}`,
    });
  },
});

export const sendMetadataReady = internalAction({
  args: {
    userId: v.id("users"),
    videoTitle: v.string(),
    videoId: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    const safeTitle = escapeHtml(args.videoTitle);
    const videoUrl = `${APP_URL}/video/${args.videoId}`;

    const body = `
      <h2 style="margin: 0 0 16px; font-size: 18px;">Metadata ready for review</h2>
      <p style="margin: 0 0 8px;">AI-generated metadata for <strong>${safeTitle}</strong> is ready.</p>
      <p style="margin: 0 0 8px; color: #6b7280;">Review and edit the title, description, and tags before publishing.</p>
      <p style="margin: 16px 0 24px;">
        <a href="${escapeHtml(videoUrl)}" style="display: inline-block; background: #111827; color: #ffffff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 600;">Review Metadata</a>
      </p>
    `;

    await ctx.runAction(internal.actions.email.sendEmail, {
      userId: args.userId,
      subject: `Metadata ready: ${args.videoTitle}`,
      html: emailTemplate(body),
      text: `AI-generated metadata for "${args.videoTitle}" is ready for review.\n\nReview it at: ${videoUrl}`,
    });
  },
});
