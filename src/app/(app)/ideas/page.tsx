"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { Id } from "../../../../convex/_generated/dataModel";
import { LoadingSpinner } from "@/components/shared/loading-spinner";
import { EmptyState } from "@/components/shared/empty-state";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Plus, Lightbulb, Trash2, Clock, Link2 } from "lucide-react";
import { formatDateTimeEAT } from "@/lib/eat";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type IdeaStatus = "concept" | "in_production" | "published";
type FilterTab = "all" | IdeaStatus;

const FILTER_TABS: { value: FilterTab; label: string }[] = [
  { value: "all", label: "All" },
  { value: "concept", label: "Concept" },
  { value: "in_production", label: "In Production" },
  { value: "published", label: "Published" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: IdeaStatus }) {
  if (status === "concept") {
    return <Badge variant="secondary">Concept</Badge>;
  }
  if (status === "in_production") {
    return (
      <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300 border-transparent">
        In Production
      </Badge>
    );
  }
  return (
    <Badge className="bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300 border-transparent">
      Published
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function IdeasPage() {
  const [filter, setFilter] = useState<FilterTab>("all");

  // New idea form state
  const [showForm, setShowForm] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newNotes, setNewNotes] = useState("");
  const [newTags, setNewTags] = useState("");
  const [saving, setSaving] = useState(false);

  const ideas = useQuery(
    api.ideas.list,
    filter === "all" ? {} : { status: filter as IdeaStatus }
  );

  const createIdea = useMutation(api.ideas.create);
  const updateIdea = useMutation(api.ideas.update);
  const removeIdea = useMutation(api.ideas.remove);

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  function openForm() {
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setNewTitle("");
    setNewNotes("");
    setNewTags("");
  }

  async function handleCreate() {
    if (!newTitle.trim()) return;
    setSaving(true);
    try {
      await createIdea({
        title: newTitle.trim(),
        notes: newNotes.trim() || undefined,
        tags: newTags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      });
      closeForm();
    } finally {
      setSaving(false);
    }
  }

  async function handleStatusChange(
    ideaId: Id<"ideas">,
    status: IdeaStatus
  ) {
    await updateIdea({ ideaId, status });
  }

  async function handleDelete(ideaId: Id<"ideas">) {
    if (!window.confirm("Delete this idea? This cannot be undone.")) return;
    await removeIdea({ ideaId });
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (ideas === undefined) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-2">
            Idea Vault
          </h1>
          <p className="text-muted-foreground">
            Capture and develop your video ideas.
          </p>
        </div>
        <Button onClick={openForm} disabled={showForm}>
          <Plus className="mr-2 h-4 w-4" />
          New Idea
        </Button>
      </div>

      {/* Inline new idea form */}
      {showForm && (
        <Card>
          <CardContent className="pt-6 pb-6 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="idea-title">
                Title <span className="text-destructive">*</span>
              </Label>
              <Input
                id="idea-title"
                placeholder="Your video idea..."
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) handleCreate();
                }}
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="idea-notes">Notes</Label>
              <Textarea
                id="idea-notes"
                placeholder="Details, angles, or research notes..."
                value={newNotes}
                onChange={(e) => setNewNotes(e.target.value)}
                rows={3}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="idea-tags">Tags (comma-separated)</Label>
              <Input
                id="idea-tags"
                placeholder="tutorial, review, vlog"
                value={newTags}
                onChange={(e) => setNewTags(e.target.value)}
              />
            </div>

            <div className="flex gap-2">
              <Button
                onClick={handleCreate}
                disabled={saving || !newTitle.trim()}
              >
                {saving && (
                  <span className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                )}
                Save Idea
              </Button>
              <Button variant="outline" onClick={closeForm} disabled={saving}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Filter tabs */}
      <div className="flex gap-2 flex-wrap">
        {FILTER_TABS.map((tab) => (
          <Button
            key={tab.value}
            size="sm"
            variant={filter === tab.value ? "default" : "outline"}
            onClick={() => setFilter(tab.value)}
          >
            {tab.label}
          </Button>
        ))}
      </div>

      {/* Ideas list */}
      {ideas.length === 0 ? (
        <EmptyState
          icon={Lightbulb}
          title="No ideas yet"
          description="Start capturing your video ideas."
        />
      ) : (
        <div className="space-y-4">
          {ideas.map((idea) => {
            const status = idea.status as IdeaStatus;
            return (
              <Card key={idea._id}>
                <CardContent className="pt-4 pb-4 space-y-3">
                  {/* Title + status badge */}
                  <div className="flex items-start gap-2">
                    <p className="font-semibold flex-1 min-w-0 leading-snug">
                      {idea.title}
                    </p>
                    <StatusBadge status={status} />
                  </div>

                  {/* Notes */}
                  {idea.notes && (
                    <p className="text-sm text-muted-foreground line-clamp-2">
                      {idea.notes}
                    </p>
                  )}

                  {/* Tags */}
                  {idea.tags && idea.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {idea.tags.map((tag, i) => (
                        <Badge key={i} variant="outline" className="text-xs">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  )}

                  {/* Scheduled generate at */}
                  {idea.scheduledGenerateAt && (
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Clock className="h-3.5 w-3.5 shrink-0" />
                      <span>{formatDateTimeEAT(idea.scheduledGenerateAt)}</span>
                    </div>
                  )}

                  {/* Actions row */}
                  <div className="flex items-center gap-2 flex-wrap pt-1 border-t">
                    {status !== "in_production" && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() =>
                          handleStatusChange(idea._id, "in_production")
                        }
                      >
                        Mark In Production
                      </Button>
                    )}
                    {status !== "published" && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() =>
                          handleStatusChange(idea._id, "published")
                        }
                      >
                        Mark Published
                      </Button>
                    )}
                    {status !== "concept" && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() =>
                          handleStatusChange(idea._id, "concept")
                        }
                      >
                        Back to Concept
                      </Button>
                    )}
                    {status === "in_production" && !idea.linkedVideoId && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() => alert("Not yet implemented")}
                      >
                        <Link2 className="mr-1 h-3 w-3" />
                        Link to Video
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="destructive"
                      className="h-7 w-7 p-0 ml-auto"
                      onClick={() => handleDelete(idea._id)}
                      title="Delete idea"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
