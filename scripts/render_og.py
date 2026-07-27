#!/usr/bin/env python3
"""render_og.py — emit a 1200x630 PNG OG card for a daily digest.

Reads `digest.md`, picks the first story's `[KICKER]` and headline, and
renders a branded card with the AI Morning Letter wordmark + date + top
kicker pill + first headline + N-more line + canonical URL. The card is
saved as `og.png` next to the per-day HTML.

Anti-mojibake: writes with explicit UTF-8 paths; uses Windows-friendly
font fallbacks (Segoe UI / Arial). The output is a flat PNG, no SVG
intermediate, so it renders identically on every social platform.

Usage:
    python render_og.py <input.md> <output.png>
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from datetime import datetime

from PIL import Image, ImageDraw, ImageFont


# ----- constants ----------------------------------------------------------

W, H = 1200, 630
PADDING = 56

# Brand palette (matches styles.css)
INK = (15, 23, 42)          # slate-900  -- primary text
INK_SOFT = (51, 65, 85)      # slate-700  -- secondary text
MUTED = (100, 116, 139)     # slate-500  -- meta text
FAINT = (148, 163, 184)     # slate-400  -- dividers
BG = (255, 255, 255)
SURFACE = (248, 250, 252)   # slate-50
BRAND_ORANGE = (194, 65, 12)  # orange-700 (#c2410c) -- wordmark
ACCENT_TEAL = (13, 148, 136)  # teal-600 (#0d9488)   -- URL

# Category palette (matches styles.css)
CAT_COLORS = {
    "MODEL":       (79, 70, 229),    # indigo-600
    "PRODUCT":     (124, 58, 237),   # violet-600
    "RESEARCH":    (5, 150, 105),    # emerald-600
    "FUNDING":     (217, 119, 6),    # amber-600
    "POLICY":      (220, 38, 38),    # red-600
    "SECURITY":    (234, 88, 12),    # orange-600
    "TOOLING":     (8, 145, 178),    # cyan-600
    "OPEN-SOURCE": (13, 148, 136),   # teal-600
}

TITLE_RE = re.compile(r"^#\s+AI Digest\s+\u2014\s+(\d{4}-\d{2}-\d{2})", re.MULTILINE)
STORY_HEAD_NEW = re.compile(r"^- \*\*\[([A-Z-]+)\]\s+(.+?)\.\*\*\s*(.*)$")
STORY_HEAD_LEGACY = re.compile(r"^- \*\*(.+?)\.\*\*\s*(.*)$")

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\segoeuib.ttf",
    r"C:\Windows\Fonts\segoeui.ttf",
    r"C:\Windows\Fonts\arialbd.ttf",
    r"C:\Windows\Fonts\arial.ttf",
    "/Library/Fonts/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
]


# ----- helpers ------------------------------------------------------------

def find_font(bold: bool, size: int) -> ImageFont.FreeTypeFont:
    candidates = FONT_CANDIDATES if bold else [c.replace("b.ttf", ".ttf") for c in FONT_CANDIDATES]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()


def parse_date(md_text: str, fallback: str) -> str:
    m = TITLE_RE.search(md_text)
    return m.group(1) if m else fallback


def parse_first_story(md_text: str) -> tuple[str, str]:
    """Return (kicker, headline) of the first `- **[KICKER] ...` story.

    Falls back to legacy `- **Headline.**` form. Defaults to MODEL if the
    kicker is unrecognised. If no story matches, returns ("", "")."""
    for line in md_text.split("\n"):
        m = STORY_HEAD_NEW.match(line)
        if m:
            kicker = m.group(1)
            headline = m.group(2).strip().rstrip(".")
            if kicker not in CAT_COLORS:
                kicker = "MODEL"
            return kicker, headline
        m = STORY_HEAD_LEGACY.match(line)
        if m:
            headline = m.group(1).strip().rstrip(".")
            return "MODEL", headline
    return "", ""


def wrap_text(draw: ImageDraw.ImageDraw, text: str, font, max_width: int) -> list[str]:
    """Naive word-wrap that respects max_width in pixels."""
    if not text:
        return []
    words = text.split()
    lines: list[str] = []
    cur = ""
    for w in words:
        trial = (cur + " " + w).strip()
        bbox = draw.textbbox((0, 0), trial, font=font)
        if bbox[2] - bbox[0] > max_width and cur:
            lines.append(cur)
            cur = w
        else:
            cur = trial
    if cur:
        lines.append(cur)
    return lines


def format_date_long(date: str) -> str:
    try:
        dt = datetime.strptime(date, "%Y-%m-%d")
        return dt.strftime("%a %b %d")  # e.g. "Mon Jul 27"
    except ValueError:
        return date


def format_iso(date: str) -> str:
    try:
        dt = datetime.strptime(date, "%Y-%m-%d")
        return dt.strftime("%b %d, %Y")
    except ValueError:
        return date


def n_stories_from_meta(md_text: str) -> int:
    """Read the `*N stories · ...*` meta line; default to 8 if missing."""
    m = re.search(r"^\*([^\n]+)\*\s*$", md_text, re.MULTILINE)
    if not m:
        return 0
    n = re.search(r"(\d+)\s+stor(?:y|ies)", m.group(1), re.IGNORECASE)
    return int(n.group(1)) if n else 0


# ----- main ---------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input_md")
    parser.add_argument("output_png")
    parser.add_argument("--site-url", default="https://ai-morning-letter.vercel.app")
    args = parser.parse_args()

    try:
        with open(args.input_md, "r", encoding="utf-8") as f:
            md_text = f.read()
    except FileNotFoundError:
        print(f"input not found: {args.input_md}", file=sys.stderr)
        return 2

    fallback_date = datetime.now().strftime("%Y-%m-%d")
    date = parse_date(md_text, fallback_date)
    kicker, headline = parse_first_story(md_text)
    n_stories = n_stories_from_meta(md_text) or 1

    # Fonts
    f_wordmark = find_font(True, 32)
    f_date = find_font(False, 24)
    f_kicker = find_font(True, 24)
    f_kicker_pad = find_font(False, 24)
    f_headline = find_font(True, 56)
    f_subline = find_font(False, 26)
    f_url = find_font(False, 22)
    f_label = find_font(True, 18)

    # Compose
    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)

    # Subtle top accent strip (4px) in brand orange
    draw.rectangle((0, 0, W, 6), fill=BRAND_ORANGE)

    # Top row: brand wordmark (left) + date (right)
    draw.text((PADDING, PADDING - 4), "AI Morning Letter", fill=BRAND_ORANGE, font=f_wordmark)
    date_long = format_date_long(date)
    dbbox = draw.textbbox((0, 0), date_long, font=f_date)
    draw.text((W - PADDING - (dbbox[2] - dbbox[0]), PADDING + 2), date_long, fill=INK_SOFT, font=f_date)

    # Kicker pill
    y = PADDING + 90
    if kicker:
        cat = CAT_COLORS[kicker]
        pill_text = kicker
        # Pill background with subtle tint
        kbbox = draw.textbbox((0, 0), pill_text, font=f_kicker)
        tw = kbbox[2] - kbbox[0]
        th = kbbox[3] - kbbox[1]
        pad_x, pad_y = 18, 10
        pill_w = tw + pad_x * 2
        pill_h = th + pad_y * 2
        # Translucent pill bg via overlay (RGB image only supports opaque)
        # Use a lighter tint of the cat color by mixing with white.
        def mix(c, t):
            return tuple(int(c[i] * (1 - t) + 255 * t) for i in range(3))
        draw.rounded_rectangle(
            (PADDING, y, PADDING + pill_w, y + pill_h),
            radius=8,
            fill=mix(cat, 0.88),
            outline=cat,
            width=2,
        )
        draw.text((PADDING + pad_x, y + pad_y - 2), pill_text, fill=cat, font=f_kicker)
        # Tiny "TOP STORY" label above the kicker
        draw.text((PADDING, y - 26), "TOP STORY", fill=FAINT, font=f_label)
        y = y + pill_h + 24

    # Headline (wrapped)
    max_w = W - 2 * PADDING
    if headline:
        # Shrink font if headline is long
        size = 56
        while size > 32:
            f_h = find_font(True, size)
            lines = wrap_text(draw, headline, f_h, max_w)
            if len(lines) <= 4:
                f_headline = f_h
                break
            size -= 4
        else:
            lines = wrap_text(draw, headline, f_headline, max_w)

        line_h = int(f_headline.size * 1.18)
        for i, ln in enumerate(lines[:5]):  # cap at 5 lines
            draw.text((PADDING, y + i * line_h), ln, fill=INK, font=f_headline)
        y = y + len(lines[:5]) * line_h + 18

    # N more stories inside
    if n_stories > 1:
        more = f"+{n_stories - 1} more stor{'y' if n_stories - 1 == 1 else 'ies'} inside"
        draw.text((PADDING, y), more, fill=MUTED, font=f_subline)
        y = y + 36

    # Divider line above footer
    draw.line((PADDING, H - 88, W - PADDING, H - 88), fill=FAINT, width=1)

    # Footer: domain + iso date
    iso = format_iso(date)
    draw.text((PADDING, H - 60), args.site_url.replace("https://", ""), fill=ACCENT_TEAL, font=f_url)
    # Right side: ISO date
    ibbox = draw.textbbox((0, 0), iso, font=f_url)
    draw.text((W - PADDING - (ibbox[2] - ibbox[0]), H - 60), iso, fill=FAINT, font=f_url)

    # Save
    os.makedirs(os.path.dirname(os.path.abspath(args.output_png)), exist_ok=True)
    img.save(args.output_png, format="PNG", optimize=True)
    print(f"rendered {args.output_png}: {W}x{H} date={date} kicker={kicker or '∅'} stories={n_stories}")
    return 0


if __name__ == "__main__":
    sys.exit(main())