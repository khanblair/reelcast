import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen bg-background">
      <Sidebar />
      {/* The left padding matches the fixed sidebar: 256px, or 56px when it is collapsed to the icon rail. */}
      <div className="flex-1 flex flex-col min-w-0 md:pl-64 md:app-rail:pl-14 transition-[padding-left] duration-200 ease-out motion-reduce:transition-none">
        <Topbar />
        <main className="flex-1 overflow-y-auto p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
