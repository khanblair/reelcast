import Link from "next/link";
import Image from "next/image";
import type { Route } from "next";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  Sparkles,
  Youtube,
  CalendarDays,
  BarChart2,
  Bot,
  Lightbulb,
  Bell,
  Film,
  Upload,
  CheckCircle,
  Zap,
  ArrowRight,
  Wand2,
  TrendingUp,
  Clock,
  Calendar,
  MessageSquare,
  Tag,
  FileText,
  Play,
  ChevronRight,
  Heart,
} from "lucide-react";

export default async function LandingPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <div className="flex flex-col min-h-screen bg-background text-foreground">
      {/* ── Header ── */}
      <header className="px-6 h-16 flex items-center border-b bg-background/90 backdrop-blur-md sticky top-0 z-50">
        <Link href="/" className="flex items-center gap-2 font-bold text-lg shrink-0">
          <Image src="/icons/logo.png" alt="ReelCast" width={26} height={26} />
          <span>ReelCast</span>
        </Link>
        <nav className="ml-10 hidden md:flex items-center gap-6">
          <Link href="#features" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">Features</Link>
          <Link href="#how-it-works" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">How it Works</Link>
          <Link href="#pricing" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">Pricing</Link>
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <ThemeToggle />
          {user ? (
            <Link href="/dashboard">
              <Button size="sm">Dashboard</Button>
            </Link>
          ) : (
            <>
              <Link href={"/sign-in" as Route}>
                <Button size="sm" variant="ghost">Sign In</Button>
              </Link>
              <Link href={"/sign-up" as Route}>
                <Button size="sm">Get Started</Button>
              </Link>
            </>
          )}
        </div>
      </header>

      <main className="flex-1 flex flex-col">

        {/* ── Hero ── */}
        <section className="relative flex flex-col items-center text-center px-4 pt-24 pb-16 md:pt-32 md:pb-24 overflow-hidden">
          {/* glow */}
          <div className="absolute inset-0 pointer-events-none">
            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[500px] bg-primary/8 blur-[120px] rounded-full" />
          </div>

          <div className="relative z-10 flex flex-col items-center max-w-4xl mx-auto">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 text-primary px-3.5 py-1 text-xs font-semibold tracking-wide mb-6">
              <Sparkles className="h-3.5 w-3.5" />
              AI-Powered YouTube Publishing
            </span>

            <h1 className="text-5xl md:text-7xl font-extrabold tracking-tight leading-[1.05] mb-6">
              From raw footage<br />
              <span className="text-primary">to live on YouTube</span>
              <br />in minutes.
            </h1>

            <p className="text-xl text-muted-foreground max-w-2xl mb-10 leading-relaxed">
              ReelCast handles everything after you hit record: AI metadata, smart scheduling,
              auto-publishing, analytics, and a full content calendar. Built for creators who
              ship daily.
            </p>

            <div className="flex flex-col sm:flex-row gap-3">
              {user ? (
                <Link href="/dashboard">
                  <Button size="lg" className="h-12 px-8 font-semibold text-base">
                    Go to Dashboard <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                </Link>
              ) : (
                <>
                  <Link href={"/sign-up" as Route}>
                    <Button size="lg" className="h-12 px-8 font-semibold text-base">
                      Start for Free <ArrowRight className="ml-2 h-4 w-4" />
                    </Button>
                  </Link>
                  <Link href={"/sign-in" as Route}>
                    <Button size="lg" variant="outline" className="h-12 px-8 text-base">
                      Sign In
                    </Button>
                  </Link>
                </>
              )}
            </div>

            <p className="mt-4 text-sm text-muted-foreground">
              Free plan available. No credit card required
            </p>
          </div>

          {/* Product mockup */}
          <div className="relative z-10 mt-16 w-full max-w-5xl mx-auto">
            <div className="rounded-2xl border bg-card shadow-2xl overflow-hidden">
              {/* browser bar */}
              <div className="flex items-center gap-2 px-4 py-3 border-b bg-muted/50">
                <div className="flex gap-1.5">
                  <span className="w-3 h-3 rounded-full bg-red-400/70" />
                  <span className="w-3 h-3 rounded-full bg-yellow-400/70" />
                  <span className="w-3 h-3 rounded-full bg-green-400/70" />
                </div>
                <div className="flex-1 mx-3 h-6 rounded-md bg-background/60 border flex items-center px-3 max-w-xs mx-auto">
                  <span className="text-xs text-muted-foreground">app.reelcast.io/dashboard</span>
                </div>
              </div>
              {/* dashboard preview */}
              <div className="grid grid-cols-5 min-h-[320px] md:min-h-[400px]">
                {/* sidebar */}
                <div className="col-span-1 border-r bg-muted/30 p-3 space-y-1 hidden md:block">
                  {[
                    { icon: BarChart2, label: "Dashboard", active: true },
                    { icon: Upload, label: "Upload" },
                    { icon: Film, label: "Videos" },
                    { icon: CalendarDays, label: "Calendar" },
                    { icon: BarChart2, label: "Analytics" },
                    { icon: Bot, label: "AI Chat" },
                  ].map(({ icon: Icon, label, active }) => (
                    <div
                      key={label}
                      className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium ${
                        active
                          ? "bg-primary/15 text-primary"
                          : "text-muted-foreground"
                      }`}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {label}
                    </div>
                  ))}
                </div>
                {/* main area */}
                <div className="col-span-5 md:col-span-4 p-5 space-y-4 bg-background/50">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs text-muted-foreground">Welcome back</p>
                      <h3 className="font-bold text-sm">Dashboard</h3>
                    </div>
                    <div className="flex gap-2">
                      <div className="h-6 w-6 rounded-md bg-primary/10 flex items-center justify-center">
                        <Bell className="h-3 w-3 text-primary" />
                      </div>
                      <div className="h-6 w-24 rounded-md bg-primary flex items-center justify-center">
                        <span className="text-xs text-white font-medium">+ Upload Video</span>
                      </div>
                    </div>
                  </div>
                  {/* stats row */}
                  <div className="grid grid-cols-4 gap-3">
                    {[
                      { label: "Published", value: "24", color: "text-green-500" },
                      { label: "Scheduled", value: "8", color: "text-blue-500" },
                      { label: "Drafts", value: "3", color: "text-orange-500" },
                      { label: "AI Generated", value: "18", color: "text-primary" },
                    ].map(({ label, value, color }) => (
                      <div key={label} className="rounded-lg border bg-card p-3">
                        <p className={`text-lg font-bold ${color}`}>{value}</p>
                        <p className="text-xs text-muted-foreground">{label}</p>
                      </div>
                    ))}
                  </div>
                  {/* video list */}
                  <div className="space-y-2">
                    {[
                      { title: "10 Tips for Better Thumbnail Design", status: "published", time: "2h ago" },
                      { title: "How I Grew My Channel to 10K in 90 Days", status: "scheduled", time: "Tomorrow 9am" },
                      { title: "The Perfect YouTube Workflow for 2026", status: "generating", time: "Processing..." },
                    ].map(({ title, status, time }) => (
                      <div key={title} className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2">
                        <div className="h-8 w-12 rounded bg-muted flex items-center justify-center shrink-0">
                          <Play className="h-3 w-3 text-muted-foreground" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium truncate">{title}</p>
                          <p className="text-xs text-muted-foreground">{time}</p>
                        </div>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${
                          status === "published" ? "bg-green-500/10 text-green-600" :
                          status === "scheduled" ? "bg-blue-500/10 text-blue-600" :
                          "bg-orange-500/10 text-orange-600"
                        }`}>{status}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── Stats bar ── */}
        <section className="border-y bg-muted/30 py-10 px-4">
          <div className="max-w-4xl mx-auto grid grid-cols-2 md:grid-cols-4 gap-8 text-center">
            {[
              { value: "10K+", label: "Videos Published" },
              { value: "95%", label: "Time Saved on Metadata" },
              { value: "3x", label: "Average Channel Growth" },
              { value: "50+", label: "Active Channels" },
            ].map(({ value, label }) => (
              <div key={label}>
                <p className="text-3xl font-extrabold text-primary tabular-nums">{value}</p>
                <p className="text-sm text-muted-foreground mt-1">{label}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ── Features Grid ── */}
        <section id="features" className="w-full py-24 px-4 md:px-6 max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <span className="text-xs font-semibold tracking-widest text-primary uppercase">Features</span>
            <h2 className="text-3xl md:text-5xl font-bold tracking-tight mt-3 mb-4">
              Everything you need to grow on YouTube
            </h2>
            <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
              ReelCast replaces five separate tools. One platform, every feature a serious creator needs.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {[
              {
                icon: Sparkles,
                color: "text-primary bg-primary/10",
                title: "AI Metadata Generation",
                desc: "Click-worthy titles, SEO-optimized descriptions, and trending tags, generated automatically from your video content.",
              },
              {
                icon: Youtube,
                color: "text-red-500 bg-red-500/10",
                title: "Direct YouTube Publishing",
                desc: "Connect your channel once. Publish directly from ReelCast with one click, no re-uploading, no switching tabs.",
              },
              {
                icon: Zap,
                color: "text-yellow-500 bg-yellow-500/10",
                title: "Auto-Publish Queue",
                desc: "Set your publishing cadence, fill the queue, and let ReelCast publish on schedule, even while you sleep.",
              },
              {
                icon: CalendarDays,
                color: "text-blue-500 bg-blue-500/10",
                title: "Content Calendar",
                desc: "Year, month, week, and day views of your publishing schedule. A full Google Calendar-style experience for your channel.",
              },
              {
                icon: Film,
                color: "text-purple-500 bg-purple-500/10",
                title: "AI Video Generation",
                desc: "Generate short-form video clips with Google Veo. Prompt-to-video in minutes, ready to publish straight from the platform.",
              },
              {
                icon: BarChart2,
                color: "text-green-500 bg-green-500/10",
                title: "Analytics Dashboard",
                desc: "Track views, watch time, CTR, revenue, and subscriber growth, all sourced live from the YouTube Analytics API.",
              },
              {
                icon: Bot,
                color: "text-cyan-500 bg-cyan-500/10",
                title: "AI Chat Assistant",
                desc: "A DeepSeek-powered assistant that knows your channel data, your schedule, and your content strategy. Ask it anything.",
              },
              {
                icon: Lightbulb,
                color: "text-orange-500 bg-orange-500/10",
                title: "Idea Vault",
                desc: "Capture and organize content ideas with tags, notes, and production status. Link ideas directly to videos in your queue.",
              },
              {
                icon: Bell,
                color: "text-pink-500 bg-pink-500/10",
                title: "Smart Notifications",
                desc: "Get real-time publish confirmations, failure alerts, and weekly digests via Telegram, Discord, or email.",
              },
            ].map(({ icon: Icon, color, title, desc }) => (
              <div
                key={title}
                className="group flex flex-col p-6 rounded-2xl border bg-card hover:border-primary/40 hover:shadow-md transition-all duration-200"
              >
                <div className={`h-11 w-11 rounded-xl flex items-center justify-center mb-4 ${color}`}>
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="font-bold text-base mb-2">{title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ── How it Works ── */}
        <section id="how-it-works" className="w-full py-24 px-4 md:px-6 bg-muted/30 border-y">
          <div className="max-w-5xl mx-auto">
            <div className="text-center mb-16">
              <span className="text-xs font-semibold tracking-widest text-primary uppercase">Workflow</span>
              <h2 className="text-3xl md:text-5xl font-bold tracking-tight mt-3 mb-4">
                Ship videos faster than ever
              </h2>
              <p className="text-lg text-muted-foreground">Three steps from raw file to live video.</p>
            </div>

            <div className="grid md:grid-cols-3 gap-8 relative">
              <div className="hidden md:block absolute top-10 left-[calc(16.7%+2rem)] right-[calc(16.7%+2rem)] h-px bg-border" />
              {[
                {
                  step: "01",
                  icon: Upload,
                  title: "Upload Your Footage",
                  desc: "Drop in your raw video file. ReelCast stores it securely in the cloud, ready for processing.",
                },
                {
                  step: "02",
                  icon: Wand2,
                  title: "AI Does the Work",
                  desc: "Our AI analyzes your video and generates an optimized title, description, and tags in seconds.",
                },
                {
                  step: "03",
                  icon: Youtube,
                  title: "Publish or Schedule",
                  desc: "Review the metadata, tweak if needed, then publish immediately or queue it for the perfect time slot.",
                },
              ].map(({ step, icon: Icon, title, desc }) => (
                <div key={step} className="flex flex-col items-center text-center relative">
                  <div className="w-20 h-20 rounded-2xl bg-card border-2 border-primary/50 flex items-center justify-center mb-6 shadow-sm relative z-10">
                    <Icon className="h-8 w-8 text-primary" />
                  </div>
                  <span className="text-xs font-bold text-primary tracking-widest mb-2">{step}</span>
                  <h3 className="font-bold text-lg mb-2">{title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">{desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── Feature Spotlight 1: AI Metadata ── */}
        <section className="w-full py-24 px-4 md:px-6 max-w-6xl mx-auto">
          <div className="grid lg:grid-cols-2 gap-16 items-center">
            <div>
              <span className="text-xs font-semibold tracking-widest text-primary uppercase">AI Metadata</span>
              <h2 className="text-3xl md:text-4xl font-bold tracking-tight mt-3 mb-6">
                Metadata that ranks. Written by AI, refined by you.
              </h2>
              <p className="text-muted-foreground mb-8 leading-relaxed">
                Stop spending an hour on every title and description. ReelCast&apos;s AI reads your video
                and generates fully optimized metadata tailored to your niche, tone, and brand voice.
              </p>
              <ul className="space-y-4">
                {[
                  { icon: FileText, text: "Click-worthy titles with keyword optimization" },
                  { icon: Tag, text: "SEO description with timestamp hooks" },
                  { icon: Sparkles, text: "Up to 15 trending, relevant tags" },
                  { icon: CheckCircle, text: "Tone and niche configured once, applied always" },
                ].map(({ icon: Icon, text }) => (
                  <li key={text} className="flex items-start gap-3">
                    <div className="h-6 w-6 rounded-md bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                      <Icon className="h-3.5 w-3.5 text-primary" />
                    </div>
                    <span className="text-sm leading-relaxed">{text}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Metadata card mockup */}
            <div className="rounded-2xl border bg-card shadow-xl p-6 space-y-5">
              <div className="flex items-center gap-2 mb-2">
                <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
                  <Sparkles className="h-4 w-4 text-primary" />
                </div>
                <div>
                  <p className="text-xs font-semibold">AI Metadata</p>
                  <p className="text-xs text-muted-foreground">Generated in 4.2s</p>
                </div>
                <span className="ml-auto text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-600 font-medium">Ready</span>
              </div>

              <div className="space-y-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground block mb-1.5">Title</label>
                  <div className="rounded-lg border bg-background px-3 py-2.5 text-sm font-medium">
                    10 YouTube Thumbnail Mistakes Killing Your CTR (Fix These Today)
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground block mb-1.5">Description</label>
                  <div className="rounded-lg border bg-background px-3 py-2.5 text-sm text-muted-foreground text-xs leading-relaxed line-clamp-4">
                    Are your thumbnails costing you clicks? In this video, I break down the 10 most common thumbnail mistakes and show you exactly how to fix them. From text size to color contrast, these simple changes can double your CTR overnight...
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground block mb-1.5">Tags</label>
                  <div className="flex flex-wrap gap-1.5">
                    {["youtube thumbnails", "increase CTR", "thumbnail design", "youtube growth", "content creator tips", "youtube algorithm"].map((tag) => (
                      <span key={tag} className="text-xs px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground border">{tag}</span>
                    ))}
                  </div>
                </div>
              </div>

              <div className="flex gap-2 pt-1">
                <Button size="sm" className="flex-1 text-xs h-8">Publish Now</Button>
                <Button size="sm" variant="outline" className="flex-1 text-xs h-8">Schedule</Button>
              </div>
            </div>
          </div>
        </section>

        {/* ── Feature Spotlight 2: Content Calendar ── */}
        <section className="w-full py-24 px-4 md:px-6 bg-muted/30 border-y">
          <div className="max-w-6xl mx-auto grid lg:grid-cols-2 gap-16 items-center">
            {/* Calendar mockup */}
            <div className="rounded-2xl border bg-card shadow-xl p-5 space-y-4 order-2 lg:order-1">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CalendarDays className="h-4 w-4 text-primary" />
                  <span className="font-semibold text-sm">August 2026</span>
                </div>
                <div className="flex gap-1">
                  {["Year", "Month", "Week", "Day"].map((v, i) => (
                    <span key={v} className={`text-xs px-2 py-0.5 rounded-md cursor-pointer ${i === 1 ? "bg-primary text-white" : "text-muted-foreground hover:bg-secondary"}`}>{v}</span>
                  ))}
                </div>
              </div>
              {/* Mini calendar grid */}
              <div className="grid grid-cols-7 gap-1 text-center">
                {["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((d) => (
                  <div key={d} className="text-xs font-medium text-muted-foreground py-1">{d}</div>
                ))}
                {Array.from({ length: 35 }, (_, i) => {
                  const day = i - 3;
                  const hasEvent = [5, 8, 12, 15, 19, 22, 26, 29].includes(day);
                  const isToday = day === 6;
                  return (
                    <div
                      key={i}
                      className={`relative rounded-lg py-1.5 text-xs ${
                        day < 1 || day > 31 ? "text-muted-foreground/30" :
                        isToday ? "bg-primary text-white font-bold" :
                        hasEvent ? "bg-primary/10 text-primary font-medium border border-primary/20" :
                        "text-foreground hover:bg-secondary"
                      }`}
                    >
                      {day >= 1 && day <= 31 ? day : ""}
                      {hasEvent && !isToday && (
                        <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-primary" />
                      )}
                    </div>
                  );
                })}
              </div>
              {/* Event list */}
              <div className="space-y-2 pt-1 border-t">
                <p className="text-xs font-medium text-muted-foreground">Upcoming</p>
                {[
                  { title: "YouTube Shorts Growth Hacks", time: "Aug 8, 9:00 AM", color: "bg-blue-500" },
                  { title: "Vlog: Behind the Scenes", time: "Aug 12, 2:00 PM", color: "bg-green-500" },
                  { title: "Q&A with Subscribers", time: "Aug 15, 11:00 AM", color: "bg-primary" },
                ].map(({ title, time, color }) => (
                  <div key={title} className="flex items-center gap-2.5 rounded-lg border bg-background px-3 py-2">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${color}`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate">{title}</p>
                      <p className="text-xs text-muted-foreground">{time}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="order-1 lg:order-2">
              <span className="text-xs font-semibold tracking-widest text-primary uppercase">Content Calendar</span>
              <h2 className="text-3xl md:text-4xl font-bold tracking-tight mt-3 mb-6">
                A full publishing calendar, built for creators.
              </h2>
              <p className="text-muted-foreground mb-8 leading-relaxed">
                See everything at a glance, year, month, week, or day. Plan your publishing cadence,
                spot gaps in your schedule, and never miss a posting day again.
              </p>
              <ul className="space-y-4">
                {[
                  { icon: Calendar, text: "Year, month, week, and Google Calendar-style day view" },
                  { icon: Clock, text: "Hourly day timeline with event blocks for precise scheduling" },
                  { icon: Zap, text: "Auto-publish fills your calendar slots automatically" },
                  { icon: TrendingUp, text: "Dynamic stats update based on selected timeframe" },
                ].map(({ icon: Icon, text }) => (
                  <li key={text} className="flex items-start gap-3">
                    <div className="h-6 w-6 rounded-md bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                      <Icon className="h-3.5 w-3.5 text-primary" />
                    </div>
                    <span className="text-sm leading-relaxed">{text}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* ── Feature Spotlight 3: Analytics ── */}
        <section className="w-full py-24 px-4 md:px-6 max-w-6xl mx-auto">
          <div className="grid lg:grid-cols-2 gap-16 items-center">
            <div>
              <span className="text-xs font-semibold tracking-widest text-primary uppercase">Analytics</span>
              <h2 className="text-3xl md:text-4xl font-bold tracking-tight mt-3 mb-6">
                Know exactly what&apos;s working.
              </h2>
              <p className="text-muted-foreground mb-8 leading-relaxed">
                Pull live data directly from the YouTube Analytics API. Understand your audience,
                track your growth, and make content decisions backed by real numbers, not guesswork.
              </p>
              <ul className="space-y-4">
                {[
                  { icon: TrendingUp, text: "Views, watch time, and subscriber growth trends" },
                  { icon: BarChart2, text: "CTR, impressions, and traffic source breakdown" },
                  { icon: MessageSquare, text: "Revenue, RPM, and CPM for monetized channels" },
                  { icon: CheckCircle, text: "Per-video deep-dive alongside channel overview" },
                ].map(({ icon: Icon, text }) => (
                  <li key={text} className="flex items-start gap-3">
                    <div className="h-6 w-6 rounded-md bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                      <Icon className="h-3.5 w-3.5 text-primary" />
                    </div>
                    <span className="text-sm leading-relaxed">{text}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Analytics mockup */}
            <div className="rounded-2xl border bg-card shadow-xl p-5 space-y-4">
              <div className="flex items-center gap-2">
                <BarChart2 className="h-4 w-4 text-primary" />
                <span className="font-semibold text-sm">Channel Analytics</span>
                <span className="ml-auto text-xs text-muted-foreground">Last 30 days</span>
              </div>
              {/* Stat tiles */}
              <div className="grid grid-cols-2 gap-3">
                {[
                  { label: "Views", value: "48,291", change: "+12.4%", up: true },
                  { label: "Watch Time", value: "3,204 hrs", change: "+8.1%", up: true },
                  { label: "Subscribers", value: "+342", change: "+5.7%", up: true },
                  { label: "CTR", value: "6.8%", change: "-0.3%", up: false },
                ].map(({ label, value, change, up }) => (
                  <div key={label} className="rounded-xl border bg-background p-3">
                    <p className="text-xs text-muted-foreground">{label}</p>
                    <p className="text-base font-bold tabular-nums mt-0.5">{value}</p>
                    <p className={`text-xs font-medium mt-0.5 ${up ? "text-green-500" : "text-red-500"}`}>{change}</p>
                  </div>
                ))}
              </div>
              {/* Fake bar chart */}
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Views by video</p>
                {[
                  { title: "Thumbnail Mistakes", pct: 88 },
                  { title: "Channel Growth 10K", pct: 72 },
                  { title: "Perfect Workflow", pct: 54 },
                  { title: "Shorts Strategy", pct: 41 },
                ].map(({ title, pct }) => (
                  <div key={title} className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground w-36 truncate shrink-0">{title}</span>
                    <div className="flex-1 h-2 rounded-full bg-secondary overflow-hidden">
                      <div className="h-full rounded-full bg-primary/70" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-xs tabular-nums w-8 text-right text-muted-foreground">{pct}%</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ── Pricing teaser ── */}
        <section id="pricing" className="w-full py-24 px-4 md:px-6 bg-muted/30 border-y">
          <div className="max-w-4xl mx-auto text-center mb-14">
            <span className="text-xs font-semibold tracking-widest text-primary uppercase">Pricing</span>
            <h2 className="text-3xl md:text-5xl font-bold tracking-tight mt-3 mb-4">
              Start free. Scale when you&apos;re ready.
            </h2>
            <p className="text-lg text-muted-foreground">No credit card needed to get started.</p>
          </div>

          <div className="max-w-3xl mx-auto grid md:grid-cols-2 gap-6">
            {/* Free */}
            <div className="rounded-2xl border bg-card p-8">
              <p className="text-sm font-semibold text-muted-foreground mb-1">Free</p>
              <p className="text-4xl font-extrabold mb-1">$0</p>
              <p className="text-sm text-muted-foreground mb-8">Forever free, no card required</p>
              <ul className="space-y-3 mb-8">
                {[
                  "5 video uploads / month",
                  "AI metadata generation",
                  "YouTube publishing",
                  "Basic scheduling",
                  "Content calendar",
                ].map((f) => (
                  <li key={f} className="flex items-center gap-2.5 text-sm">
                    <CheckCircle className="h-4 w-4 text-green-500 shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>
              {user ? (
                <Link href="/dashboard">
                  <Button variant="outline" className="w-full">Go to Dashboard</Button>
                </Link>
              ) : (
                <Link href={"/sign-up" as Route}>
                  <Button variant="outline" className="w-full">Get Started Free</Button>
                </Link>
              )}
            </div>

            {/* Pro */}
            <div className="rounded-2xl border-2 border-primary bg-card p-8 relative overflow-hidden">
              <div className="absolute top-4 right-4">
                <span className="text-xs font-bold px-2.5 py-1 rounded-full bg-primary text-white">Popular</span>
              </div>
              <p className="text-sm font-semibold text-primary mb-1">Pro</p>
              <p className="text-4xl font-extrabold mb-1">$29<span className="text-lg font-medium text-muted-foreground">/mo</span></p>
              <p className="text-sm text-muted-foreground mb-8">For serious creators</p>
              <ul className="space-y-3 mb-8">
                {[
                  "Unlimited video uploads",
                  "AI video generation (Veo)",
                  "Auto-publish queue",
                  "Full analytics dashboard",
                  "AI chat assistant",
                  "Idea Vault + notifications",
                  "Discord, Telegram & email alerts",
                ].map((f) => (
                  <li key={f} className="flex items-center gap-2.5 text-sm">
                    <CheckCircle className="h-4 w-4 text-primary shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>
              {user ? (
                <Link href="/settings">
                  <Button className="w-full">Upgrade to Pro</Button>
                </Link>
              ) : (
                <Link href={"/sign-up" as Route}>
                  <Button className="w-full">Start Free Trial</Button>
                </Link>
              )}
            </div>
          </div>
        </section>

        {/* ── Final CTA ── */}
        <section className="w-full py-32 px-4 flex flex-col items-center text-center relative overflow-hidden">
          <Image src="/images/fire1.gif" alt="" fill className="object-cover opacity-[0.12] pointer-events-none" unoptimized />
          <div className="absolute inset-0 pointer-events-none">
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[400px] bg-primary/8 blur-[100px] rounded-full" />
          </div>
          <div className="relative z-10 max-w-3xl mx-auto">
            <h2 className="text-4xl md:text-6xl font-extrabold tracking-tight mb-6">
              Ready to publish<br />
              <span className="text-primary">on autopilot?</span>
            </h2>
            <p className="text-xl text-muted-foreground mb-10">
              Join creators who&apos;ve automated the grind and got back to making content.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              {user ? (
                <Link href="/dashboard">
                  <Button size="lg" className="h-12 px-10 font-semibold text-base">
                    Go to Dashboard <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                </Link>
              ) : (
                <>
                  <Link href={"/sign-up" as Route}>
                    <Button size="lg" className="h-12 px-10 font-semibold text-base">
                      Get Started for Free <ArrowRight className="ml-2 h-4 w-4" />
                    </Button>
                  </Link>
                  <Link href="#features">
                    <Button size="lg" variant="outline" className="h-12 px-10 text-base">
                      Explore Features
                    </Button>
                  </Link>
                </>
              )}
            </div>
          </div>
        </section>
      </main>

      {/* ── Footer ── */}
      <footer className="border-t bg-muted/20 py-12 md:py-16 px-4 md:px-6">
        <div className="max-w-6xl mx-auto">
          <div className="grid md:grid-cols-4 gap-10 mb-10">
            <div className="md:col-span-1">
              <Link href="/" className="flex items-center gap-2 font-bold text-base mb-3">
                <Image src="/icons/logo.png" alt="ReelCast" width={22} height={22} />
                ReelCast
              </Link>
              <p className="text-sm text-muted-foreground leading-relaxed">
                The AI publishing platform built for YouTube creators who ship consistently.
              </p>
            </div>
            <div>
              <p className="text-sm font-semibold mb-4">Product</p>
              <ul className="space-y-2.5">
                <li><Link href="#features" className="text-sm text-muted-foreground hover:text-foreground transition-colors">Features</Link></li>
                <li><Link href="#how-it-works" className="text-sm text-muted-foreground hover:text-foreground transition-colors">How it Works</Link></li>
                <li><Link href="#pricing" className="text-sm text-muted-foreground hover:text-foreground transition-colors">Pricing</Link></li>
              </ul>
            </div>
            <div>
              <p className="text-sm font-semibold mb-4">Account</p>
              <ul className="space-y-2.5">
                {[
                  { label: "Sign In", href: "/sign-in" as Route },
                  { label: "Sign Up", href: "/sign-up" as Route },
                  { label: "Dashboard", href: "/dashboard" as Route },
                ].map(({ label, href }) => (
                  <li key={label}>
                    <Link href={href} className="text-sm text-muted-foreground hover:text-foreground transition-colors">{label}</Link>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="text-sm font-semibold mb-4">Legal</p>
              <ul className="space-y-2.5">
                {[
                  { label: "Terms of Service", href: "/terms" as Route },
                  { label: "Privacy Policy", href: "/privacy" as Route },
                  { label: "Contact", href: "/contact" as Route },
                ].map(({ label, href }) => (
                  <li key={label}>
                    <Link href={href} className="text-sm text-muted-foreground hover:text-foreground transition-colors">{label}</Link>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <div className="border-t pt-8 flex flex-col md:flex-row items-center justify-between gap-4">
            <p className="text-sm text-muted-foreground">
              &copy; {new Date().getFullYear()} ReelCast Inc. All rights reserved.
            </p>
            <p className="text-sm text-muted-foreground flex items-center gap-1.5">
              Built for creators
              <Heart className="h-3.5 w-3.5 text-primary fill-primary" />
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
