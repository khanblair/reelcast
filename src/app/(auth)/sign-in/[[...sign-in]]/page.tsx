"use client";

import Link from "next/link";
import Image from "next/image";
import type { Route } from "next";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Sparkles } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

export default function CustomSignInPage() {
  const handleGoogleAuth = async () => {
    const supabase = createClient();
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4 relative overflow-hidden">
      <Link href="/" className="absolute top-6 left-6 z-20">
        <Button variant="ghost" size="sm" className="gap-2 text-muted-foreground hover:text-foreground">
          <ArrowLeft className="w-4 h-4" />
          Back to Home
        </Button>
      </Link>

      <div className="absolute inset-0 z-0 pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-primary/20 rounded-full blur-[128px] -translate-x-1/2 -translate-y-1/2" />
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-primary/10 rounded-full blur-[128px] translate-x-1/2 translate-y-1/2" />
      </div>

      <div className="relative z-10 w-full max-w-sm mx-auto">
        <div className="flex flex-col items-center mb-10 space-y-4">
          <div className="w-16 h-16 bg-primary/10 rounded-2xl flex items-center justify-center ring-1 ring-primary/20 shadow-inner">
            <Image src="/icons/logo.png" alt="ReelCast" width={32} height={32} />
          </div>
          <div className="space-y-2 text-center">
            <h1 className="text-4xl font-extrabold tracking-tight">Welcome Back</h1>
            <p className="text-muted-foreground text-sm px-6">
              Sign in to ReelCast to continue generating AI content.
            </p>
          </div>
        </div>

        <div className="bg-card border border-border/60 rounded-3xl p-8 shadow-2xl backdrop-blur-md relative">
          <div className="absolute -top-4 left-1/2 -translate-x-1/2 w-max z-20">
            <div className="bg-primary text-primary-foreground text-xs font-bold px-4 py-1.5 rounded-full shadow-lg flex items-center gap-1.5 border border-primary/20">
              <Sparkles className="w-3.5 h-3.5" /> Welcome back to the magic
            </div>
          </div>

          <div className="mt-4">
            <Button
              onClick={handleGoogleAuth}
              size="lg"
              variant="outline"
              className="w-full relative group h-14 bg-background hover:bg-muted/50 border-border/80 shadow-sm transition-all duration-300 hover:shadow-md hover:-translate-y-0.5 rounded-xl"
            >
              <div className="absolute inset-0 bg-gradient-to-r from-primary/5 to-primary/5 opacity-0 group-hover:opacity-100 transition-opacity rounded-xl pointer-events-none" />
              <div className="flex items-center justify-center w-full gap-3 pointer-events-none">
                <svg viewBox="0 0 24 24" className="w-5 h-5">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                  <path d="M1 1h22v22H1z" fill="none" />
                </svg>
                <span className="font-semibold text-base">Sign In with Google</span>
              </div>
            </Button>
          </div>
        </div>

        <p className="text-center text-sm text-muted-foreground mt-10">
          Don&apos;t have an account?{" "}
          <Link href={"/sign-up" as Route} className="font-semibold text-primary hover:underline underline-offset-4">
            Sign Up
          </Link>
        </p>
      </div>
    </div>
  );
}
