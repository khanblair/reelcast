"use client";

import Image from "next/image";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { initialsFor } from "@/lib/user-display";

/**
 * A user's picture, or their initials when they have none (or the picture fails to load). One component for the top
 * bar, the profile page and the edit dialog so a change of picture shows up everywhere the same way.
 */
export function UserAvatar({
  name,
  email,
  imageUrl,
  size = 40,
  className,
}: {
  name?: string | null;
  email?: string | null;
  imageUrl?: string | null;
  size?: number;
  className?: string;
}) {
  // Remember WHICH url failed, so a new picture gets a fresh chance.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  if (imageUrl && failedUrl !== imageUrl) {
    return (
      <Image
        src={imageUrl}
        alt={name?.trim() || "Profile picture"}
        width={size}
        height={size}
        onError={() => setFailedUrl(imageUrl)}
        className={cn("shrink-0 rounded-full object-cover", className)}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <div
      role="img"
      aria-label={name?.trim() || email || "Profile picture"}
      className={cn("flex shrink-0 items-center justify-center rounded-full bg-primary/10 font-semibold text-primary", className)}
      style={{ width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.36)) }}
    >
      {initialsFor(name, email)}
    </div>
  );
}
