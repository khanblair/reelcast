export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center justify-between px-6 py-4 border-b border-border">
        <span className="text-xl font-bold text-primary">ReelCast</span>
        <nav className="flex items-center gap-4">
          <a href="/sign-in" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
            Sign In
          </a>
          <a
            href="/sign-up"
            className="text-sm bg-primary text-primary-foreground px-4 py-2 rounded-md hover:bg-primary/90 transition-colors"
          >
            Get Started
          </a>
        </nav>
      </header>
      <main>{children}</main>
    </div>
  );
}
