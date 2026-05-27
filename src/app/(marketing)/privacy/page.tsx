import Link from "next/link";
import { Video, ArrowLeft, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";

export const metadata = {
  title: "Privacy Policy — ReelCast",
  description: "Learn how ReelCast collects, uses, and protects your personal information.",
};

export default function PrivacyPage() {
  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="px-6 h-16 flex items-center border-b bg-background/80 backdrop-blur-md sticky top-0 z-50">
        <Link href="/" className="flex items-center gap-2 font-bold text-lg">
          <Video className="h-6 w-6 text-primary" />
          <span>ReelCast</span>
        </Link>
        <nav className="ml-auto">
          <Link href="/">
            <Button variant="ghost" size="sm" className="gap-2">
              <ArrowLeft className="w-4 h-4" />
              Back to Home
            </Button>
          </Link>
        </nav>
      </header>

      <main className="flex-1 py-16 md:py-24 px-4">
        <div className="max-w-3xl mx-auto space-y-10">
          <div className="text-center space-y-3">
            <div className="inline-flex items-center justify-center h-12 w-12 rounded-full bg-primary/10 mb-2">
              <Shield className="h-6 w-6 text-primary" />
            </div>
            <h1 className="text-4xl md:text-5xl font-bold tracking-tight">Privacy Policy</h1>
            <p className="text-muted-foreground">Last updated: {new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</p>
          </div>

          <div className="prose prose-neutral dark:prose-invert max-w-none">
            <section className="space-y-3">
              <h2 className="text-2xl font-semibold">1. Introduction</h2>
              <p className="text-muted-foreground leading-relaxed">
                ReelCast Inc. (&quot;we&quot;, &quot;our&quot;, or &quot;us&quot;) respects your privacy and is committed to protecting your personal data. This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you use our ReelCast platform and services.
              </p>
            </section>

            <section className="space-y-3 pt-6">
              <h2 className="text-2xl font-semibold">2. Information We Collect</h2>
              <p className="text-muted-foreground leading-relaxed">
                We collect information that you provide directly to us, including:
              </p>
              <ul className="list-disc list-inside text-muted-foreground space-y-1 ml-4">
                <li>Account information (name, email address) via Clerk authentication</li>
                <li>YouTube channel connection data (access tokens, channel names)</li>
                <li>Video files and metadata you upload for processing</li>
                <li>AI-generated content preferences and settings</li>
                <li>Telegram chat IDs (if you opt in to notifications)</li>
              </ul>
            </section>

            <section className="space-y-3 pt-6">
              <h2 className="text-2xl font-semibold">3. How We Use Your Information</h2>
              <p className="text-muted-foreground leading-relaxed">
                We use the information we collect to:
              </p>
              <ul className="list-disc list-inside text-muted-foreground space-y-1 ml-4">
                <li>Provide, maintain, and improve our services</li>
                <li>Process and publish your videos to YouTube</li>
                <li>Generate AI-powered titles, descriptions, and tags</li>
                <li>Send you notifications about job status</li>
                <li>Respond to your comments and questions</li>
                <li>Monitor and analyze trends and usage</li>
              </ul>
            </section>

            <section className="space-y-3 pt-6">
              <h2 className="text-2xl font-semibold">4. Data Storage and Security</h2>
              <p className="text-muted-foreground leading-relaxed">
                Your data is stored securely using Convex&apos;s infrastructure and Cloudinary for video storage. We implement industry-standard security measures including encryption in transit and at rest. YouTube access tokens are stored securely and refreshed automatically.
              </p>
            </section>

            <section className="space-y-3 pt-6">
              <h2 className="text-2xl font-semibold">5. Third-Party Services</h2>
              <p className="text-muted-foreground leading-relaxed">
                We use third-party services to operate ReelCast, including:
              </p>
              <ul className="list-disc list-inside text-muted-foreground space-y-1 ml-4">
                <li><strong>Clerk</strong> — Authentication and user management</li>
                <li><strong>Google / YouTube</strong> — Video publishing and channel data</li>
                <li><strong>Convex</strong> — Database and backend infrastructure</li>
                <li><strong>Cloudinary</strong> — Video and image storage</li>
              </ul>
            </section>

            <section className="space-y-3 pt-6">
              <h2 className="text-2xl font-semibold">6. Your Rights</h2>
              <p className="text-muted-foreground leading-relaxed">
                You have the right to access, update, or delete your personal information. You can disconnect your YouTube account and delete your videos at any time from the Settings page. To request complete account deletion, contact us at support@reelcast.app.
              </p>
            </section>

            <section className="space-y-3 pt-6">
              <h2 className="text-2xl font-semibold">7. Contact Us</h2>
              <p className="text-muted-foreground leading-relaxed">
                If you have any questions about this Privacy Policy, please contact us at{" "}
                <a href="mailto:support@reelcast.app" className="text-primary hover:underline">support@reelcast.app</a>.
              </p>
            </section>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t bg-background py-8">
        <div className="max-w-6xl mx-auto px-4 md:px-6 flex flex-col sm:flex-row justify-between items-center gap-4 text-sm text-muted-foreground">
          <p>&copy; {new Date().getFullYear()} ReelCast Inc. All rights reserved.</p>
          <div className="flex gap-4">
            <Link href="/terms" className="hover:text-foreground">Terms</Link>
            <Link href="/privacy" className="hover:text-foreground">Privacy</Link>
            <Link href="/contact" className="hover:text-foreground">Contact</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
