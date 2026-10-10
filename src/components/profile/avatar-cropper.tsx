"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ZoomIn, ZoomOut } from "lucide-react";
import {
  CROP_MAX_ZOOM,
  CROP_MIN_ZOOM,
  CROP_OUTPUT_SIZE,
  CROP_VIEW_SIZE,
  clampCrop,
  coverScale,
  rezoom,
  sourceRect,
  type Crop,
} from "@/lib/avatar-crop";
import { cn } from "@/lib/utils";

export type AvatarCropperHandle = {
  /** The visible square, rendered at 512 x 512 as a JPEG. */
  exportBlob: () => Promise<Blob>;
};

const MIN_SIDE = 64;

/**
 * Pick the part of a photo that becomes the profile picture: drag to reposition, slider (or + / -) to zoom, arrow keys
 * to nudge. The frame is a circle because that is how the picture is shown. Mount it with `key={file}`: a new file is
 * a new cropper.
 */
export const AvatarCropper = forwardRef<AvatarCropperHandle, { file: File; disabled?: boolean; onLoadError: (message: string) => void }>(
  function AvatarCropper({ file, disabled, onLoadError }, ref) {
    const [image, setImage] = useState<HTMLImageElement | null>(null);
    const [src, setSrc] = useState<string | null>(null);
    const [crop, setCrop] = useState<Crop>({ zoom: 1, x: 0, y: 0 });
    const drag = useRef<{ pointerId: number; startX: number; startY: number; crop: Crop } | null>(null);
    const onLoadErrorRef = useRef(onLoadError);
    useEffect(() => {
      onLoadErrorRef.current = onLoadError;
    });

    useEffect(() => {
      let cancelled = false;
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        if (cancelled) return;
        if (img.naturalWidth < MIN_SIDE || img.naturalHeight < MIN_SIDE) {
          onLoadErrorRef.current(`That picture is too small. Use one at least ${MIN_SIDE} x ${MIN_SIDE} pixels.`);
          return;
        }
        setSrc(url);
        setImage(img);
      };
      img.onerror = () => {
        if (!cancelled) onLoadErrorRef.current("We could not read that picture. Use a JPG, PNG or WebP file.");
      };
      img.src = url;
      return () => {
        cancelled = true;
        URL.revokeObjectURL(url);
      };
    }, [file]);

    const view = CROP_VIEW_SIZE;
    const w = image?.naturalWidth ?? 1;
    const h = image?.naturalHeight ?? 1;
    const scale = coverScale(w, h, view) * crop.zoom;

    useImperativeHandle(
      ref,
      () => ({
        exportBlob: () =>
          new Promise<Blob>((resolve, reject) => {
            if (!image) return reject(new Error("The picture is still loading."));
            const { sx, sy, size } = sourceRect(crop, image.naturalWidth, image.naturalHeight, view);
            const canvas = document.createElement("canvas");
            canvas.width = canvas.height = CROP_OUTPUT_SIZE;
            const ctx = canvas.getContext("2d");
            if (!ctx) return reject(new Error("Your browser could not prepare the picture."));
            ctx.fillStyle = "#ffffff"; // transparent PNGs become white, not black, once saved as JPEG
            ctx.fillRect(0, 0, CROP_OUTPUT_SIZE, CROP_OUTPUT_SIZE);
            ctx.imageSmoothingQuality = "high";
            ctx.drawImage(image, sx, sy, size, size, 0, 0, CROP_OUTPUT_SIZE, CROP_OUTPUT_SIZE);
            canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Your browser could not prepare the picture."))), "image/jpeg", 0.9);
          }),
      }),
      [image, crop, view],
    );

    const inert = disabled || !image;

    return (
      <div className="flex flex-col items-center gap-3">
        <div
          role="group"
          aria-label="Profile picture crop. Drag to reposition, use plus and minus to zoom, arrow keys to nudge."
          tabIndex={inert ? -1 : 0}
          className={cn(
            "relative touch-none select-none overflow-hidden rounded-full bg-muted ring-4 ring-border outline-none focus-visible:ring-ring",
            inert ? "opacity-60" : "cursor-grab active:cursor-grabbing",
          )}
          style={{ width: view, height: view }}
          onPointerDown={(e) => {
            if (inert) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, crop };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d || d.pointerId !== e.pointerId) return;
            setCrop(clampCrop({ ...d.crop, x: d.crop.x + e.clientX - d.startX, y: d.crop.y + e.clientY - d.startY }, w, h, view));
          }}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
          onKeyDown={(e) => {
            if (inert) return;
            const step = e.shiftKey ? 40 : 10;
            let next: Crop;
            switch (e.key) {
              case "ArrowLeft": next = { ...crop, x: crop.x - step }; break;
              case "ArrowRight": next = { ...crop, x: crop.x + step }; break;
              case "ArrowUp": next = { ...crop, y: crop.y - step }; break;
              case "ArrowDown": next = { ...crop, y: crop.y + step }; break;
              case "+": case "=": next = rezoom(crop, crop.zoom + 0.1, w, h, view); break;
              case "-": case "_": next = rezoom(crop, crop.zoom - 0.1, w, h, view); break;
              default: return;
            }
            e.preventDefault();
            setCrop(clampCrop(next, w, h, view));
          }}
        >
          {image && src ? (
            // A plain <img>: this is a temporary blob: URL that next/image cannot optimise.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={src}
              alt=""
              draggable={false}
              className="pointer-events-none absolute max-w-none"
              style={{ width: w * scale, height: h * scale, left: view / 2 + crop.x - (w * scale) / 2, top: view / 2 + crop.y - (h * scale) / 2 }}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading…</div>
          )}
        </div>

        <div className="flex w-full max-w-[240px] items-center gap-2">
          <ZoomOut className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            type="range"
            min={CROP_MIN_ZOOM}
            max={CROP_MAX_ZOOM}
            step={0.01}
            value={crop.zoom}
            disabled={inert}
            aria-label="Zoom"
            onChange={(e) => setCrop((c) => rezoom(c, Number(e.target.value), w, h, view))}
            className="h-1.5 w-full accent-primary disabled:opacity-50"
          />
          <ZoomIn className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </div>
        <p className="text-xs text-muted-foreground">Drag to reposition. Use the slider to zoom.</p>
      </div>
    );
  },
);
