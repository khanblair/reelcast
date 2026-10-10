"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import type { Route } from "next";
import { AlertTriangle, ArrowLeft, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import { api, rpcCall, useQuery } from "@/lib/rpc/client";
import { createClient } from "@/lib/supabase/client";
import { formatBytes } from "@/lib/format-bytes";

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export default function DeleteAccountPage() {
  // Read-only counts of what would be removed. Not polled: the page does not need to change under the user.
  const summary = useQuery(api.users.deletionSummary);
  const [confirmEmail, setConfirmEmail] = useState("");
  const [understood, setUnderstood] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (summary === undefined) {
    return (
      <div className="flex h-[80vh] items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  const blocked = summary.blockedReason === "last_admin";
  const emailMatches = confirmEmail.trim().toLowerCase() === summary.email.toLowerCase();
  const canDelete = emailMatches && understood && !blocked && !deleting;

  async function onDelete(e: FormEvent) {
    e.preventDefault();
    if (!canDelete) return;
    setDeleting(true);
    setError(null);
    try {
      // rpcCall, not useAction: a successful write refetches every query, and with the account already gone those
      // requests would only fail. We leave the page right after instead.
      await rpcCall("users.deleteAccount", { confirmEmail });
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "We could not delete your account. Please try again.");
      setDeleting(false);
      return;
    }
    try {
      // The server already removed the session; "local" just clears this browser's copy without another request.
      await createClient().auth.signOut({ scope: "local" });
    } catch {
      // Nothing left to sign out of.
    }
    window.location.href = "/sign-in?accountDeleted=1";
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Link
        href={"/profile" as Route}
        className="inline-flex items-center gap-1.5 rounded-sm text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to profile
      </Link>

      <div>
        <h1 className="mb-1 text-2xl font-bold tracking-tight sm:text-3xl">Delete account</h1>
        <p className="text-muted-foreground">Permanently delete your ReelCast account and everything in it.</p>
      </div>

      {blocked && (
        <div role="alert" className="flex gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
          <p>
            You are the only admin, so this account cannot be deleted yet. Make another user an admin first, then come back.
          </p>
        </div>
      )}

      <Card className="border-destructive/30">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">What will be deleted</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <ul className="list-disc space-y-1.5 pl-5 marker:text-muted-foreground">
            <li>
              {summary.videoCount > 0
                ? `${plural(summary.videoCount, "video")} and their files (${formatBytes(summary.storageBytes)}) from our storage, with their titles, descriptions, schedules and analytics`
                : "Your uploads, generated videos and their files, schedules and analytics"}
            </li>
            <li>
              {summary.channelCount > 0
                ? `Your connected YouTube ${summary.channelCount === 1 ? "channel" : `channels (${summary.channelCount})`}: we revoke ReelCast's access at Google and delete the saved tokens`
                : "Any YouTube connection, with ReelCast's access revoked at Google"}
            </li>
            <li>
              {summary.ideaCount + summary.aiSessionCount > 0
                ? `${plural(summary.ideaCount, "saved idea")} and ${plural(summary.aiSessionCount, "AI assistant conversation")}`
                : "Saved ideas and AI assistant conversations"}
            </li>
            <li>Your settings, notifications, usage history and profile picture</li>
            <li>Your billing history and payment records</li>
            <li>Your sign-in: you will not be able to log in with {summary.email} again unless you sign up anew</li>
          </ul>

          <p className="text-muted-foreground">
            Videos you already published to YouTube stay on YouTube. We delete our copies and our access to your channel, not what is on your channel.
          </p>

          {(summary.hasActiveSubscription || summary.plan !== "free") && (
            <div className="flex gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
              <p>
                You are on the <span className="font-medium capitalize">{summary.plan}</span> plan. Deleting your account ends it immediately and no further payments are taken. There is no refund for the current period.
              </p>
            </div>
          )}

          <p className="font-medium">This cannot be undone.</p>
        </CardContent>
      </Card>

      <form onSubmit={onDelete} noValidate>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Confirm</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="confirm-email">
                Type your email <span className="font-semibold">{summary.email}</span> to confirm
              </Label>
              <Input
                id="confirm-email"
                type="email"
                value={confirmEmail}
                onChange={(e) => setConfirmEmail(e.target.value)}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                disabled={deleting || blocked}
                aria-invalid={confirmEmail.length > 0 && !emailMatches ? true : undefined}
                placeholder={summary.email}
              />
            </div>

            <label className="flex items-start gap-2.5 text-sm">
              <input
                type="checkbox"
                checked={understood}
                onChange={(e) => setUnderstood(e.target.checked)}
                disabled={deleting || blocked}
                className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
              />
              <span>I understand that my account and everything in it will be permanently deleted.</span>
            </label>

            {error && (
              <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}

            <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
              <Link
                href={"/profile" as Route}
                aria-disabled={deleting || undefined}
                className="inline-flex h-10 items-center justify-center rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:pointer-events-none aria-disabled:opacity-50"
              >
                Cancel
              </Link>
              <Button type="submit" variant="destructive" disabled={!canDelete}>
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                {deleting ? "Deleting… this can take a minute" : "Delete my account permanently"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </form>
    </div>
  );
}
