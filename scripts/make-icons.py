#!/usr/bin/env python3
"""Render the Bubble Plush app icons.

Run from the repo root:  python3 scripts/make-icons.py

Draws one 1024px master with numpy (smooth gradients, no assets) and exports:
  assets/icons/icon-192.png             any
  assets/icons/icon-512.png             any
  assets/icons/icon-maskable-512.png    maskable (orb inside the 80% safe zone)
  assets/icons/apple-touch-icon.png     180px, opaque for iOS
"""

from pathlib import Path

import numpy as np
from PIL import Image

SIZE = 1024
OUT = Path(__file__).resolve().parent.parent / "assets" / "icons"

# Soft Clash Pink
BG = np.array([255, 248, 249], dtype=float)
PEACH = np.array([255, 201, 168], dtype=float)
PINK = np.array([255, 140, 163], dtype=float)
ACCENT = np.array([255, 92, 138], dtype=float)
MINT = np.array([207, 237, 231], dtype=float)
WHITE = np.array([255, 255, 255], dtype=float)


def ramp(t, stops):
    """Piecewise-linear colour ramp. stops = [(pos, rgb), ...] sorted by pos."""
    out = np.zeros(t.shape + (3,))
    for (p0, c0), (p1, c1) in zip(stops, stops[1:]):
        span = np.clip((t - p0) / max(p1 - p0, 1e-6), 0, 1)
        blend = (c0[None, None, :] * (1 - span[..., None]) + c1[None, None, :] * span[..., None])
        out = np.where((t >= p0)[..., None] & (t <= p1)[..., None], blend, out)
    # clamp the ends
    out = np.where((t < stops[0][0])[..., None], stops[0][1], out)
    out = np.where((t > stops[-1][0])[..., None], stops[-1][1], out)
    return out


def build(orb_radius_ratio: float) -> Image.Image:
    ys, xs = np.mgrid[0:SIZE, 0:SIZE].astype(float) / SIZE
    cx, cy = 0.5, 0.52
    radius = orb_radius_ratio
    dist = np.hypot(xs - cx, ys - cy)

    # --- background: off-white with a warm glow from above ------------------
    canvas = np.tile(BG, (SIZE, SIZE, 1))
    glow = np.exp(-(((xs - 0.5) ** 2 + (ys + 0.18) ** 2) / (2 * 0.42**2)))[..., None]
    canvas = canvas * (1 - 0.20 * glow) + PEACH * (0.20 * glow)

    # --- halo behind the orb ------------------------------------------------
    halo = np.exp(-((np.clip(dist - radius, 0, None) / (radius * 0.55)) ** 2)) * (dist > radius * 0.92)
    canvas = canvas * (1 - 0.20 * halo[..., None]) + ACCENT * (0.20 * halo[..., None])

    # --- orb body: radial ramp from a top-left light source -----------------
    light_dist = np.hypot(xs - (cx - 0.10), ys - (cy - 0.13)) / (radius * 1.60)
    body = ramp(
        np.clip(light_dist, 0, 1),
        [
            (0.00, WHITE),
            (0.16, WHITE),
            (0.40, PEACH),
            (0.72, PINK),
            (1.00, ACCENT),
        ],
    )

    # iridescent sheen on the upper right
    sheen = np.exp(-(((xs - 0.72) ** 2 + (ys - 0.26) ** 2) / (2 * 0.17**2)))[..., None]
    body = body * (1 - 0.22 * sheen) + MINT * (0.22 * sheen)

    # specular highlight
    spec = np.exp(-(((xs - 0.41) ** 2 + (ys - 0.37) ** 2) / (2 * 0.062**2)))[..., None]
    body = body * (1 - 0.82 * spec) + WHITE * (0.82 * spec)

    # anti-aliased circular mask (1.5px feather)
    mask = np.clip((radius - dist) * SIZE / 1.5, 0, 1)[..., None]
    canvas = canvas * (1 - mask) + body * mask

    # thin white rim
    rim = np.clip((radius - dist) * SIZE / 1.5, 0, 1) * np.clip((dist - radius + 0.004) * SIZE / 1.5, 0, 1)
    canvas = canvas * (1 - 0.45 * rim[..., None]) + WHITE * (0.45 * rim[..., None])

    return Image.fromarray(np.clip(canvas, 0, 255).astype(np.uint8), "RGB")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    master = build(orb_radius_ratio=0.30)
    maskable = build(orb_radius_ratio=0.245)

    master.resize((512, 512), Image.LANCZOS).save(OUT / "icon-512.png", optimize=True)
    master.resize((192, 192), Image.LANCZOS).save(OUT / "icon-192.png", optimize=True)
    master.resize((180, 180), Image.LANCZOS).save(OUT / "apple-touch-icon.png", optimize=True)
    maskable.resize((512, 512), Image.LANCZOS).save(OUT / "icon-maskable-512.png", optimize=True)

    for path in sorted(OUT.glob("*.png")):
        print(f"{path.relative_to(OUT.parent.parent)}  {path.stat().st_size / 1024:.1f} KB")


if __name__ == "__main__":
    main()
