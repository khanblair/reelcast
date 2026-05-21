export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen bg-background">
      {/* Sidebar will be built in Phase 3 */}
      <aside className="hidden md:flex w-60 flex-col border-r border-border bg-sidebar">
        <div className="flex items-center gap-2 px-4 py-5 border-b border-sidebar-border">
          <span className="text-xl font-bold text-primary">ReelCast</span>
        </div>
        <nav className="flex-1 px-2 py-4">
          {/* Navigation items will go here */}
        </nav>
      </aside>
      <div className="flex-1 flex flex-col min-w-0">
        {/* Topbar will be built in Phase 3 */}
        <header className="flex items-center justify-between px-6 py-3 border-b border-border">
          <div />
          <div />
        </header>
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
