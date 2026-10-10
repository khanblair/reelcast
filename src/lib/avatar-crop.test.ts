import { describe, expect, test } from "bun:test";
import { CROP_MAX_ZOOM, CROP_MIN_ZOOM, CROP_VIEW_SIZE, clampCrop, coverScale, maxOffset, rezoom, sourceRect } from "./avatar-crop";

const V = CROP_VIEW_SIZE; // 240
const centre = (r: { sx: number; sy: number; size: number }) => ({ x: r.sx + r.size / 2, y: r.sy + r.size / 2 });

describe("avatar crop maths", () => {
  test("a picture is scaled just enough to cover the frame", () => {
    expect(coverScale(400, 200, V)).toBeCloseTo(1.2); // limited by height
    expect(coverScale(200, 400, V)).toBeCloseTo(1.2); // limited by width
    expect(coverScale(240, 240, V)).toBe(1);
  });

  test("at zoom 1 a landscape picture shows its centre square, a square one shows everything", () => {
    expect(sourceRect({ zoom: 1, x: 0, y: 0 }, 400, 200, V)).toEqual({ sx: 100, sy: 0, size: 200 });
    expect(sourceRect({ zoom: 1, x: 0, y: 0 }, 300, 300, V)).toEqual({ sx: 0, sy: 0, size: 300 });
  });

  test("zooming in halves the visible region around the centre", () => {
    expect(sourceRect({ zoom: 2, x: 0, y: 0 }, 400, 200, V)).toEqual({ sx: 150, sy: 50, size: 100 });
  });

  test("dragging the picture right reveals more of its left side (and so on)", () => {
    const base = sourceRect({ zoom: 2, x: 0, y: 0 }, 400, 200, V);
    expect(sourceRect({ zoom: 2, x: 30, y: 0 }, 400, 200, V).sx).toBeLessThan(base.sx);
    expect(sourceRect({ zoom: 2, x: -30, y: 0 }, 400, 200, V).sx).toBeGreaterThan(base.sx);
    expect(sourceRect({ zoom: 2, x: 0, y: 30 }, 400, 200, V).sy).toBeLessThan(base.sy);
  });

  test("the picture can only move as far as keeps the frame covered", () => {
    expect(maxOffset(240, 240, V, 1)).toEqual({ x: 0, y: 0 });
    expect(maxOffset(400, 200, V, 1)).toEqual({ x: (400 * 1.2 - V) / 2, y: 0 });
    expect(clampCrop({ zoom: 1, x: 500, y: 500 }, 240, 240, V)).toEqual({ zoom: 1, x: 0, y: 0 });
    expect(clampCrop({ zoom: 9, x: 0, y: 0 }, 240, 240, V).zoom).toBe(CROP_MAX_ZOOM);
    expect(clampCrop({ zoom: 0.1, x: 0, y: 0 }, 240, 240, V).zoom).toBe(CROP_MIN_ZOOM);
  });

  test("whatever the crop, the source region stays inside the picture", () => {
    for (const [w, h] of [[400, 200], [200, 400], [1000, 1000], [4000, 3000], [64, 4000]]) {
      for (const zoom of [1, 1.5, 2.7, 4]) {
        for (const x of [-9999, -50, 0, 50, 9999]) {
          for (const y of [-9999, -50, 0, 50, 9999]) {
            const r = sourceRect(clampCrop({ zoom, x, y }, w, h, V), w, h, V);
            expect(r.sx).toBeGreaterThanOrEqual(-1e-6);
            expect(r.sy).toBeGreaterThanOrEqual(-1e-6);
            expect(r.sx + r.size).toBeLessThanOrEqual(w + 1e-6);
            expect(r.sy + r.size).toBeLessThanOrEqual(h + 1e-6);
          }
        }
      }
    }
  });

  test("changing the zoom keeps the same point in the middle of the frame", () => {
    const before = { zoom: 1.5, x: 40, y: -20 };
    const after = rezoom(before, 3, 800, 600, V);
    const a = centre(sourceRect(before, 800, 600, V));
    const b = centre(sourceRect(after, 800, 600, V));
    expect(b.x).toBeCloseTo(a.x, 5);
    expect(b.y).toBeCloseTo(a.y, 5);
    expect(rezoom(before, 99, 800, 600, V).zoom).toBe(CROP_MAX_ZOOM);
  });
});
