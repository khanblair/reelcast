import Link from "next/link";
import { Video, ArrowLeft, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";

export const metadata = {
  title: "Terms of Service — ReelCast",
  description: "Read the Terms of Service for using ReelCast.",
};

export default function TermsPage() {
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
              <FileText className="h-6 w-6 text-primary" />
            </div>
            <h1 className="text-4xl md:text-5xl font-bold tracking-tight">Terms of Service</h1>
            <p className="text-muted-foreground">Last updated: {new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</p>
          </div>

          <div className="prose prose-neutral dark:prose-invert max-w-none">
            <section className="space-y-3">
              <h2 className="text-2xl font-semibold">1. Acceptance of Terms</h2>
              <p className="text-muted-foreground leading-relaxed">
                By accessing or using ReelCast (&quot;the Service&quot;), you agree to be bound by these Terms of Service. If you do not agree to these terms, please do not use the Service.
              </p>
            </section>

            <section className="space-y-3 pt-6">
              <h2 className="text-2xl font-semibold">2. Description of Service</h2>
              <p className="text-muted-foreground leading-relaxed">
                ReelCast is an AI-powered video publishing platform that allows users to upload raw footage, generate metadata using artificial intelligence, and publish videos directly to YouTube. The Service includes web-based tools, APIs, and related features.
              </p>
            </section>

            <section className="space-y-3 pt-6">
              <h2 className="text-2xl font-semibold">3. User Accounts</h2>
              <p className="text-muted-foreground leading-relaxed">
                To use certain features of the Service, you must create an account using Clerk authentication. You are responsible for maintaining the confidentiality of your account credentials and for all activities that occur under your account. You agree to notify us immediately of any unauthorized use.
              </p>
            </section>

            <section className="space-y-3 pt-6">
              <h2 className="text-2xl font-semibold">4. YouTube Integration</h2>
              <p className="text-muted-foreground leading-relaxed">
                By connecting your YouTube account, you grant ReelCast permission to upload videos to your channel on your behalf. You retain full ownership of all content uploaded. ReelCast does not claim any ownership rights to your videos. You can disconnect your YouTube account at any time from the Settings page.
              </p>
            </section>

            <section className="space-y-3 pt-6">
              <h2 className="text-2xl font-semibold">5. Acceptable Use</h2>
              <p className="text-muted-foreground leading-relaxed">
                You agree not to use the Service to:
              </p>
              <ul className="list-disc list-inside text-muted-foreground space-y-1 ml-4">
                <li>Upload or distribute content that violates any law or regulation</li>
                <li>Infringe on the intellectual property rights of others</li>
                <li>Upload malware, viruses, or other harmful code</li>
                <li>Spam or harass other users</li>
                <li>Attempt to gain unauthorized access to the Service or its systems</li>
                <li>Use the Service in any way that could damage, disable, or impair it</li>
              </ul>
            </section>

            <section className="space-y-3 pt-6">
              <h2 className="text-2xl font-semibold">6. Content Ownership</h2>
              <p className="text-muted-foreground leading-relaxed">
                You retain all ownership rights to the videos and content you upload. By using the Service, you grant ReelCast a limited license to process, store, and transmit your content solely for the purpose of providing the Service to you. We do not sell or share your content with third parties.
              </p>
            </section>

            <section className="space-y-3 pt-6">
              <h2 className="text-2xl font-semibold">7. AI-Generated Content</h2>
              <p className="text-muted-foreground leading-relaxed">
                ReelCast uses artificial intelligence to generate titles, descriptions, tags, and other metadata. While we strive for accuracy and quality, you are responsible for reviewing and approving all AI-generated content before publishing. We make no guarantees about the performance or suitability of AI-generated content.
              </p>
            </section>

            <section className="space-y-3 pt-6">
              <h2 className="text-2xl font-semibold">8. Termination</h2>
              <p className="text-muted-foreground leading-relaxed">
                We reserve the right to suspend or terminate your access to the Service at any time, with or without notice, for any reason, including violation of these Terms. Upon termination, your right to use the Service will immediately cease.
              </p>
            </section>

            <section className="space-y-3 pt-6">
              <h2 className="text-2xl font-semibold">9. Limitation of Liability</h2>
              <p className="text-muted-foreground leading-relaxed">
                ReelCast is provided &quot;as is&quot; without warranties of any kind. We are not liable for any indirect, incidental, special, consequential, or punitive damages arising out of or relating to your use of the Service.
              </p>
            </section>

            <section className="space-y-3 pt-6">
              <h2 className="text-2xl font-semibold">10. Changes to Terms</h2>
              <p className="text-muted-foreground leading-relaxed">
                We may update these Terms from time to time. We will notify you of any material changes by posting the new Terms on this page. Your continued use of the Service after any changes constitutes acceptance of the updated Terms.
              </p>
            </section>

            <section className="space-y-3 pt-6">
              <h2 className="text-2xl font-semibold">11. Contact</h2>
              <p className="text-muted-foreground leading-relaxed">
                If you have any questions about these Terms, please contact us at{" "}
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
