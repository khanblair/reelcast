"use client";

import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import Image from "next/image";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import { LogOut, Mail, Calendar, Video, Youtube, Shield } from "lucide-react";

function Avatar({ name, imageUrl }: { name?: string | null; imageUrl?: string | null }) {
  const initials = name
    ? name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2)
    : "?";

  if (imageUrl) {
    return (
      <Image
        src={imageUrl}
        alt={name ?? "Profile"}
        width={96}
        height={96}
        className="rounded-full object-cover ring-4 ring-border shadow-lg"
      />
    );
  }
  return (
    <div className="h-24 w-24 rounded-full bg-primary/10 ring-4 ring-border shadow-lg flex items-center justify-center text-3xl font-bold text-primary">
      {initials}
    </div>
  );
}

function StatCard({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string | number }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 p-5">
        <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
          <Icon className="h-5 w-5 text-primary" />
        </div>
        <div>
          <p className="text-2xl font-bold">{value}</p>
          <p className="text-sm text-muted-foreground">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export default function ProfilePage() {
  const user = useQuery(api.users.current);
  const stats = useQuery(api.analytics.getDashboardStats);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const router = useRouter();

  const handleSignOut = useCallback(async () => {
    setSigningOut(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = "/sign-in";
  }, [router]);

  if (user === undefined) {
    return (
      <div className="flex h-[80vh] items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  const totalVideos = stats?.statusData?.reduce((sum: number, s: { count: number }) => sum + s.count, 0) ?? 0;
  const publishedVideos = stats?.statusData?.find((s: { name: string }) => s.name === "Published")?.count ?? 0;

  return (
    <>
      <div className="max-w-2xl mx-auto space-y-8">
        {/* Header */}
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-1">Profile</h1>
          <p className="text-muted-foreground">Your account details and activity.</p>
        </div>

        {/* Profile card */}
        <Card>
          <CardContent className="p-6 sm:p-8">
            <div className="flex flex-col sm:flex-row items-center sm:items-start gap-6">
              <Avatar name={user?.name} imageUrl={user?.imageUrl} />

              <div className="flex-1 text-center sm:text-left space-y-3">
                <div>
                  <h2 className="text-2xl font-bold">{user?.name ?? "Unknown"}</h2>
                  <div className="flex items-center justify-center sm:justify-start gap-1.5 mt-1 text-muted-foreground">
                    <Mail className="h-3.5 w-3.5 shrink-0" />
                    <span className="text-sm">{user?.email}</span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Plan</span>
                  <span className={cn(
                    "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
                    user?.plan === "elite" ? "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300" :
                    user?.plan === "pro"   ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" :
                                             "bg-muted text-muted-foreground"
                  )}>
                    {user?.plan ?? "free"}
                  </span>
                </div>

                <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2">
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1 text-xs font-medium">
                    <Shield className="h-3 w-3 text-primary" />
                    Google Account
                  </span>
                  {user?.youtubeConnected && (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-red-500/10 text-red-500 px-3 py-1 text-xs font-medium">
                      <Youtube className="h-3 w-3" />
                      YouTube Connected
                    </span>
                  )}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Stats */}
        <div>
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">Activity</h3>
          <div className="grid grid-cols-2 gap-3">
            <StatCard icon={Video} label="Total Videos" value={totalVideos} />
            <StatCard icon={Youtube} label="Published" value={publishedVideos} />
          </div>
        </div>

        {/* Account info */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Account</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between py-2 border-b border-border">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Shield className="h-4 w-4" />
                Auth provider
              </div>
              <span className="text-sm font-medium">Google OAuth</span>
            </div>
            <div className="flex items-center justify-between py-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Calendar className="h-4 w-4" />
                Email
              </div>
              <span className="text-sm font-medium">{user?.email}</span>
            </div>
          </CardContent>
        </Card>

        {/* Sign out */}
        <div className="border border-destructive/30 rounded-lg p-5 bg-destructive/5">
          <h3 className="font-semibold mb-1">Sign out</h3>
          <p className="text-sm text-muted-foreground mb-4">
            You&apos;ll be redirected to the sign-in page. Your data stays intact.
          </p>
          <Button
            variant="outline"
            className="border-destructive/50 text-destructive hover:bg-destructive hover:text-destructive-foreground"
            onClick={() => setConfirmOpen(true)}
          >
            <LogOut className="h-4 w-4 mr-2" />
            Sign out
          </Button>
        </div>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-sm mx-4">
          <DialogHeader>
            <DialogTitle>Sign out?</DialogTitle>
            <DialogDescription>
              You&apos;ll need to sign back in with Google to access your account.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={signingOut}>
              Cancel
            </Button>
            <Button
              onClick={handleSignOut}
              disabled={signingOut}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {signingOut ? "Signing out…" : "Sign out"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
