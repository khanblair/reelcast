/**
 * Crop maths for the profile-picture editor. The picture sits inside a square frame (`view` px wide, shown through a
 * circular mask). `zoom` 1 is the smallest size that still covers the frame; `x`/`y` move the picture's centre away
 * from the frame's centre, in frame pixels. Everything here is pure so it can be tested without a browser.
 */
export const CROP_VIEW_SIZE = 240;
export const CROP_OUTPUT_SIZE = 512;
export const CROP_MIN_ZOOM = 1;
export const CROP_MAX_ZOOM = 4;

export type Crop = { zoom: number; x: number; y: number };

/** The scale at which the picture just covers the frame. */
export const coverScale = (w: number, h: number, view: number) => Math.max(view / w, view / h);

/** The furthest the picture's centre may move before an edge of the picture would show inside the frame. */
export function maxOffset(w: number, h: number, view: number, zoom: number) {
  const s = coverScale(w, h, view) * zoom;
  return { x: Math.max(0, (w * s - view) / 2), y: Math.max(0, (h * s - view) / 2) };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Keep the zoom in range and the picture covering the frame. */
export function clampCrop(c: Crop, w: number, h: number, view: number): Crop {
  const zoom = clamp(c.zoom, CROP_MIN_ZOOM, CROP_MAX_ZOOM);
  const max = maxOffset(w, h, view, zoom);
  return { zoom, x: clamp(c.x, -max.x, max.x), y: clamp(c.y, -max.y, max.y) };
}

/** Change the zoom while the point at the centre of the frame stays at the centre. */
export function rezoom(c: Crop, nextZoom: number, w: number, h: number, view: number): Crop {
  const zoom = clamp(nextZoom, CROP_MIN_ZOOM, CROP_MAX_ZOOM);
  const ratio = zoom / c.zoom;
  return clampCrop({ zoom, x: c.x * ratio, y: c.y * ratio }, w, h, view);
}

/** The square region of the original picture (natural pixels) that the frame is showing. */
export function sourceRect(c: Crop, w: number, h: number, view: number) {
  const s = coverScale(w, h, view) * c.zoom;
  const size = view / s;
  return { sx: w / 2 - size / 2 - c.x / s, sy: h / 2 - size / 2 - c.y / s, size };
}
