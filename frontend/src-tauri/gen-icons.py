#!/usr/bin/env python3
"""Generate the Tauri icon set for the Vignan Lockdown Browser.

`tauri build` refuses to bundle installers unless every path listed under
`bundle.icon` in tauri.conf.json exists. This script renders them all from one
vector-ish description so the brand stays consistent, and so a fresh clone can
produce installers with no design assets checked in.

    python3 src-tauri/gen-icons.py

Requires Pillow (`pip install pillow --break-system-packages`).
Outputs into src-tauri/icons/: 32x32.png, 128x128.png, 128x128@2x.png,
icon.png, icon.ico, icon.icns.
"""

import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons")
os.makedirs(OUT, exist_ok=True)

MAROON = (122, 30, 42, 255)   # brand maroon (student/exam surface)
PAPER = (247, 245, 240, 255)  # paper
INK = (26, 26, 26, 255)

MASTER = 1024


def render(size: int) -> Image.Image:
    """A maroon rounded square with a paper padlock shackle + keyhole."""
    s = MASTER
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Rounded-square app tile.
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=MAROON)

    # Padlock shackle (open arc drawn as a thick ring, bottom half masked off).
    cx, cy = s / 2, s * 0.40
    r = s * 0.155
    w = int(s * 0.062)
    d.arc([cx - r, cy - r, cx + r, cy + r], start=180, end=360, fill=PAPER, width=w)
    # Straight legs down to the body.
    for x in (cx - r, cx + r):
        d.rectangle([x - w / 2, cy, x + w / 2, s * 0.50], fill=PAPER)

    # Lock body.
    body = [s * 0.28, s * 0.47, s * 0.72, s * 0.80]
    d.rounded_rectangle(body, radius=int(s * 0.045), fill=PAPER)

    # Keyhole.
    kr = s * 0.045
    kx, ky = cx, s * 0.595
    d.ellipse([kx - kr, ky - kr, kx + kr, ky + kr], fill=MAROON)
    d.polygon(
        [(kx - kr * 0.55, ky), (kx + kr * 0.55, ky), (kx + kr * 0.30, s * 0.715), (kx - kr * 0.30, s * 0.715)],
        fill=MAROON,
    )

    # Ink baseline: subtle "exam paper" rule under the lock.
    d.rectangle([s * 0.34, s * 0.855, s * 0.66, s * 0.855 + max(2, s * 0.012)], fill=INK)

    return img.resize((size, size), Image.LANCZOS)


master = render(MASTER)

png_sizes = {
    "32x32.png": 32,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 512,
    "Square30x30Logo.png": 30,
    "Square44x44Logo.png": 44,
    "Square71x71Logo.png": 71,
    "Square89x89Logo.png": 89,
    "Square107x107Logo.png": 107,
    "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150,
    "Square284x284Logo.png": 284,
    "Square310x310Logo.png": 310,
    "StoreLogo.png": 50,
}
for name, size in png_sizes.items():
    render(size).save(os.path.join(OUT, name))

# Windows .ico — multi-resolution so the taskbar/installer look right.
master.resize((256, 256), Image.LANCZOS).save(
    os.path.join(OUT, "icon.ico"),
    format="ICO",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)

# macOS .icns
master.save(os.path.join(OUT, "icon.icns"), format="ICNS")

print(f"wrote {len(png_sizes) + 2} icon files to {OUT}")
