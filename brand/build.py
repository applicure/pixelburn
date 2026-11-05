#!/usr/bin/env python3
"""Regenerates every brand asset from the grids below. Needs rsvg-convert and ImageMagick.

Run from anywhere: python3 brand/build.py
All geometry lives on integer grids, so exports at whole multiples have no anti-aliased edges.
"""
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BRAND = ROOT / "brand"
PNG = BRAND / "png"
WEB_APP = ROOT / "apps/web/app"
WEB_PUBLIC = ROOT / "apps/web/public"
PATHS_TS = ROOT / "apps/web/lib/brandPaths.ts"
SERVICES_PATHS_TS = ROOT / "services/src/card/brandPaths.ts"  # the API renders share cards and cannot import from apps/

ORANGE = "#FF6400"  # sampled from the source's flat areas (median #FE6402; the rest is JPEG noise)
CREAM = "#FFF5DC"  # sampled, median #FFF5DC
BLACK = "#000000"

# ---------------------------------------------------------------- mark (11x13 grid)
MARK_W, MARK_H = 11, 13
MARK_D = "M0 0H9V1H10V2H11V7H10V8H9V9H3V13H0ZM3 2V7H8V2Z"
MARK_PIXEL = (4.5, 3.5, 2, 2)


def G(s):
    return [r for r in s.strip().split("\n")]


# ---------------------------------------------------------------- wordmark glyphs (14 rows, measured from the source)
WORD = {
    "P": G("""
##########..
##########..
############
####....####
####....####
####....####
############
##########..
##########..
####........
####........
####........
####........
####........
"""),
    "I": G("\n".join(["####"] * 14)),
    "X": G("""
####.....####
####.....####
######.######
..####.####..
..#########..
....#####....
....#####....
....#####....
....#####....
..#########..
..####.####..
######.######
####.....####
####.....####
"""),
    "E": G("""
##########
##########
##########
####......
####......
########..
########..
########..
####......
####......
####......
##########
##########
##########
"""),
    "L": G("\n".join(["####......"] * 11 + ["##########"] * 3)),
    "F": G("""
##########
##########
##########
####......
####......
#########.
#########.
#########.
#########.
####......
####......
####......
####......
####......
"""),
    "R": G("""
#########..
#########..
###########
####...####
####...####
####...####
###########
#########..
#########..
########...
####.###...
####..#####
####...####
####...####
"""),
    "A": G("""
..#######..
..#######..
###########
####...####
####...####
####...####
####...####
###########
###########
###########
####...####
####...####
####...####
####...####
"""),
    "M": G("""
####......####
####......####
######..######
######..######
##############
##############
##############
####..##..####
####..##..####
####......####
####......####
####......####
####......####
####......####
"""),
}

# ---------------------------------------------------------------- $PXL glyphs (20 rows; letters occupy rows 2..17)
TICK = {
    "$": G("""
......##......
......##......
..##########..
..##########..
##############
##############
####..##..####
####..##......
############..
..##########..
..##########..
..############
......##..####
####..##..####
##############
##############
..##########..
..##########..
......##......
......##......
"""),
    "P": G("""
.............
.............
###########..
###########..
#############
#############
####.....####
####.....####
####.....####
#############
#############
###########..
###########..
####.........
####.........
####.........
####.........
####.........
.............
.............
"""),
    "X": G("""
..............
..............
####......####
####......####
######..######
######..######
..##########..
..##########..
....######....
....######....
....######....
....######....
..##########..
..##########..
######..######
######..######
####......####
####......####
..............
..............
"""),
    "L": G("\n".join(["............"] * 2 + ["####........"] * 12 + ["############"] * 4 + ["............"] * 2)),
}

# ---------------------------------------------------------------- tagline: thin 5x7 pixel face, no font dependency
_T = {
    "A": ".###.|#...#|#...#|#####|#...#|#...#|#...#",
    "H": "#...#|#...#|#...#|#####|#...#|#...#|#...#",
    "a": ".....|.....|.###.|....#|.####|#...#|.####",
    "b": "#....|#....|####.|#...#|#...#|#...#|####.",
    "d": "....#|....#|.####|#...#|#...#|#...#|.####",
    "e": ".....|.....|.###.|#...#|#####|#....|.###.",
    "f": "..##.|.#...|####.|.#...|.#...|.#...|.#...",
    "i": ".#.|...|##.|.#.|.#.|.#.|###",
    "l": "##.|.#.|.#.|.#.|.#.|.#.|###",
    "m": ".....|.....|##.#.|#.#.#|#.#.#|#.#.#|#.#.#",
    "n": ".....|.....|####.|#...#|#...#|#...#|#...#",
    "o": ".....|.....|.###.|#...#|#...#|#...#|.###.",
    "p": ".....|.....|####.|#...#|#...#|#...#|####.|#....|#....",
    "r": ".....|.....|#.##.|##..#|#....|#....|#....",
    "s": ".....|.....|.####|#....|.###.|....#|####.",
    "u": ".....|.....|#...#|#...#|#...#|#...#|.####",
    "v": ".....|.....|#...#|#...#|#...#|.#.#.|..#..",
    "x": ".....|.....|#...#|.#.#.|..#..|.#.#.|#...#",
    "y": ".....|.....|#...#|#...#|#...#|#...#|.####|....#|.###.",
    ".": ".|.|.|.|.|.|#",
}


def rects(rows, ox=0, oy=0, u=1):
    """Merges each glyph row into horizontal runs and returns path commands."""
    out = []
    for r, row in enumerate(rows):
        c = 0
        while c < len(row):
            if row[c] == "#":
                s = c
                while c < len(row) and row[c] == "#":
                    c += 1
                out.append(f"M{ox + s * u} {oy + r * u}h{(c - s) * u}v{u}h{-(c - s) * u}z")
            else:
                c += 1
    return "".join(out)


def text_path(text, font, gap, space, u=1, ox=0, oy=0):
    d, x = "", 0
    for ch in text:
        if ch == " ":
            x += space
            continue
        g = font[ch]
        d += rects(g, ox + x * u, oy, u)
        x += len(g[0]) + gap
    return d, x - gap


WORD_D, WORD_W = text_path("PIXEL FRAME", WORD, 2, 6)
WORD_H = 14
TICK_D, TICK_W = text_path("$PXL", TICK, 4, 0)
TICK_H = 20


def svg(w, h, body, bg=None, vb=None):
    bgr = f'<rect width="{w}" height="{h}" fill="{bg}"/>' if bg else ""
    vb = vb or f"0 0 {w} {h}"
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" width="{w}" height="{h}" shape-rendering="crispEdges">{bgr}{body}</svg>\n'


def mark_body(x=0, y=0, u=1, pixel=None):
    px, py, pw, ph = pixel or tuple(v * u for v in MARK_PIXEL)
    return (
        f'<path transform="translate({x} {y}) scale({u})" fill="{ORANGE}" fill-rule="evenodd" d="{MARK_D}"/>'
        f'<rect x="{x + px}" y="{y + py}" width="{pw}" height="{ph}" fill="{CREAM}"/>'
    )


def word_body(x, y, u, color=CREAM):
    return f'<path transform="translate({x} {y}) scale({u})" fill="{color}" d="{WORD_D}"/>'


def tick_body(x, y, u, color=ORANGE):
    return f'<path transform="translate({x} {y}) scale({u})" fill="{color}" d="{TICK_D}"/>'


def write(p, s):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(s)


def raster(src_svg, out, zoom=1):
    out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["rsvg-convert", "--zoom", str(zoom), "-o", str(out), str(src_svg)], check=True)
    subprocess.run(["magick", str(out), "-strip", "-define", "png:exclude-chunk=date,time", str(out)], check=True)


def ember_field(w, h, band, cell, color=ORANGE, seed=7):
    """A row-by-row dissolving floor of whole pixels: the burn, on the brand's grid."""
    state, out = seed, []
    for r in range(band // cell):
        y = h - (r + 1) * cell
        keep = (1 - r / (band / cell)) ** 2.2
        for c in range(w // cell + 1):
            state = (state * 1103515245 + 12345) & 0x7FFFFFFF
            if state / 0x7FFFFFFF < keep:
                out.append(f"M{c * cell} {y}h{cell}v{cell}h-{cell}z")
    return f'<path fill="{color}" d="{"".join(out)}"/>'


# ---------------------------------------------------------------- lockup: proportions measured from the source
# base b: mark unit 30b, word unit 5b, ticker unit 3b (source: 48 / 8.07 / 4.72 px, i.e. b ~ 1.614 px)
LOCK_W, LOCK_H = WORD_W * 5, 13 * 30 + 50 + 14 * 5 + 35 + 20 * 3
LOCK_MARK_X = 165  # the source sits the P right of centre so its left-heavy mass reads as centred
LOCK_TICK_X = (LOCK_W - TICK_W * 3) // 2


def lockup_body():
    y2 = 13 * 30 + 50
    return mark_body(LOCK_MARK_X, 0, 30) + word_body(0, y2, 5) + tick_body(LOCK_TICK_X, y2 + 70 + 35, 3)


def lockup_on_black(pad=60):
    w, h = LOCK_W + pad * 2, LOCK_H + pad * 2
    return svg(w, h, f'<g transform="translate({pad} {pad})">{lockup_body()}</g>', bg=BLACK)


def on_black_square(size, unit, pixel=None):
    x, y = (size - MARK_W * unit) // 2, (size - MARK_H * unit) // 2
    return svg(size, size, mark_body(x, y, unit, pixel), bg=BLACK)


def og_card(w=1200, h=630):
    u = 28  # mark 308x364
    mx, my = 96, (h - 13 * u) // 2 - 22
    tx = mx + 11 * u + 72
    word_u = 5  # 635 wide
    tick_u = 4
    tag_u = 4
    assert tx + WORD_W * word_u <= w - 40, (tx, WORD_W * word_u)
    yw = my + 24
    yt = yw + 14 * word_u + 34
    ytag = yt + 20 * tick_u + 34
    # the tagline is too long for one line next to the mark: break it after the first sentence
    l1, l1w = _tag_line("A million pixels.", tag_u, tx, ytag)
    l2, l2w = _tag_line("Half of every dollar burns.", tag_u, tx, ytag + 44)
    body = (
        ember_field(w, h, 108, 12)
        + mark_body(mx, my, u)
        + word_body(tx, yw, word_u)
        + tick_body(tx, yt, tick_u)
        + f'<path fill="{CREAM}" d="{l1}{l2}"/>'
    )
    return svg(w, h, body, bg=BLACK)


def _tag_line(text, u, ox, oy):
    rows = {k: v.split("|") for k, v in _T.items()}
    return text_path(text, rows, 1, 3, u, ox, oy)


def banner(w=1500, h=500):
    # X overlays the avatar on the lower left, so the logo group sits right of it
    u = 20  # mark 220x260
    word_u = 5
    group_w = 11 * u + 56 + WORD_W * word_u
    mx = w - group_w - 96
    my = (h - 13 * u) // 2 - 52
    tx = mx + 11 * u + 56
    yw = my + 18
    yt = yw + 14 * word_u + 28
    # two lines so it survives X scaling the banner down on phones
    l1, _ = _tag_line("A million pixels.", 3, tx, yt + 20 * 4 + 24)
    l2, _ = _tag_line("Half of every dollar burns.", 3, tx, yt + 20 * 4 + 24 + 32)
    body = (
        ember_field(w, h, 96, 12)
        + mark_body(mx, my, u)
        + word_body(tx, yw, word_u)
        + tick_body(tx, yt, 4)
        + f'<path fill="{CREAM}" d="{l1}{l2}"/>'
    )
    return svg(w, h, body, bg=BLACK)


# ---------------------------------------------------------------- grid-fitted favicon sizes
# (x, y) of the mark, unit, and a centre pixel in whole device pixels relative to the mark
FAV = {
    16: (2, 1, 1, (4, 3, 3, 3)),  # the 5x5 hole has no centred 2x2 at 1 px per unit; 3x3 stays centred and legible
    32: (5, 3, 2, (9, 7, 4, 4)),
    48: (7, 4, 3, (13, 10, 7, 7)),
}


def favicon_svg(size):
    x, y, u, pixel = FAV[size]
    return svg(size, size, mark_body(x, y, u, pixel), bg=BLACK)


def main():
    write(BRAND / "mark.svg", svg(MARK_W * 40, MARK_H * 40, mark_body(), vb=f"0 0 {MARK_W} {MARK_H}"))
    write(BRAND / "mark-on-black.svg", on_black_square(19, 1).replace('width="19" height="19" shape', 'width="760" height="760" shape'))
    write(BRAND / "wordmark.svg", svg(WORD_W, WORD_H, f'<path fill="{CREAM}" d="{WORD_D}"/>'))
    write(BRAND / "ticker.svg", svg(TICK_W, TICK_H, f'<path fill="{ORANGE}" d="{TICK_D}"/>'))
    write(BRAND / "lockup.svg", svg(LOCK_W, LOCK_H, lockup_body()))
    write(BRAND / "lockup-on-black.svg", lockup_on_black())

    tmp = BRAND / ".tmp"
    tmp.mkdir(exist_ok=True)

    def out(name, content, dest, zoom=1):
        s = tmp / f"{name}.svg"
        s.write_text(content)
        raster(s, dest, zoom)

    # plain exports at whole multiples
    for z in (1, 2, 4):
        raster(BRAND / "mark.svg", PNG / f"mark-{MARK_W * 20 * z}.png", z / 2)  # mark.svg is 440 wide
    out("mob", on_black_square(1024, 64), PNG / "mark-on-black-1024.png")
    out("mob512", on_black_square(512, 32), PNG / "mark-on-black-512.png")
    raster(BRAND / "wordmark.svg", PNG / "wordmark-1016.png", 8)
    raster(BRAND / "wordmark.svg", PNG / "wordmark-508.png", 4)
    raster(BRAND / "ticker.svg", PNG / "ticker-520.png", 8)
    raster(BRAND / "lockup.svg", PNG / "lockup-1270.png", 2)
    raster(BRAND / "lockup-on-black.svg", PNG / "lockup-on-black-1510.png", 2)

    # socials: both are shown cropped to a circle, so the mark stays inside the inscribed circle
    out("token", on_black_square(1000, 50), BRAND / "token-image-1000.png")
    out("avatar", on_black_square(400, 20), BRAND / "x-avatar-400.png")
    out("banner", banner(), BRAND / "x-banner-1500x500.png")

    # web app (Next file conventions)
    write(WEB_APP / "icon.svg", favicon_svg(16).replace('width="16" height="16" shape', 'width="32" height="32" shape'))
    icos = []
    for size in (16, 32, 48):
        p = tmp / f"fav{size}.png"
        out(f"fav{size}", favicon_svg(size), p)
        icos.append(str(p))
    subprocess.run(["magick", *icos, str(WEB_APP / "favicon.ico")], check=True)
    out("apple", on_black_square(180, 10), WEB_APP / "apple-icon.png")
    out("og", og_card(), WEB_APP / "opengraph-image.png")
    out("og2", og_card(), WEB_APP / "twitter-image.png")
    out("i192", on_black_square(192, 10), WEB_PUBLIC / "icons/icon-192.png")
    out("i512", on_black_square(512, 28), WEB_PUBLIC / "icons/icon-512.png")
    # maskable: the safe zone is the centre 80%
    out("m512", on_black_square(512, 22), WEB_PUBLIC / "icons/icon-maskable-512.png")

    paths_ts = (
        "// Generated by brand/build.py. Do not edit by hand.\n"
        f"/** Evenodd outline with the frame's hole, on an {MARK_W}x{MARK_H} grid. */\n"
        f'export const MARK_PATH = "{MARK_D}";\n'
        f"export const MARK_GRID = {{ w: {MARK_W}, h: {MARK_H} }} as const;\n"
        f"export const MARK_PIXEL = {{ x: {MARK_PIXEL[0]}, y: {MARK_PIXEL[1]}, w: {MARK_PIXEL[2]}, h: {MARK_PIXEL[3]} }} as const;\n"
        f'export const WORDMARK_PATH = "{WORD_D}";\n'
        f"export const WORDMARK_GRID = {{ w: {WORD_W}, h: {WORD_H} }} as const;\n"
    )
    write(PATHS_TS, paths_ts)
    write(SERVICES_PATHS_TS, paths_ts)
    for f in tmp.iterdir():
        f.unlink()
    tmp.rmdir()


if __name__ == "__main__":
    main()
