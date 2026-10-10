"use client";

import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { ImagePlus, Lock, Trash2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { UserAvatar } from "@/components/shared/user-avatar";
import { AvatarCropper, type AvatarCropperHandle } from "@/components/profile/avatar-cropper";
import { NAME_MAX_LENGTH, nameProblem, normalizeName } from "@/lib/profile-name";
import { api, useAction } from "@/lib/rpc/client";
import { uploadAvatar } from "@/lib/upload-avatar";

type ProfileUser = { name?: string | null; email: string; imageUrl?: string | null };

/** What the user has done to their picture so far in this dialog. Nothing is saved until they press Save. */
type PhotoChange = { kind: "keep" } | { kind: "remove" } | { kind: "new"; file: File; key: number };

const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_SOURCE_BYTES = 15 * 1024 * 1024;

/** Edit the signed-in user's name and picture. The email is shown but cannot be changed. */
export function EditProfileDialog({ open, onOpenChange, user }: { open: boolean; onOpenChange: (open: boolean) => void; user: ProfileUser }) {
  // While a save is running the dialog cannot be dismissed (it would hide the result of the save).
  const busy = useRef(false);
  const requestOpenChange = (next: boolean) => {
    if (!next && busy.current) return;
    onOpenChange(next);
  };
  const setBusy = (value: boolean) => {
    busy.current = value;
  };

  return (
    <Dialog open={open} onOpenChange={requestOpenChange}>
      <DialogContent className="mx-4 max-h-[90dvh] max-w-md overflow-y-auto">
        <EditProfileForm user={user} onBusyChange={setBusy} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

// The form is a child of the Dialog, which renders nothing while closed: its state starts fresh on every open.
function EditProfileForm({ user, onBusyChange, onClose }: { user: ProfileUser; onBusyChange: (busy: boolean) => void; onClose: () => void }) {
  const updateProfile = useAction(api.users.updateProfile);
  const [name, setName] = useState(user.name ?? "");
  const [photo, setPhoto] = useState<PhotoChange>({ kind: "keep" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cropper = useRef<AvatarCropperHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const fileCounter = useRef(0);

  const normalized = normalizeName(name);
  const nameChanged = normalized !== (user.name ?? "");
  const nameError = nameChanged ? nameProblem(normalized) : null;
  const dirty = nameChanged || photo.kind !== "keep";
  const canSave = dirty && !nameError && !saving;
  const hasPhoto = !!user.imageUrl;

  function onPickFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // picking the same file again must still fire a change
    if (!file) return;
    if (!ACCEPTED_TYPES.includes(file.type)) return setError("Use a JPG, PNG or WebP picture.");
    if (file.size > MAX_SOURCE_BYTES) return setError("That picture is too large (15 MB maximum).");
    setError(null);
    setPhoto({ kind: "new", file, key: ++fileCounter.current });
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    onBusyChange(true);
    setSaving(true);
    setError(null);
    try {
      const patch: { name?: string; imageUrl?: string | null } = {};
      if (nameChanged) patch.name = normalized;
      if (photo.kind === "remove") patch.imageUrl = null;
      if (photo.kind === "new") {
        const blob = await cropper.current?.exportBlob();
        if (!blob) throw new Error("The picture is not ready yet. Try again in a moment.");
        patch.imageUrl = await uploadAvatar(blob);
      }
      await updateProfile(patch);
      onBusyChange(false);
      onClose();
    } catch (err) {
      onBusyChange(false);
      setSaving(false);
      setError(err instanceof Error && err.message ? err.message : "Something went wrong. Please try again.");
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <DialogHeader>
        <DialogTitle>Edit profile</DialogTitle>
        <DialogDescription>Change how your name and picture appear in ReelCast.</DialogDescription>
      </DialogHeader>

      <input ref={fileInput} type="file" accept={ACCEPTED_TYPES.join(",")} className="sr-only" tabIndex={-1} aria-hidden="true" onChange={onPickFile} />

      {/* Picture */}
      <div className="flex flex-col items-center gap-3">
        {photo.kind === "new" ? (
          <AvatarCropper
            key={photo.key}
            ref={cropper}
            file={photo.file}
            disabled={saving}
            onLoadError={(message) => {
              setError(message);
              setPhoto({ kind: "keep" });
            }}
          />
        ) : (
          <UserAvatar
            name={name || user.name}
            email={user.email}
            imageUrl={photo.kind === "remove" ? null : user.imageUrl}
            size={96}
            className="ring-4 ring-border"
          />
        )}

        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button type="button" variant="outline" size="sm" disabled={saving} onClick={() => fileInput.current?.click()}>
            <ImagePlus className="size-4" aria-hidden="true" />
            {photo.kind === "new" ? "Choose another" : hasPhoto || photo.kind === "remove" ? "Change photo" : "Upload photo"}
          </Button>
          {photo.kind === "new" && (
            <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => setPhoto({ kind: "keep" })}>
              <Undo2 className="size-4" aria-hidden="true" />
              Discard
            </Button>
          )}
          {photo.kind === "keep" && hasPhoto && (
            <Button type="button" variant="ghost" size="sm" disabled={saving} className="text-destructive hover:text-destructive" onClick={() => setPhoto({ kind: "remove" })}>
              <Trash2 className="size-4" aria-hidden="true" />
              Remove photo
            </Button>
          )}
          {photo.kind === "remove" && (
            <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => setPhoto({ kind: "keep" })}>
              <Undo2 className="size-4" aria-hidden="true" />
              Keep current photo
            </Button>
          )}
        </div>
        {photo.kind !== "new" && <p className="text-xs text-muted-foreground">JPG, PNG or WebP. You can crop it after choosing.</p>}
      </div>

      {/* Fields */}
      <div className="mt-6 space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="profile-name">Name</Label>
          <Input
            id="profile-name"
            data-autofocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            disabled={saving}
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? "profile-name-error" : "profile-name-count"}
          />
          <div className="flex items-start justify-between gap-3 text-xs">
            {nameError ? (
              <p id="profile-name-error" className="text-destructive">
                {nameError}
              </p>
            ) : (
              <span />
            )}
            <span id="profile-name-count" className="ml-auto tabular-nums text-muted-foreground">
              {[...normalized].length}/{NAME_MAX_LENGTH}
            </span>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="profile-email" className="flex items-center gap-1.5">
            Email
            <Lock className="size-3 text-muted-foreground" aria-hidden="true" />
          </Label>
          <Input id="profile-email" value={user.email} readOnly disabled aria-describedby="profile-email-help" />
          <p id="profile-email-help" className="text-xs text-muted-foreground">
            This is how you sign in, so it cannot be changed here.
          </p>
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-4 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSave}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </DialogFooter>
    </form>
  );
}
