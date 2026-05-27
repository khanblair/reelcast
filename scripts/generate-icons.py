import os
from PIL import Image, ImageDraw

# Brand color
BRAND_RED = (255, 3, 53)  # #ff0335
WHITE = (255, 255, 255)
BG = (15, 15, 15)  # For dark favicon bg if needed

SIZES = {
    "favicon-16x16.png": 16,
    "favicon-32x32.png": 32,
    "favicon-48x48.png": 48,
    "apple-touch-icon.png": 180,
    "icon-72x72.png": 72,
    "icon-96x96.png": 96,
    "icon-128x128.png": 128,
    "icon-144x144.png": 144,
    "icon-152x152.png": 152,
    "icon-192x192.png": 192,
    "icon-256x256.png": 256,
    "icon-384x384.png": 384,
    "icon-512x512.png": 512,
}

OUTPUT_DIR = "/Users/kolaborateplatforms/BLAIR/reelcast/public/icons"
os.makedirs(OUTPUT_DIR, exist_ok=True)


def draw_icon(size):
    """Draw the ReelCast icon at given size using PIL primitives."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Padding and corner radius proportional to size
    padding = max(1, size // 22)
    radius = size // 6
    box = (padding, padding, size - padding, size - padding)

    # Draw rounded rectangle background
    draw.rounded_rectangle(box, radius=radius, fill=BRAND_RED)

    # Play triangle
    margin = size // 4
    tri_left = size // 3
    tri_top = margin
    tri_bottom = size - margin
    tri_right = size - margin

    triangle = [
        (tri_left, tri_top),
        (tri_left, tri_bottom),
        (tri_right, (tri_top + tri_bottom) // 2),
    ]
    draw.polygon(triangle, fill=WHITE)

    # Radio wave arcs on the right (only if size >= 48)
    if size >= 48:
        arc_stroke = max(2, size // 24)
        # First arc (closer)
        cx = size - size // 6
        cy = size // 2
        r1 = size // 8
        # We draw partial ellipses as arcs; bounding box for arc
        bbox1 = (cx - r1, cy - r1, cx + r1, cy + r1)
        # PIL arc: draw.arc(bbox, start, end)
        # We'll simulate arcs by drawing thick lines using multiple small ellipses
        # Instead, let's draw two thick arc-like polygons using math
        import math

        def arc_points(cx, cy, r, start_angle, end_angle, segments=40):
            pts = []
            for i in range(segments + 1):
                a = math.radians(start_angle + (end_angle - start_angle) * i / segments)
                pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
            return pts

        def draw_thick_arc(draw, cx, cy, r, start, end, width, fill):
            pts_outer = arc_points(cx, cy, r + width / 2, start, end)
            pts_inner = arc_points(cx, cy, r - width / 2, end, start)
            draw.polygon(pts_outer + pts_inner, fill=fill)

        # Arc 1: smaller radius, covers roughly 210 to 330 degrees
        draw_thick_arc(draw, cx, cy - size // 40, size // 10, 210, 330, arc_stroke, WHITE)
        # Arc 2: larger radius
        draw_thick_arc(draw, cx + size // 40, cy - size // 40, size // 6, 220, 320, arc_stroke, WHITE)

    return img


# Generate all sizes
for filename, size in SIZES.items():
    icon = draw_icon(size)
    filepath = os.path.join(OUTPUT_DIR, filename)
    icon.save(filepath, "PNG")
    print(f"Generated {filepath} ({size}x{size})")

# Also generate a combined favicon.ico from 16,32,48 sizes
# Pillow doesn't support multi-size ICO easily, but we can just use PNG favicons
# For true .ico we can save the 32x32 as .ico format
ico_path = os.path.join(OUTPUT_DIR, "favicon.ico")
img_32 = draw_icon(32)
img_32.save(ico_path, format="ICO", sizes=[(32, 32)])
print(f"Generated {ico_path}")

print("Done!")
