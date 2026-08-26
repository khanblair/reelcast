"use client";

import { useState, useMemo } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { AdminNav } from "@/components/admin/admin-nav";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTimeEAT } from "@/lib/eat";
import { Mail, Trash2, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Id } from "../../../../../convex/_generated/dataModel";

type StatusFilter = "all" | "new" | "read";

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
      await markRead({ submissionId: s._id as Id<"contactSubmissions"> });
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm("Delete this submission?")) return;
    await remove({ submissionId: id as Id<"contactSubmissions"> });
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <AdminNav />

      <div>
        <h1 className="text-2xl font-bold">Contact Submissions</h1>
        <p className="text-muted-foreground text-sm mt-1">
          {submissions !== undefined
            ? `${filtered.length} of ${submissions.length} submissions`
            : "Messages sent via the marketing site contact form."}
        </p>
      </div>

      <div className="flex items-center gap-1 border rounded-lg p-1 w-fit">
        {(["all", "new", "read"] as StatusFilter[]).map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={cn(
              "px-3 py-1 text-xs font-medium rounded-md capitalize transition-colors",
              statusFilter === s
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {s}
          </button>
        ))}
      </div>

      <Card>
        <CardContent className="p-0">
          {submissions === undefined ? (
            <div className="flex justify-center py-12">
              <LoadingSpinner />
            </div>
          ) : filtered.length === 0 ? (
            <p className="px-4 py-8 text-sm text-muted-foreground text-center">
              No submissions match the current filter.
            </p>
          ) : (
            <div className="divide-y">
              {filtered.map((s) => (
                <div key={s._id}>
                  <button
                    type="button"
                    onClick={() => handleExpand(s)}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/30 transition-colors"
                  >
                    <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm truncate">{s.subject}</span>
                        {s.status === "new" && (
                          <Badge className="bg-primary text-primary-foreground text-[10px] h-4 px-1.5">New</Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground truncate">
                        {s.name} · {s.email}
                      </p>
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0 whitespace-nowrap">
                      {formatDateTimeEAT(s._creationTime)}
                    </span>
                  </button>

                  {expanded === s._id && (
                    <div className="px-4 pb-4 pl-11 space-y-3">
                      <p className="text-sm whitespace-pre-wrap text-muted-foreground border-l-2 pl-3">
                        {s.message}
                      </p>
                      <div className="flex items-center gap-2">
                        <Button variant="outline" size="sm" onClick={() => window.open(`mailto:${s.email}`, "_blank")}>
                          <Check className="h-3.5 w-3.5 mr-1.5" />
                          Reply via email
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive hover:bg-destructive/10"
                          onClick={() => handleDelete(s._id)}
                        >
                          <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                          Delete
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
