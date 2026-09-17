#!/usr/bin/env python3
"""Draws `default-character.png`, the one character this app ships.

Run this to regenerate the sheet:

    python3 make_default_character.py default-character.png

The picture is the licence statement. Nothing here is traced, sampled or derived from
another project's art — every shape is an ellipse, a polygon or a line placed by the
numbers below — so the sheet's terms are this repository's terms, and the file next to
this script is the whole of its provenance. That is why the generator is committed
rather than the sheet simply dropped in: a PNG with no source beside it is a file
nobody can say the origin of, which is the state this app refuses to import from.

The grid is the renderer's own (`rendering/sprite-slicer.ts`): FIXED_GRID_COLS x
FIXED_GRID_ROWS = 8 x 9, and the row roles are `animation-bindings.ts`'s
DEFAULT_ANIMATION_CONFIG — 0 Idle, 1 RunRight, 2 RunLeft, 3 Waving, 4 Jumping,
5 Failed, 6 Waiting, 7 Running, 8 Review. Every row is filled, because a row with no
pixels is a state the pet can be in with nothing on screen, and the sprite's own
fallback would never say so.

Anti-aliasing is baked in here, at author time, by drawing at SUPERSAMPLE times the
cell size and downsampling once. The renderer draws with `imageSmoothingEnabled =
false` and shows a cell at 160x180 CSS px, so the sheet is authored at exactly that
size and the smoothing that survives is the smoothing chosen here.
"""

import sys
from math import cos, pi, sin

from PIL import Image, ImageDraw

# The renderer's grid. Changing either number without changing `sprite-slicer.ts`
# produces a sheet sliced into the wrong cells, so they are named and asserted below.
COLS, ROWS = 8, 9
CELL_W, CELL_H = 160, 180
SUPERSAMPLE = 4

OUTLINE = (74, 56, 48)
FUR = (247, 236, 220)
FUR_SHADE = (226, 205, 183)
ORANGE = (233, 150, 96)
ORANGE_SHADE = (203, 121, 74)
PINK = (243, 178, 170)
EYE = (52, 40, 38)
WHITE = (255, 255, 255)
SWEAT = (108, 184, 238)
SPARK = (255, 214, 120)


class Frame:
    """One cell's drawing surface, in cell coordinates, supersampled.

    Every coordinate below is written in the 160x180 the sheet is shown at, so the
    numbers in the pose functions are the ones a reader can check against the picture.
    """

    def __init__(self):
        self.size = (CELL_W * SUPERSAMPLE, CELL_H * SUPERSAMPLE)
        self.img = Image.new("RGBA", self.size, (0, 0, 0, 0))
        self.d = ImageDraw.Draw(self.img)

    def _s(self, v):
        return v * SUPERSAMPLE

    def _box(self, box):
        return [self._s(v) for v in box]

    def ellipse(self, box, fill, outline=OUTLINE, width=3):
        self.d.ellipse(self._box(box), fill=fill, outline=outline, width=self._s(width))

    def ellipse_plain(self, box, fill):
        self.d.ellipse(self._box(box), fill=fill)

    def polygon(self, points, fill, outline=OUTLINE, width=3):
        pts = [(self._s(x), self._s(y)) for x, y in points]
        self.d.polygon(pts, fill=fill, outline=outline, width=self._s(width))

    def line(self, points, fill, width=3):
        pts = [(self._s(x), self._s(y)) for x, y in points]
        w = self._s(width)
        self.d.line(pts, fill=fill, width=w, joint="curve")
        # PIL's `line` has no round cap, so a stubby circle at each end is the cap.
        for x, y in pts:
            self.d.ellipse(
                [self._s(x) - w / 2, self._s(y) - w / 2, self._s(x) + w / 2, self._s(y) + w / 2],
                fill=fill,
            )

    def rounded(self, box, radius, fill, outline=OUTLINE, width=3):
        self.d.rounded_rectangle(
            self._box(box), radius=self._s(radius), fill=fill, outline=outline, width=self._s(width)
        )

    def done(self):
        return self.img.resize((CELL_W, CELL_H), Image.LANCZOS)


def rotate(point, origin, degrees):
    """A point turned about an origin, for the poses that lean or wave."""
    (x, y), (ox, oy) = point, origin
    rad = degrees * pi / 180
    dx, dy = x - ox, y - oy
    return (ox + dx * cos(rad) - dy * sin(rad), oy + dx * sin(rad) + dy * cos(rad))


def draw_tail(f, base, angle, sway):
    """The tail: a two-segment curve with bands, so `angle` and `sway` read as motion.

    Drawn to the *right* of the body and before it, so the base is hidden by the body
    and the curve is not — a tail drawn inside the silhouette is a tail nobody sees.
    """
    x, y = base
    mid = (x + 22 + 3 * sin(sway), y - 20 + 6 * cos(angle))
    tip = (x + 38 + 6 * sin(sway), y - 44 + 10 * cos(angle))
    f.line([(x, y), mid, tip], OUTLINE, 15)
    f.line([(x, y), mid, tip], ORANGE, 11)
    # Two bands, placed by fraction along the same two segments.
    for t in (0.45, 0.78):
        if t <= 0.5:
            u = t / 0.5
            bx, by = x + (mid[0] - x) * u, y + (mid[1] - y) * u
        else:
            u = (t - 0.5) / 0.5
            bx, by = mid[0] + (tip[0] - mid[0]) * u, mid[1] + (tip[1] - mid[1]) * u
        f.line([(bx - 5, by - 3), (bx + 5, by + 3)], ORANGE_SHADE, 9)
    return tip


def draw_ears(f, head_cx, head_cy, head_rx, tilt, droop=0.0):
    """Two triangular ears. `droop` rotates them outward and down, the sad/collapsed pose."""
    for side in (-1, 1):
        bx = head_cx + side * head_rx * 0.62
        by = head_cy - head_rx * 0.72
        tip = (bx + side * (18 + 6 * droop), by - 26 + 22 * droop)
        outer = [(bx - side * 16, by + 12), (bx + side * 14, by + 10), tip]
        outer = [rotate(p, (bx, by), side * (tilt + 14 * droop)) for p in outer]
        f.polygon(outer, ORANGE)
        inner = [
            rotate(
                (bx - side * 8, by + 9),
                (bx, by),
                side * (tilt + 14 * droop),
            ),
            rotate((bx + side * 7, by + 8), (bx, by), side * (tilt + 14 * droop)),
            rotate((tip[0] - side * 2, tip[1] + 7), (bx, by), side * (tilt + 14 * droop)),
        ]
        f.polygon(inner, PINK, outline=None)


def draw_eyes(f, cx, cy, spread, shape):
    """The eyes, in the five shapes the rows need."""
    for side in (-1, 1):
        ex = cx + side * spread
        if shape == "closed":
            f.line([(ex - 8, cy - 3), (ex, cy + 3), (ex + 8, cy - 3)], EYE, 4)
        elif shape == "happy":
            # The arc the other way up. It is the same three points as `closed` mirrored,
            # and the pair is deliberately kept distinct: an eye that reads as content and
            # an eye that reads as shut are two different states the pet can be in.
            f.line([(ex - 8, cy + 3), (ex, cy - 4), (ex + 8, cy + 3)], EYE, 4)
        elif shape == "sad":
            # Slanting down towards the outside, which is what a downcast eye does; the
            # `closed` arc is symmetric and reads as asleep rather than unhappy.
            outer, inner = (ex - 9, cy + 4), (ex + 7, cy - 4)
            f.line([outer, inner] if side < 0 else [inner, outer], EYE, 4)
        elif shape == "wide":
            f.ellipse_plain((ex - 10, cy - 11, ex + 10, cy + 11), WHITE)
            f.ellipse_plain((ex - 10, cy - 11, ex + 10, cy + 11), EYE)
            f.ellipse_plain((ex - 6, cy - 8, ex + 2, cy), WHITE)
            f.ellipse_plain((ex + 1, cy + 2, ex + 6, cy + 7), WHITE)
        else:  # open
            f.ellipse_plain((ex - 9, cy - 10, ex + 9, cy + 10), WHITE)
            f.ellipse_plain((ex - 9, cy - 10, ex + 9, cy + 10), EYE)
            f.ellipse_plain((ex - 5, cy - 7, ex + 2, cy), WHITE)
            f.ellipse_plain((ex + 1, cy + 2, ex + 6, cy + 7), WHITE)


def draw_face(f, cx, cy, spread, eyes, mouth, blush=True):
    draw_eyes(f, cx, cy, spread, eyes)
    # Nose, then the mouth under it.
    f.polygon([(cx - 3, cy + 13), (cx + 3, cy + 13), (cx, cy + 17)], PINK, outline=None)
    if mouth == "smile":
        f.line([(cx - 8, cy + 20), (cx, cy + 24), (cx + 8, cy + 20)], EYE, 3)
    elif mouth == "open":
        f.ellipse((cx - 6, cy + 18, cx + 6, cy + 30), (150, 88, 92), outline=EYE, width=2)
    elif mouth == "wavy":
        f.line([(cx - 8, cy + 22), (cx - 3, cy + 18), (cx + 3, cy + 26), (cx + 8, cy + 22)], EYE, 3)
    elif mouth == "small":
        f.line([(cx - 4, cy + 21), (cx, cy + 24), (cx + 4, cy + 21)], EYE, 3)
    if blush:
        for side in (-1, 1):
            f.ellipse_plain(
                (cx + side * (spread + 16) - 7, cy + 8, cx + side * (spread + 16) + 7, cy + 16), PINK
            )
    # Whiskers, one pair a side.
    for side in (-1, 1):
        for dy in (-3, 4):
            x0 = cx + side * (spread + 22)
            f.line([(x0, cy + 14 + dy), (x0 + side * 14, cy + 12 + dy * 1.6)], OUTLINE, 2)


def draw_paws(f, cx, cy, spread, lift=(0, 0)):
    """Front paws; `lift` raises either one for the waving and running poses."""
    for i, side in enumerate((-1, 1)):
        px = cx + side * spread
        py = cy - lift[i]
        f.ellipse((px - 11, py - 8, px + 11, py + 8), FUR)


def draw_sparkle(f, x, y, r):
    f.polygon(
        [(x, y - r), (x + r * 0.32, y - r * 0.32), (x + r, y), (x + r * 0.32, y + r * 0.32),
         (x, y + r), (x - r * 0.32, y + r * 0.32), (x - r, y), (x - r * 0.32, y - r * 0.32)],
        SPARK,
        outline=None,
    )


def pose(row, t):
    """The pose parameters for one frame. `t` is that frame's phase, 0.0 to 1.0.

    Each row is one clip: its eight columns are eight frames a player loops. The
    amplitudes are all of the same order — a few pixels at 160x180 — because the
    sheet is shown at exactly its authored size, so what is drawn here is what moves.
    """
    wave = sin(2 * pi * t)
    bob = sin(2 * pi * t)
    p = {
        "bob": 0.0, "lean": 0.0, "ear": 0.0, "droop": 0.0, "tail": 0.0, "tail_sway": 0.0,
        "eyes": "open", "mouth": "smile", "lift": (0, 0), "squash": 0.0,
        "extras": None, "blush": True, "head_tilt": 0.0,
    }
    if row == 0:  # Idle — a slow breath, and a blink on the last two frames.
        p["bob"] = -1.5 * bob
        p["tail_sway"] = 2 * pi * t
        p["eyes"] = "closed" if t > 0.75 else "open"
        p["squash"] = 1.0 * bob
    elif row == 1:  # RunRight — leaning in, paws cycling, tail streaming behind.
        p["lean"] = 4.0
        p["bob"] = -3.0 * abs(sin(2 * pi * t))
        p["lift"] = (6 * wave, -6 * wave)
        p["ear"] = -8.0
        p["tail"] = 0.9
        p["mouth"] = "open"
        p["extras"] = "lines-right"
    elif row == 2:  # RunLeft — the same run, mirrored by the sign of `lean`.
        p["lean"] = -4.0
        p["bob"] = -3.0 * abs(sin(2 * pi * t))
        p["lift"] = (-6 * wave, 6 * wave)
        p["ear"] = -8.0
        p["tail"] = 0.9
        p["mouth"] = "open"
        p["extras"] = "lines-left"
    elif row == 3:  # Waving — the "done" row. One paw up and swinging.
        p["lift"] = (0, 20 + 4 * wave)
        p["ear"] = 5.0
        p["eyes"] = "happy"
        p["mouth"] = "open"
        p["bob"] = -1.0
        p["extras"] = "sparkle"
    elif row == 4:  # Jumping — the "celebrate" row: airborne, ears up, sparkles.
        p["bob"] = -16.0 - 6 * abs(sin(2 * pi * t))
        p["squash"] = -2.0
        p["ear"] = -6.0
        p["eyes"] = "happy"
        p["mouth"] = "open"
        p["lift"] = (10, 10)
        p["extras"] = "sparkle-both"
    elif row == 5:  # Failed — ears down, eyes down, a sweat drop.
        p["droop"] = 1.0
        p["bob"] = 2.0
        p["eyes"] = "sad"
        p["mouth"] = "wavy"
        p["tail"] = -0.7
        p["blush"] = False
        p["extras"] = "sweat"
        p["head_tilt"] = 6.0
    elif row == 6:  # Waiting — sitting still, head cocked, watching.
        p["head_tilt"] = 8.0 * sin(2 * pi * t)
        p["eyes"] = "wide"
        p["mouth"] = "small"
        p["tail_sway"] = 2 * pi * t
        p["bob"] = -1.0 * bob
    elif row == 7:  # Running — the "working" row: paws up on a desk, typing.
        p["lift"] = (26 + 3 * wave, 26 - 3 * wave)
        p["eyes"] = "open"
        p["mouth"] = "small"
        p["bob"] = -1.5 * abs(sin(2 * pi * t))
        p["extras"] = "desk"
    else:  # row 8, Review — attentive, leaning in to read.
        p["lean"] = 3.0
        p["head_tilt"] = -6.0 + 3.0 * sin(2 * pi * t)
        p["eyes"] = "open"
        p["mouth"] = "small"
        p["tail_sway"] = pi * t
        p["extras"] = "note"
    return p


def draw_frame(row, t):
    f = Frame()
    p = pose(row, t)

    cx = 80 + p["lean"]
    # The ground the feet rest on, and the body sitting on it. `head_cy` and `body_top`
    # overlap by a good margin on purpose: a head whose chin only touches the chest is
    # two shapes tangent at a point, which leaves a notch that reads as a detached head.
    body_bottom = 168 + p["bob"]
    body_top = 100 + p["bob"]
    head_cy = 80 + p["bob"] + p["squash"] * 0.5
    head_rx = 38

    draw_tail(f, (cx + 22, body_bottom - 12), p["tail"], p["tail_sway"])

    # Hind feet first, then the body over them, then the front paws over that — so the
    # three read as one cat sitting down rather than as three ellipses stacked up.
    for side in (-1, 1):
        f.ellipse(
            (cx + side * 22 - 14, body_bottom - 16, cx + side * 22 + 14, body_bottom + 6), FUR
        )
    # A pear rather than an oval: a wider ellipse for the haunches and a narrower one
    # for the chest, which is what makes a sitting cat read as sitting.
    f.ellipse((cx - 32, body_bottom - 46, cx + 32, body_bottom), FUR)
    f.ellipse((cx - 25, body_top, cx + 25, body_bottom - 24), FUR)
    # A chest patch, and two stripes across the shoulders so the chest is not blank.
    f.ellipse_plain((cx - 14, body_top + 20, cx + 14, body_bottom - 26), WHITE)
    for i, sx in enumerate((-16, -4, 8)):
        f.line([(cx + sx, body_top + 4), (cx + sx + 3, body_top + 14)], ORANGE_SHADE, 4)

    draw_paws(f, cx, body_bottom - 18, 15, p["lift"])

    # Head, drawn over the body so the chin meets the chest cleanly.
    draw_ears(f, cx, head_cy, head_rx, p["ear"], p["droop"])
    f.ellipse((cx - head_rx, head_cy - head_rx * 0.92, cx + head_rx, head_cy + head_rx * 0.92), FUR)
    # Head markings: a tabby stripe set and one orange patch over the left eye.
    f.ellipse_plain((cx - 34, head_cy - 26, cx - 6, head_cy - 6), ORANGE)
    for i in (-1, 0, 1):
        f.line(
            [(cx + i * 12 - 4, head_cy - 30), (cx + i * 12 + 4, head_cy - 20)], ORANGE_SHADE, 5
        )

    if p["extras"] == "desk":
        # The edge of a desk, in front of the body and just under the raised paws. A
        # wider box reads as a plate the cat is sitting in, so it is a thin edge.
        f.rounded((cx - 44, body_bottom - 38, cx + 44, body_bottom - 28), 3, (205, 178, 146), width=2)

    draw_face(f, cx, head_cy, 15, p["eyes"], p["mouth"], p["blush"])

    if p["extras"] == "sparkle":
        for (sx, sy, r) in ((-46, 52, 9), (-56, 74, 6), (48, 44, 7)):
            draw_sparkle(f, cx + sx, sy + p["bob"], r)
    elif p["extras"] == "sparkle-both":
        for (sx, sy, r) in ((-44, 46, 9), (46, 40, 9), (-56, 78, 6), (58, 72, 6)):
            draw_sparkle(f, cx + sx, sy + p["bob"], r)
    elif p["extras"] == "sweat":
        # Beside the cheek and below the ear. Above the ear it merges with it at this
        # size and reads as a broken ear rather than as a drop coming off the cat.
        f.polygon([(cx + 50, head_cy - 14), (cx + 43, head_cy + 3), (cx + 57, head_cy + 3)], SWEAT)
        f.ellipse_plain((cx + 42, head_cy - 5, cx + 58, head_cy + 11), SWEAT)
    elif p["extras"] in ("lines-right", "lines-left"):
        # At the feet, not at shoulder height: the tail sweeps through shoulder height on
        # the same side, and lines drawn there disappear behind it.
        reach = -1 if p["extras"] == "lines-right" else 1
        for i, dy in enumerate((-9, 0, 9)):
            x_out = cx + reach * 56
            x_in = cx + reach * (44 - i * 3)
            f.line([(x_out, body_bottom - 16 + dy), (x_in, body_bottom - 16 + dy)], OUTLINE, 3)
    elif p["extras"] == "note":
        # The left, because the tail owns the right on every row.
        f.rounded((cx - 62, body_top - 4, cx - 34, body_top + 26), 3, WHITE)
        for i in range(3):
            f.line(
                [(cx - 57, body_top + 4 + i * 8), (cx - 39, body_top + 4 + i * 8)],
                (150, 140, 132),
                2,
            )

    return f.done()


def main(out_path):
    sheet = Image.new("RGBA", (CELL_W * COLS, CELL_H * ROWS), (0, 0, 0, 0))
    for row in range(ROWS):
        for col in range(COLS):
            sheet.paste(draw_frame(row, col / COLS), (col * CELL_W, row * CELL_H))
    # The sheet is committed, so its bytes are a cost the repository carries. A flat
    # palette costs nothing visible — the drawing uses fewer than 256 colours already —
    # and takes the file from a few hundred kilobytes to a few tens.
    sheet = sheet.quantize(colors=255, method=Image.FASTOCTREE)
    sheet.save(out_path, "PNG", optimize=True)
    print(f"{out_path}: {sheet.width}x{sheet.height}, {COLS}x{ROWS} cells")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "default-character.png")
