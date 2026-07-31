import Link from "next/link";
import Image from "next/image";
import type { Route } from "next";
import { Button } from "@/components/ui/button";
import { Sparkles, Youtube, Clock } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { ThemeToggle } from "@/components/theme-toggle";

export default async function LandingPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  return (
    <div className="flex flex-col min-h-screen">
      {/* Header */}
      <header className="px-6 h-16 flex items-center border-b bg-background/80 backdrop-blur-md sticky top-0 z-50">
        <Link href="/" className="flex items-center gap-2 font-bold text-lg">
          <Image src="/icons/logo.png" alt="ReelCast" width={24} height={24} />
          <span>ReelCast</span>
        </Link>
        <nav className="ml-auto flex items-center gap-6">
          <Link href="#features" className="text-sm font-medium hover:text-primary transition-colors hidden sm:block">
            Features
          </Link>
          <Link href="#how-it-works" className="text-sm font-medium hover:text-primary transition-colors hidden sm:block">
            How it Works
          </Link>
          <ThemeToggle />
          {user ? (
            <Link href="/dashboard">
              <Button size="sm">Dashboard</Button>
            </Link>
          ) : (
            <Link href={"/sign-in" as Route}>
              <Button size="sm" variant="outline">Sign In</Button>
            </Link>
          )}
        </nav>
      </header>

      <main className="flex-1 flex flex-col items-center">
        {/* Hero Section */}
        <section className="w-full py-24 md:py-32 lg:py-40 flex flex-col items-center text-center px-4 bg-gradient-to-b from-background to-muted/20 relative overflow-hidden">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-primary/10 blur-[100px] rounded-full pointer-events-none" />
          
          <div className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 border-transparent bg-secondary text-secondary-foreground mb-6 z-10">
            <Sparkles className="mr-2 h-3 w-3 text-primary" />
            AI-Powered YouTube Publishing
          </div>
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight mb-6 max-w-4xl z-10">
            Upload raw footage.<br />
            <span className="text-primary bg-clip-text text-transparent bg-gradient-to-r from-primary to-primary/80">Let AI do the rest.</span>
          </h1>
          <p className="text-xl text-muted-foreground max-w-2xl mb-10 z-10">
            ReelCast analyzes your raw video, generates highly optimized titles, descriptions, and tags, 
            and schedules it directly to your YouTube channel.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 z-10">
            {user ? (
              <Link href="/dashboard">
                <Button size="lg" className="w-full sm:w-auto font-semibold h-12 px-8">
                  Go to Dashboard
                </Button>
              </Link>
            ) : (
              <>
                <Link href={"/sign-up" as Route}>
                  <Button size="lg" className="w-full sm:w-auto font-semibold h-12 px-8 relative overflow-hidden group">
                    <div className="absolute inset-0 bg-white/20 translate-y-full group-hover:translate-y-0 transition-transform" />
                    Get Started for Free
                  </Button>
                </Link>
            <Link href={"/sign-in" as Route}>
                  <Button size="lg" variant="outline" className="w-full sm:w-auto h-12 px-8">
                    Sign In
                  </Button>
                </Link>
              </>
            )}
          </div>
        </section>

        {/* Features Section */}
        <section id="features" className="w-full py-20 px-4 md:px-6 lg:px-8 max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl mb-4">Everything you need to grow</h2>
            <p className="text-lg text-muted-foreground">Automate the tedious parts of content creation.</p>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-8">
            <div className="flex flex-col items-center text-center p-6 bg-card rounded-2xl border shadow-sm">
              <div className="h-12 w-12 rounded-lg bg-primary/10 flex items-center justify-center mb-4">
                <Sparkles className="h-6 w-6 text-primary" />
              </div>
              <h3 className="font-bold text-xl mb-2">AI Metadata</h3>
              <p className="text-muted-foreground">Automatically generate click-worthy titles, SEO-optimized descriptions, and relevant tags.</p>
            </div>
            <div className="flex flex-col items-center text-center p-6 bg-card rounded-2xl border shadow-sm">
              <div className="h-12 w-12 rounded-lg bg-blue-500/10 flex items-center justify-center mb-4">
                <Youtube className="h-6 w-6 text-blue-500" />
              </div>
              <h3 className="font-bold text-xl mb-2">Direct Publishing</h3>
              <p className="text-muted-foreground">Connect your YouTube channel and publish directly from our platform with one click.</p>
            </div>
            <div className="flex flex-col items-center text-center p-6 bg-card rounded-2xl border shadow-sm">
              <div className="h-12 w-12 rounded-lg bg-green-500/10 flex items-center justify-center mb-4">
                <Clock className="h-6 w-6 text-green-500" />
              </div>
              <h3 className="font-bold text-xl mb-2">Smart Scheduling</h3>
              <p className="text-muted-foreground">Queue up your videos and let our system publish them at the optimal time for your audience.</p>
            </div>
          </div>
        </section>

        {/* How it Works */}
        <section id="how-it-works" className="w-full py-20 px-4 md:px-6 lg:px-8 bg-muted/30 border-y">
          <div className="max-w-4xl mx-auto text-center">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl mb-12">How ReelCast Works</h2>
            <div className="grid md:grid-cols-3 gap-8 relative">
              <div className="hidden md:block absolute top-12 left-[16%] right-[16%] h-0.5 bg-border -z-10" />
              
              <div className="flex flex-col items-center relative">
                <div className="w-16 h-16 rounded-full bg-background border-2 border-primary flex items-center justify-center text-xl font-bold mb-6">1</div>
                <h3 className="font-semibold text-lg mb-2">Upload Footage</h3>
                <p className="text-sm text-muted-foreground">Drop your raw video file into our secure cloud storage.</p>
              </div>
              
              <div className="flex flex-col items-center relative">
                <div className="w-16 h-16 rounded-full bg-background border-2 border-primary flex items-center justify-center text-xl font-bold mb-6">2</div>
                <h3 className="font-semibold text-lg mb-2">AI Processing</h3>
                <p className="text-sm text-muted-foreground">Our AI analyzes your video and generates perfect metadata.</p>
              </div>
              
              <div className="flex flex-col items-center relative">
                <div className="w-16 h-16 rounded-full bg-background border-2 border-primary flex items-center justify-center text-xl font-bold mb-6">3</div>
                <h3 className="font-semibold text-lg mb-2">Publish & Grow</h3>
                <p className="text-sm text-muted-foreground">Review the metadata and publish to YouTube instantly.</p>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t bg-background py-12 md:py-16">
        <div className="max-w-6xl mx-auto px-4 md:px-6 flex flex-col md:flex-row justify-between items-center gap-6">
          <div className="flex items-center gap-2 font-semibold">
            <Image src="/icons/logo.png" alt="ReelCast" width={20} height={20} />
            <span>ReelCast</span>
          </div>
          <p className="text-sm text-muted-foreground text-center md:text-left">
            &copy; {new Date().getFullYear()} ReelCast Inc. All rights reserved. Built with ❤️ for creators.
          </p>
          <div className="flex gap-4">
            <Link href="/terms" className="text-sm text-muted-foreground hover:text-foreground">Terms</Link>
            <Link href="/privacy" className="text-sm text-muted-foreground hover:text-foreground">Privacy</Link>
            <Link href="/contact" className="text-sm text-muted-foreground hover:text-foreground">Contact</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
