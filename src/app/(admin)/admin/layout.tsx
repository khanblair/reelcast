import type { Metadata, Route } from "next";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/server/auth";
import { RpcError } from "@/server/rpc/errors";
import { AdminShell } from "@/components/admin/shell/admin-shell";

export const metadata: Metadata = {
  title: { default: "Admin · ReelCast", template: "%s · Admin · ReelCast" },
};

/**
 * Server-side admin gate. Runs on the server for every document request and on the first
 * client navigation into /admin, BEFORE any admin UI is sent. (Layouts do not re-render between
 * sibling admin pages, so this is defence in depth: every admin RPC is independently `auth: "admin"`
 * and re-checks `users.is_admin` from the database on each call.)
 *
 * redirect() works by throwing, so it must be called outside the try/catch.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  let outcome: "ok" | "signed-out" | "not-admin" = "ok";
  try {
    await requireAdmin();
  } catch (e) {
    if (!(e instanceof RpcError)) throw e; // unexpected failure: render the error boundary, never the admin UI
    outcome = e.code === "UNAUTHENTICATED" ? "signed-out" : "not-admin";
  }
  if (outcome === "signed-out") redirect("/sign-in" as Route);
  if (outcome === "not-admin") redirect("/dashboard");

  return <AdminShell>{children}</AdminShell>;
}
