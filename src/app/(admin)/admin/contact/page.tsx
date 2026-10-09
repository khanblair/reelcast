"use client";

import { useState, useMemo } from "react";
import { Inbox, Mail, Trash2 } from "lucide-react";
import { api, useQuery, useMutation } from "@/lib/rpc/client";
import type { Id } from "@/lib/rpc/client";
import { AdminPage } from "@/components/admin/shell/admin-page";
import { SkeletonBar } from "@/components/admin/shell/admin-skeleton";
import { EmptyState } from "@/components/admin/billing/empty-state";
import { FilterChips } from "@/components/admin/billing/filters";
import { StatusDot } from "@/components/admin/billing/status-dot";
import { TableCard } from "@/components/admin/billing/table-parts";
import { FilterBar } from "@/components/admin/shared/filter-bar";
import { Button } from "@/components/ui/button";
import { formatDateTimeEAT } from "@/lib/eat";
import { cn } from "@/lib/utils";

type StatusFilter = "all" | "new" | "read";

const STATUS_OPTIONS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "new", label: "New" },
  { value: "read", label: "Read" },
];

type Submission = {
  _id: string;
  _creationTime: number;
  name: string;
  email: string;
  subject: string;
  message: string;
  status: "new" | "read";
};

export default function AdminContactPage() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [expanded, setExpanded] = useState<string | null>(null);

  const submissions = useQuery(api.admin.contact.listAll, { limit: 200 });
  const markRead = useMutation(api.admin.contact.markRead);
  const remove = useMutation(api.admin.contact.remove);

  const filtered = useMemo(() => {
    if (!submissions) return [];
    const list = submissions as Submission[];
    return statusFilter === "all" ? list : list.filter((s) => s.status === statusFilter);
  }, [submissions, statusFilter]);

  async function handleExpand(s: Submission) {
    setExpanded(expanded === s._id ? null : s._id);
    if (s.status === "new") {
      await markRead({ submissionId: s._id as Id });
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm("Delete this submission?")) return;
    await remove({ submissionId: id as Id });
  }

  return (
    <AdminPage
      title="Messages"
      description={
        submissions !== undefined
          ? `${filtered.length} of ${submissions.length} submissions from the marketing site contact form.`
          : "Messages sent via the marketing site contact form."
      }
      className="max-w-4xl"
    >
      <FilterBar onClear={statusFilter !== "all" ? () => setStatusFilter("all") : undefined}>
        <FilterChips
          label="Filter by message status"
          options={STATUS_OPTIONS}
          value={statusFilter}
          onChange={setStatusFilter}
        />
      </FilterBar>

      <TableCard>
        {submissions === undefined ? (
          <MessagesSkeleton />
        ) : filtered.length === 0 ? (
          statusFilter !== "all" ? (
            <EmptyState
              icon={Inbox}
              title={
                statusFilter === "new"
                  ? "No new messages"
                  : statusFilter === "read"
                    ? "No read messages"
                    : "No messages"
              }
              description="Nothing matches this filter."
              action={
                <Button variant="outline" size="sm" onClick={() => setStatusFilter("all")}>
                  Show all messages
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={Inbox}
              title="No messages yet"
              description="Messages sent through the contact form on the marketing site will be listed here."
            />
          )
        ) : (
          <ul className="divide-y divide-border">
            {filtered.map((s) => {
              const open = expanded === s._id;
              const panelId = `message-${s._id}`;
              return (
                <li key={s._id}>
                  <button
                    type="button"
                    onClick={() => handleExpand(s)}
                    aria-expanded={open}
                    aria-controls={panelId}
                    className="flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none"
                  >
                    <Mail aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-3">
                        <span
                          className={cn(
                            "truncate text-sm",
                            s.status === "new" ? "font-semibold" : "font-medium"
                          )}
                        >
                          {s.subject}
                        </span>
                        {s.status === "new" ? (
                          <StatusDot tone="pending" label="New" className="shrink-0 text-xs" />
                        ) : null}
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {s.name} · {s.email}
                      </p>
                    </div>
                    <span className="hidden shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground sm:block">
                      {formatDateTimeEAT(s._creationTime)}
                    </span>
                  </button>

                  {open ? (
                    <div id={panelId} className="space-y-3 px-4 pb-4 pl-11">
                      <p className="text-xs tabular-nums text-muted-foreground sm:hidden">
                        {formatDateTimeEAT(s._creationTime)}
                      </p>
                      <p className="whitespace-pre-wrap break-words border-l-2 border-border pl-3 text-sm text-muted-foreground">
                        {s.message}
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        <a
                          href={`mailto:${s.email}`}
                          className="inline-flex h-8 items-center justify-center gap-2 rounded-md border border-border px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
                        >
                          <Mail aria-hidden className="size-3.5" />
                          Reply via email
                        </a>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:bg-destructive/10"
                          onClick={() => handleDelete(s._id)}
                        >
                          <Trash2 aria-hidden className="size-3.5" />
                          Delete
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </TableCard>
    </AdminPage>
  );
}

/** Same row geometry as a collapsed message: icon, two text lines, date. */
function MessagesSkeleton() {
  return (
    <div role="status" aria-busy="true" className="divide-y divide-border">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex min-h-14 items-center gap-3 px-4 py-3">
          <SkeletonBar className="size-4 shrink-0" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <SkeletonBar className="h-4 w-1/2" />
            <SkeletonBar className="h-3 w-1/3" />
          </div>
          <SkeletonBar className="hidden h-3 w-28 shrink-0 sm:block" />
        </div>
      ))}
    </div>
  );
}
