#!/usr/bin/env python3
"""
Rise - Android widget animation frame generator.

Generates dot-matrix / Glyph style animation frames ("Nothing Phone" aesthetic)
for the Rise home-screen widgets, at every Android density.

Everything is drawn as circular dots on a regular 16 x 10 lattice over a
64 x 40 dp canvas. Emphasis comes from the palette colour and the dot radius,
never from alpha gradients, so the result stays hard-edged and graphic.

Each density is re-rendered from the same lattice math at 4x supersample and
downsampled with LANCZOS (no bitmap upscaling), so edges stay crisp.

Output:
  android/app/src/main/res/drawable-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/
      anim_<seq>_f<1..6>.png

Usage:
  python3 tools/gen_widget_anims.py            # write assets
  python3 tools/gen_widget_anims.py --verify   # write assets + verify
  python3 tools/gen_widget_anims.py --preview out.png   # also dump contact sheet
"""

from __future__ import annotations

import argparse
import math
import os
import re
import sys

from PIL import Image, ImageDraw

# ---------------------------------------------------------------------------
# Canvas / lattice geometry (all in "cell" units unless noted)
# ---------------------------------------------------------------------------

BASE_W, BASE_H = 64, 40          # mdpi canvas in px (== dp)
COLS, ROWS = 16, 10              # dot lattice
CELL = BASE_W / COLS             # 4.0 base px per cell (square: 40/10 == 4.0)
CX, CY = (COLS - 1) / 2.0, (ROWS - 1) / 2.0   # 7.5, 4.5 lattice centre

SUPERSAMPLE = 4
PIXEL_CENTRE = 0.5 * SUPERSAMPLE   # half an output pixel, in supersample units
FRAMES = 6

DENSITIES = {
    "mdpi": 1.0,
    "hdpi": 1.5,
    "xhdpi": 2.0,
    "xxhdpi": 3.0,
    "xxxhdpi": 4.0,
}

# ---------------------------------------------------------------------------
# Palette - these four colours only.
# ---------------------------------------------------------------------------

RED = (0xD7, 0x19, 0x21)
WHITE = (0xFF, 0xFF, 0xFF)
MID = (0x55, 0x55, 0x55)
DIM = (0x33, 0x33, 0x33)

# Paint order: dim first, brightest last, so bright dots win overlaps.
PAINT_ORDER = [DIM, MID, RED, WHITE]

# Dot radii as a fraction of one cell (cell == 4 base px, so 0.44 -> 1.76 px).
R_XL, R_L, R_M, R_S, R_XS = 0.44, 0.38, 0.30, 0.25, 0.19

CELLS = [(c, r) for r in range(ROWS) for c in range(COLS)]

# Shared shape constants (lattice coordinates).
CHECK = [(3.4, 4.8), (6.4, 7.6), (12.6, 1.2)]   # checkmark polyline
SUN_R = 2.8                                     # sun disc radius in cells

SEQUENCES = ("complete", "step", "glider", "silence", "sunset", "movement")

NAME_RE = re.compile(r"^anim_(complete|step|glider|silence|sunset|movement)_f[1-6]\.png$")


# ---------------------------------------------------------------------------
# Small geometry helpers
# ---------------------------------------------------------------------------

def dist(c, r, x=CX, y=CY):
    return math.hypot(c - x, r - y)


def on_spoke(c, r, spokes=8, tol_deg=13.0, min_d=0.9):
    """True if the cell sits near one of `spokes` rays out of the centre."""
    d = dist(c, r)
    if d < min_d:
        return False
    ang = math.degrees(math.atan2(r - CY, c - CX)) % (360.0 / spokes)
    return min(ang, 360.0 / spokes - ang) <= tol_deg


def seg_dist_t(px, py, ax, ay, bx, by):
    """Distance from P to segment AB, plus the clamped parameter t in [0,1]."""
    dx, dy = bx - ax, by - ay
    denom = dx * dx + dy * dy
    t = 0.0 if denom == 0 else ((px - ax) * dx + (py - ay) * dy) / denom
    t = max(0.0, min(1.0, t))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy)), t


def polyline_dist_frac(px, py, pts):
    """Distance to a polyline and the arc-length fraction of the closest point."""
    lens = [math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1)]
    total = sum(lens)
    best = (1e9, 0.0)
    run = 0.0
    for i, seg_len in enumerate(lens):
        d, t = seg_dist_t(px, py, *pts[i], *pts[i + 1])
        if d < best[0]:
            best = (d, (run + t * seg_len) / total)
        run += seg_len
    return best


# ---------------------------------------------------------------------------
# Sequences. Each returns [(col, row, colour, radius_in_cells), ...] for frame i.
# ---------------------------------------------------------------------------

def seq_complete(i):
    """Red dot starburst ripples outward, resolving into a bold white check."""
    dots = []
    burst_r = [1.1, 2.3, 3.6, 5.0, 6.3, None][i]
    burst = [(RED, R_XL), (RED, R_XL), (RED, R_L), (RED, R_S), (DIM, R_XS), None][i]
    spoke = [(RED, R_M), (RED, R_L), (RED, R_M), (DIM, R_XS), None, None][i]
    check_prog = [0.0, 0.0, 0.12, 0.45, 0.78, 1.0][i]

    if burst is not None:
        for c, r in CELLS:
            d = dist(c, r)
            if abs(d - burst_r) <= 0.85:
                dots.append((c, r, burst[0], burst[1]))
            elif spoke and abs(d - (burst_r + 1.7)) <= 0.7 and on_spoke(c, r):
                dots.append((c, r, spoke[0], spoke[1]))

    if check_prog > 0.0:
        for c, r in CELLS:
            d, frac = polyline_dist_frac(c, r, CHECK)
            if frac > check_prog:
                continue
            if d <= 0.62:
                dots.append((c, r, WHITE, R_XL))
            elif d <= 1.35:
                dots.append((c, r, WHITE, R_S))

    if i == 5:  # settle: red corner accents frame the check
        for c, r in ((0, 0), (15, 0), (0, 9), (15, 9)):
            dots.append((c, r, RED, R_M))
    return dots


# Left footprint template: wide ball, narrow arch, rounded heel.
FOOT = [(1, 0), (2, 0),                        # toes
        (0, 1), (1, 1), (2, 1), (3, 1),        # ball
        (0, 2), (1, 2), (2, 2), (3, 2),
        (1, 3), (2, 3),                        # arch
        (0, 4), (1, 4), (2, 4),                # heel
        (1, 5), (2, 5)]

FOOT_W = 4
FOOT_TOP = 2
GROUND_ROW = 9
IMPACT_ROW = 8


def seq_step(i):
    """Left/right footprints alternating in a walk cycle; active foot white."""
    dots = []
    for c in range(COLS):                      # ground line
        dots.append((c, GROUND_ROW, DIM, R_XS if c % 2 else R_S))

    left_active = i < 3
    lift = [-1, -2, 0][i % 3]                  # lift, peak, plant

    for is_left in (True, False):
        active = (is_left == left_active)
        base_c = 3 if is_left else 9
        base_r = FOOT_TOP + (lift if active else 0)
        for fx, fy in FOOT:
            c = base_c + (fx if is_left else FOOT_W - 1 - fx)
            r = base_r + fy
            if not (0 <= c < COLS and 0 <= r < ROWS):
                continue
            if active:
                # toes / ball / arch / heel get different radii so the foot
                # articulates instead of reading as one blob.
                dots.append((c, r, WHITE,
                             R_L if fy == 0 else R_XL if fy <= 2 else
                             R_M if fy == 3 else R_L))
            else:
                dots.append((c, r, DIM, R_S))
        if active and lift == 0:                # impact dots on plant
            for fx in range(FOOT_W):
                dots.append((base_c + fx, IMPACT_ROW, RED, R_M))
    return dots


GLIDER_LANES = ((2, 0), (4, 3), (6, 0))        # (row, phase)

# One streak per 6 columns: red leading tip, tapering white body, grey wake, gap.
GLIDER_TRAIL = {0: (RED, R_L),
                5: (WHITE, R_XL),
                4: (WHITE, R_L),
                3: (WHITE, R_M),
                2: (MID, R_S)}                 # m == 1 is the gap


def seq_glider(i):
    """Dot trails / speed lines sweeping left to right."""
    dots = []
    for row, phase in GLIDER_LANES:
        for c in range(COLS):
            style = GLIDER_TRAIL.get((c - i - phase) % 6)
            if style:
                dots.append((c, row, style[0], style[1]))
    return dots


SILENCE_SHAPE = (0.30, 0.62, 0.95, 0.55, 1.00, 0.72, 0.40, 0.85,
                 1.00, 0.58, 0.90, 0.45, 0.75, 1.00, 0.55, 0.28)
SILENCE_ENV = (0.22, 0.60, 1.00, 0.66, 0.32, 0.00)
SILENCE_BASE = 5


def seq_silence(i):
    """Dot-column waveform that flattens to one still white line."""
    dots = []
    env = SILENCE_ENV[i]
    for c in range(COLS):
        h = int(round(env * SILENCE_SHAPE[c] * 4))
        dots.append((c, SILENCE_BASE, WHITE, R_XL))
        for dy in range(1, h + 1):
            style = (RED, R_L) if dy == h else (MID, R_M)
            for r in (SILENCE_BASE - dy, SILENCE_BASE + dy):
                if 0 <= r < ROWS:
                    dots.append((c, r, style[0], style[1]))
    return dots


HORIZON_ROW = 7


def seq_sunset(i):
    """Sun sinking below a dotted horizon, settling into a crescent moon."""
    dots = []
    horizon = (MID, R_M) if i <= 3 else (DIM, R_S)
    for c in range(COLS):                          # horizon
        dots.append((c, HORIZON_ROW, horizon[0], horizon[1]))
    for c in range(0, COLS, 3):                    # ground texture
        dots.append((c, ROWS - 1, DIM, R_XS))

    if i < 5:
        sun_y = [2.6, 3.6, 4.6, 5.8, 7.2][i]
        col = [WHITE, WHITE, RED, RED, RED][i]
        core_r, body_r = [(R_XL, R_L), (R_XL, R_L), (R_XL, R_L),
                          (R_L, R_M), (R_L, R_M)][i]
        ray = [(RED, R_S), (RED, R_XS), None, None, None][i]
        for c, r in CELLS:
            if r >= HORIZON_ROW:                   # clipped by the horizon
                continue
            d = dist(c, r, CX, sun_y)
            if d <= SUN_R:
                dots.append((c, r, col, core_r if d <= 1.2 else body_r))
            elif ray and abs(d - (SUN_R + 1.2)) <= 0.6 and on_spoke(c, r, min_d=0.0):
                dots.append((c, r, ray[0], ray[1]))
    else:
        for c, r in CELLS:                          # crescent moon
            if r > 6:
                continue
            if dist(c, r, 8.5, 3.0) <= 3.8 and dist(c, r, 11.5, 3.0) > 3.6:
                dots.append((c, r, WHITE, R_XL))
        for c, r in ((1, 1), (13, 4), (2, 5)):      # stars, clear of the moon
            dots.append((c, r, MID, R_XS))
        dots.append((14, 1, RED, R_S))
    return dots


def seq_movement(i):
    """Energy jolt pulsing out from the centre - get up, now."""
    dots = []
    for c, r in CELLS:                             # static spoke skeleton
        if 1.2 < dist(c, r) <= 6.5 and on_spoke(c, r, tol_deg=10.0):
            dots.append((c, r, DIM, R_XS))

    # Two waves in flight. The offset is deliberately NOT half the period -
    # at exactly half, {r1, r2} repeats every 3 frames and frames 4-6 come out
    # pixel-identical to 1-3, collapsing the 6-frame loop into 3.
    r1 = 0.7 + 1.1 * i
    r2 = (r1 - 2.6) % 6.6

    for rr in (r2, r1):
        if rr < 3.4:
            col, rad = RED, R_XL
        elif rr < 4.8:
            col, rad = RED, R_M
        else:
            col, rad = MID, R_S
        for c, r in CELLS:
            d = dist(c, r)
            if abs(d - rr) <= 0.6:
                bump = 0.05 if on_spoke(c, r, tol_deg=16.0) else 0.0
                dots.append((c, r, col, rad + bump))

    for c, r in CELLS:                             # persistent core
        if dist(c, r) <= 0.9:
            dots.append((c, r, WHITE, R_XL))
    return dots


BUILDERS = {
    "complete": seq_complete,
    "step": seq_step,
    "glider": seq_glider,
    "silence": seq_silence,
    "sunset": seq_sunset,
    "movement": seq_movement,
}


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

def render(dots, scale):
    """Render a dot list at `scale` x mdpi. Per-colour masks avoid RGB fringing."""
    w, h = int(round(BASE_W * scale)), int(round(BASE_H * scale))
    sw, sh = w * SUPERSAMPLE, h * SUPERSAMPLE
    cell_px = CELL * scale * SUPERSAMPLE

    masks = {}
    for col in PAINT_ORDER:
        group = [d for d in dots if d[2] == col]
        if not group:
            continue
        mask = Image.new("L", (sw, sh), 0)
        draw = ImageDraw.Draw(mask)
        for c, r, _, rad in group:
            # Nudge onto output pixel *centres*. (c + 0.5) * cell_px lands on an
            # integer output pixel at every density, which would split each dot
            # symmetrically across a 2x2 pixel group and mush small dots.
            x = (c + 0.5) * cell_px + PIXEL_CENTRE
            y = (r + 0.5) * cell_px + PIXEL_CENTRE
            rp = max(rad * cell_px, 0.6)
            draw.ellipse((x - rp, y - rp, x + rp, y + rp), fill=255)
        masks[col] = mask.resize((w, h), Image.LANCZOS)

    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    for col in PAINT_ORDER:
        if col in masks:
            out.paste(Image.new("RGBA", (w, h), col + (255,)), (0, 0), masks[col])
    return out


def generate(res_dir):
    written = []
    for density, scale in DENSITIES.items():
        out_dir = os.path.join(res_dir, "drawable-" + density)
        os.makedirs(out_dir, exist_ok=True)
        for name in SEQUENCES:
            for i in range(FRAMES):
                path = os.path.join(out_dir, f"anim_{name}_f{i + 1}.png")
                render(BUILDERS[name](i), scale).save(path, "PNG", optimize=True)
                written.append(path)
    return written


# ---------------------------------------------------------------------------
# Verification / preview
# ---------------------------------------------------------------------------

def verify(res_dir):
    errs, checked = [], 0
    for density, scale in DENSITIES.items():
        exp_w, exp_h = int(round(BASE_W * scale)), int(round(BASE_H * scale))
        out_dir = os.path.join(res_dir, "drawable-" + density)
        found = sorted(f for f in os.listdir(out_dir) if f.endswith(".png"))
        if len(found) != FRAMES * len(SEQUENCES):
            errs.append(f"{density}: expected {FRAMES * len(SEQUENCES)} pngs, found {len(found)}")
        for f in found:
            if not NAME_RE.match(f):
                errs.append(f"{density}/{f}: invalid Android resource name")
        for name in SEQUENCES:
            seen = {}
            for i in range(FRAMES):
                path = os.path.join(out_dir, f"anim_{name}_f{i + 1}.png")
                with Image.open(path) as im:
                    im.load()
                    if im.mode != "RGBA":
                        errs.append(f"{density}/{name}_f{i+1}: mode {im.mode} != RGBA")
                    if im.size != (exp_w, exp_h):
                        errs.append(f"{density}/{name}_f{i+1}: {im.size} != {(exp_w, exp_h)}")
                    lit = sum(im.getchannel("A").histogram()[1:])
                    if lit < 0.02 * exp_w * exp_h:
                        errs.append(f"{density}/{name}_f{i+1}: near-blank ({lit} lit px)")
                    data = im.tobytes()
                # every frame in a sequence must be pixel-distinct from every other
                if data in seen:
                    errs.append(f"{density}/{name}: frame {i+1} identical to "
                                f"frame {seen[data]+1}")
                seen[data] = i
                checked += 1
    return checked, errs


def preview(res_dir, path, density="xhdpi"):
    scale = DENSITIES[density]
    w, h = int(round(BASE_W * scale)), int(round(BASE_H * scale))
    pad = 8
    sheet = Image.new("RGBA", (FRAMES * (w + pad) + pad,
                               len(SEQUENCES) * (h + pad) + pad), (8, 8, 8, 255))
    for y, name in enumerate(SEQUENCES):
        for i in range(FRAMES):
            src = os.path.join(res_dir, "drawable-" + density, f"anim_{name}_f{i+1}.png")
            with Image.open(src) as im:
                sheet.alpha_composite(im.convert("RGBA"),
                                      (pad + i * (w + pad), pad + y * (h + pad)))
    sheet.save(path)
    return path


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    default_res = os.path.join(here, os.pardir, "android", "app", "src", "main", "res")

    ap = argparse.ArgumentParser()
    ap.add_argument("--res-dir", default=os.path.normpath(default_res))
    ap.add_argument("--verify", action="store_true")
    ap.add_argument("--preview", metavar="PNG")
    args = ap.parse_args()

    written = generate(args.res_dir)
    print(f"wrote {len(written)} png files under {args.res_dir}")

    if args.preview:
        print("preview:", preview(args.res_dir, args.preview))

    if args.verify:
        checked, errs = verify(args.res_dir)
        print(f"verified {checked} files")
        for e in errs:
            print("  FAIL:", e)
        if errs:
            return 1
        print("  all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
