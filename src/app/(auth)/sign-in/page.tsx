"use client";

import Link from "next/link";
import Image from "next/image";
import type { Route } from "next";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ArrowLeft,
  Mail,
  Lock,
  Eye,
  EyeOff,
  Sparkles,
  Zap,
  BarChart2,
  CalendarDays,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="w-5 h-5 shrink-0">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
      <path d="M1 1h22v22H1z" fill="none" />
    </svg>
  );
}

export default function SignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleGoogleAuth = async () => {
    const supabase = createClient();
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
  };

  const handleEmailSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
    if (authError) {
      setError(authError.message);
      setLoading(false);
    } else {
      router.push("/dashboard");
    }
  };

  return (
    <div className="min-h-screen flex">
      {/* ── Left: brand panel ── */}
      <div className="hidden lg:flex lg:w-1/2 items-center justify-center relative overflow-hidden bg-[#0a0a0a]">
        <Image src="/images/fire2.gif" alt="" fill className="object-cover opacity-25 pointer-events-none" unoptimized />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[420px] h-[420px] bg-primary/25 blur-[120px] rounded-full pointer-events-none" />
        <div className="absolute bottom-0 right-0 w-64 h-64 bg-primary/10 blur-[80px] rounded-full pointer-events-none" />

        {/* Single centered block, logo + copy + features all as one unit */}
        <div className="relative z-10 flex flex-col items-center text-center w-full max-w-[440px] px-8 xl:px-10">
          <div className="flex items-center gap-2.5 mb-10">
            <Image src="/icons/logo.png" alt="ReelCast" width={30} height={30} />
            <span className="font-bold text-white text-xl tracking-tight">ReelCast</span>
          </div>

          <span className="text-primary text-xs font-bold tracking-[0.15em] uppercase mb-4">
            AI Publishing Platform
          </span>
          <h2 className="text-3xl xl:text-[2.15rem] font-extrabold text-white leading-[1.18] mb-4">
            Your YouTube channel on autopilot.
          </h2>
          <p className="text-white/50 text-sm leading-relaxed mb-10">
            Upload footage, let AI write your metadata, schedule to peak hours, and ship content daily, without the grind.
          </p>

          <ul className="space-y-3.5 w-full text-left">
            {[
              { icon: Sparkles, text: "AI titles, descriptions & tags in seconds" },
              { icon: Zap, text: "Auto-publish queue: set it and forget it" },
              { icon: CalendarDays, text: "Full content calendar with hourly day view" },
              { icon: BarChart2, text: "Live YouTube analytics in one place" },
            ].map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3">
                <div className="h-7 w-7 rounded-lg bg-primary/20 border border-primary/15 flex items-center justify-center shrink-0">
                  <Icon className="h-3.5 w-3.5 text-primary" />
                </div>
                <span className="text-white/60 text-sm">{text}</span>
              </li>
            ))}
          </ul>
        </div>

        <p className="absolute bottom-6 text-white/20 text-xs">
          &copy; {new Date().getFullYear()} ReelCast Inc.
        </p>
      </div>

      {/* ── Right: form panel ── */}
      <div className="lg:w-1/2 flex-1 flex items-center justify-center bg-background relative overflow-hidden">
        {/* Mobile glow */}
        <div className="absolute -top-32 -left-32 w-96 h-96 bg-primary/8 blur-[120px] rounded-full pointer-events-none lg:hidden" />

        {/* Back link, absolute so it doesn't shift the centered form */}
        <div className="absolute top-5 left-5 z-10">
          <Link href="/">
            <Button variant="ghost" size="sm" className="gap-2 text-muted-foreground hover:text-foreground">
              <ArrowLeft className="w-4 h-4" />
              Back to Home
            </Button>
          </Link>
        </div>

        {/* Form, perfectly centered */}
        <div className="relative z-10 w-full max-w-[400px] px-6">
            {/* Mobile logo */}
            <div className="flex flex-col items-center mb-8 lg:hidden">
              <div className="w-14 h-14 bg-primary/10 rounded-2xl flex items-center justify-center mb-4 border border-primary/20">
                <Image src="/icons/logo.png" alt="ReelCast" width={28} height={28} />
              </div>
            </div>

            <div className="mb-8">
              <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight mb-1.5">Welcome back</h1>
              <p className="text-muted-foreground text-sm">Sign in to your ReelCast account</p>
            </div>

            {/* Google */}
            <Button
              type="button"
              onClick={handleGoogleAuth}
              variant="outline"
              className="w-full h-11 font-semibold gap-3 mb-5"
            >
              <GoogleIcon />
              Continue with Google
            </Button>

            {/* Divider */}
            <div className="relative mb-5">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-border" />
              </div>
              <div className="relative flex justify-center">
                <span className="bg-background px-3 text-xs text-muted-foreground">or continue with email</span>
              </div>
            </div>

            {/* Email + password form */}
            <form onSubmit={handleEmailSignIn} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="email" className="text-sm font-medium">Email</Label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                  <Input
                    id="email"
                    type="email"
                    placeholder="you@example.com"
                    className="pl-9 h-11"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoComplete="email"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="password" className="text-sm font-medium">Password</Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                  <Input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    placeholder="••••••••"
                    className="pl-9 pr-10 h-11"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoComplete="current-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {error && (
                <p className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
                  {error}
                </p>
              )}

              <Button
                type="submit"
                className="w-full h-11 font-semibold mt-1"
                disabled={loading}
              >
                {loading ? "Signing in…" : "Sign In"}
              </Button>
            </form>

            <p className="text-center text-sm text-muted-foreground mt-6">
              Don&apos;t have an account?{" "}
              <Link
                href={"/sign-up" as Route}
                className="font-semibold text-primary hover:underline underline-offset-4"
              >
                Sign Up
              </Link>
            </p>
        </div>
      </div>
    </div>
  );
}
