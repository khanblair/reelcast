"use client";

import { useState, type KeyboardEvent } from "react";
import { Check, Lock, Sparkles, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, useMutation } from "@/lib/rpc/client";
import type { Video as VideoType } from "@/types/video";

// YouTube limits (mirrored on the server, which is the one that enforces them).
const TITLE_MAX = 100;
const DESCRIPTION_MAX_BYTES = 5000;
const TAGS_MAX_CHARS = 500;

const byteLength = (s: string) => new TextEncoder().encode(s).length;
const tagChars = (tags: string[]) => tags.reduce((n, t) => n + t.length + (/\s/.test(t) ? 2 : 0), 0) + Math.max(tags.length - 1, 0);
const sameTags = (a: string[], b: string[]) => a.length === b.length && a.every((t, i) => t === b[i]);

/**
 * Title, description and tags for a video. Shows the AI-written values (or the plain ones) and lets
 * the user edit them by hand. Edits are saved with `videos.updateMetadata`; the values they replace
 * go into the metadata history. The parent remounts this component (via `key`) whenever the saved
 * values change on the server, so local state always starts from what is stored.
 */
export function MetadataEditor({ video }: { video: VideoType }) {
  const update = useMutation(api.videos.updateMetadata);

  const saved = {
    title: video.aiTitle || video.title,
    description: video.aiDescription ?? video.description ?? "",
    tags: video.aiTags ?? video.tags ?? [],
  };
  const [title, setTitle] = useState(saved.title);
  const [description, setDescription] = useState(saved.description);
  const [tags, setTags] = useState<string[]>(saved.tags);
  const [tagDraft, setTagDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const locked = video.status === "publishing" || video.status === "published";
  const dirty = title !== saved.title || description !== saved.description || !sameTags(tags, saved.tags);
  const descBytes = byteLength(description);
  const tagTotal = tagChars(tags);
  const invalid =
    title.trim().length === 0 ||
    title.length > TITLE_MAX ||
    descBytes > DESCRIPTION_MAX_BYTES ||
    tagTotal > TAGS_MAX_CHARS ||
    /[<>]/.test(title + description);

  function addTags(raw: string) {
    const incoming = raw.split(",").map((t) => t.trim().replace(/\s+/g, " ")).filter(Boolean);
    if (incoming.length === 0) return;
    setTags((current) => {
      const seen = new Set(current.map((t) => t.toLowerCase()));
      const next = [...current];
      for (const t of incoming) {
        if (!seen.has(t.toLowerCase())) {
          seen.add(t.toLowerCase());
          next.push(t);
        }
      }
      return next;
    });
    setJustSaved(false);
  }

  function onTagKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTags(tagDraft);
      setTagDraft("");
    } else if (e.key === "Backspace" && tagDraft === "" && tags.length > 0) {
      setTags((current) => current.slice(0, -1));
    }
  }

  async function save() {
    // Include a tag that was typed but not confirmed with Enter/comma yet.
    const pending = tagDraft.trim();
    const finalTags = pending ? [...tags, ...pending.split(",").map((t) => t.trim()).filter(Boolean)] : tags;
    setSaving(true);
    setError(null);
    try {
      await update({ id: video._id, title: title.trim(), description, tags: finalTags });
      setTagDraft("");
      setJustSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Invalid arguments: \S+ /, "") : "Couldn't save your changes.");
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    setTitle(saved.title);
    setDescription(saved.description);
    setTags(saved.tags);
    setTagDraft("");
    setError(null);
    setJustSaved(false);
  }

  const touch = () => setJustSaved(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Video Details</CardTitle>
        <CardDescription>
          {locked
            ? "This video is already publishing or published, so its details can't be changed here."
            : "Review and edit the details that will be sent to YouTube."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor={`title-${video._id}`} className="flex items-center gap-2">
              Title
              {video.aiTitle && <Sparkles className="h-3 w-3 text-primary" aria-label="AI generated" />}
            </Label>
            <span className={`text-xs tabular-nums ${title.length > TITLE_MAX ? "text-destructive" : "text-muted-foreground"}`}>
              {title.length}/{TITLE_MAX}
            </span>
          </div>
          <Input
            id={`title-${video._id}`}
            value={title}
            disabled={locked || saving}
            onChange={(e) => {
              setTitle(e.target.value);
              touch();
            }}
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor={`desc-${video._id}`} className="flex items-center gap-2">
              Description
              {video.aiDescription && <Sparkles className="h-3 w-3 text-primary" aria-label="AI generated" />}
            </Label>
            <span className={`text-xs tabular-nums ${descBytes > DESCRIPTION_MAX_BYTES ? "text-destructive" : "text-muted-foreground"}`}>
              {descBytes.toLocaleString()}/{DESCRIPTION_MAX_BYTES.toLocaleString()}
            </span>
          </div>
          <Textarea
            id={`desc-${video._id}`}
            rows={6}
            value={description}
            placeholder="No description yet."
            disabled={locked || saving}
            onChange={(e) => {
              setDescription(e.target.value);
              touch();
            }}
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor={`tags-${video._id}`} className="flex items-center gap-2">
              Tags
              {video.aiTags && video.aiTags.length > 0 && <Sparkles className="h-3 w-3 text-primary" aria-label="AI generated" />}
            </Label>
            <span className={`text-xs tabular-nums ${tagTotal > TAGS_MAX_CHARS ? "text-destructive" : "text-muted-foreground"}`}>
              {tagTotal}/{TAGS_MAX_CHARS}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2 p-2 border rounded-md min-h-[42px]">
            {tags.map((tag) => (
              <Badge key={tag} variant="secondary" className="gap-1 pr-1">
                {tag}
                {!locked && (
                  <button
                    type="button"
                    aria-label={`Remove tag ${tag}`}
                    className="rounded-full p-0.5 hover:bg-muted-foreground/20"
                    disabled={saving}
                    onClick={() => {
                      setTags((current) => current.filter((t) => t !== tag));
                      touch();
                    }}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </Badge>
            ))}
            {!locked && (
              <input
                id={`tags-${video._id}`}
                value={tagDraft}
                disabled={saving}
                placeholder={tags.length === 0 ? "Add tags, press Enter or comma" : "Add tag"}
                className="flex-1 min-w-[8rem] bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                onChange={(e) => {
                  setTagDraft(e.target.value);
                  touch();
                }}
                onKeyDown={onTagKey}
                onBlur={() => {
                  if (tagDraft.trim()) {
                    addTags(tagDraft);
                    setTagDraft("");
                  }
                }}
              />
            )}
            {locked && tags.length === 0 && <span className="text-sm text-muted-foreground">No tags</span>}
          </div>
        </div>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        {locked ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Lock className="h-3 w-3" /> Locked
          </p>
        ) : (
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" onClick={save} disabled={!dirty || invalid || saving}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={reset} disabled={!dirty || saving}>
              Reset
            </Button>
            {justSaved && !dirty && (
              <span className="flex items-center gap-1 text-xs text-green-600" role="status">
                <Check className="h-3 w-3" /> Saved
              </span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
