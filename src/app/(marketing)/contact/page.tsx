import Link from "next/link";
import { Video, Mail, MessageSquare, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ContactForm } from "./contact-form";

export const metadata = {
  title: "Contact — ReelCast",
  description: "Get in touch with the ReelCast team. We'd love to hear from you.",
};

export default function ContactPage() {
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

      <main className="flex-1 flex flex-col items-center py-16 md:py-24 px-4">
        <div className="max-w-2xl w-full space-y-8">
          <div className="text-center space-y-3">
            <h1 className="text-4xl md:text-5xl font-bold tracking-tight">Contact Us</h1>
            <p className="text-lg text-muted-foreground">
              Have a question, feedback, or need help? We are here for you.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            <Card>
              <CardContent className="p-6 flex flex-col items-center text-center space-y-3">
                <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
                  <Mail className="h-6 w-6 text-primary" />
                </div>
                <h3 className="font-semibold">Email</h3>
                <p className="text-sm text-muted-foreground">
                  <a href="mailto:support@reelcast.app" className="text-primary hover:underline">
                    support@reelcast.app
                  </a>
                </p>
                <p className="text-xs text-muted-foreground">We usually reply within 24 hours.</p>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-6 flex flex-col items-center text-center space-y-3">
                <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
                  <MessageSquare className="h-6 w-6 text-primary" />
                </div>
                <h3 className="font-semibold">Community</h3>
                <p className="text-sm text-muted-foreground">
                  Join our Discord community for quick help and feature discussions.
                </p>
                <p className="text-xs text-muted-foreground">
                  <span className="text-muted-foreground">Coming soon</span>
                </p>
              </CardContent>
            </Card>
          </div>

          <ContactForm />
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
