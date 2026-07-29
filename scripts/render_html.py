#!/usr/bin/env python3
"""render_html.py — markdown → standalone UTF-8 HTML for ai-morning-letter.

The new design (2026-07-27) renders stories as cards with category-colored
kicker pills and a tidy source list, plus a "Coming up" callout block and a
masthead/footer shell. Old `AI Digest — DATE` H1s in source markdowns are
stripped before parsing; the rendered H1 always uses the Morning Letter brand.

Anti-mojibake guarantees:
  * All reads/writes use explicit UTF-8 (encoding="utf-8").
  * <meta charset="utf-8"> is set.
  * Title is rendered with raw em-dash (U+2014) preserved.
  * Self-check verifies the title byte sequence after writing.

Usage:
    python render_html.py <input.md> <output.html> [--site-url https://ai-morning-letter.vercel.app]
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from datetime import datetime, timezone

import markdown


# ----- constants ----------------------------------------------------------

TITLE_RE = re.compile(r"^#\s+AI Digest\s+\u2014\s+(\d{4}-\d{2}-\d{2})", re.MULTILINE)
KICKER_RE = re.compile(r"\[(MODEL|PRODUCT|RESEARCH|FUNDING|POLICY|SECURITY|TOOLING|OPEN-SOURCE)\]")
# New format: - **[KICKER] Headline.** body. Source: ...
# (one bold span wraps `[KICKER] Headline`, ending with `.**`)
STORY_HEAD_RE = re.compile(r"^- \*\*\[([A-Z-]+)\]\s+(.+?)\.\*\*\s*(.*)$")
# Legacy format: - **Headline.** body. Source: ...
LEGACY_STORY_HEAD_RE = re.compile(r"^- \*\*(.+?)\.\*\*\s*(.*)$")
COMING_UP_HEAD_RE = re.compile(r"^##\s+(Coming up.*)$", re.IGNORECASE)
WINDOW_RE = re.compile(r"window\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s*\u2192\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s*BRT", re.IGNORECASE)
STORIES_N_RE = re.compile(r"(\d+)\s+stor(?:y|ies)", re.IGNORECASE)
QUERIES_RE = re.compile(r"queries:\s*([^\n.]+)$", re.IGNORECASE | re.MULTILINE)
SOURCE_LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
SOURCE_PREFIX_RE = re.compile(r"\bsource:\s*", re.IGNORECASE)

EXPECTED_EM_DASH = "\u2014"

DEFAULT_SITE_URL = "https://ai-morning-letter.vercel.app"
ALLOWED_KICKERS = {"MODEL", "PRODUCT", "RESEARCH", "FUNDING", "POLICY", "SECURITY", "TOOLING", "OPEN-SOURCE"}

# Map raw category -> CSS data-cat value (already 1:1 with KICKER_RE).
def cat_value(k: str) -> str:
    return k


# ----- helpers ------------------------------------------------------------

def extract_date(md_text: str, fallback: str) -> str:
    m = TITLE_RE.search(md_text)
    if m:
        return m.group(1)
    return fallback


def strip_h1(md_text: str) -> str:
    """Drop the first H1 line (legacy `# AI Digest — DATE`) so the rendered
    template controls the title block."""
    return TITLE_RE.sub("", md_text, count=1)


def parse_meta_line(line: str) -> dict:
    """Pull n_stories, window, queries out of the *italic* meta line."""
    n_stories_m = STORIES_N_RE.search(line)
    n_stories = int(n_stories_m.group(1)) if n_stories_m else 0
    win_m = WINDOW_RE.search(line)
    window = ""
    if win_m:
        # "window <from-date> <from-time> → <to-date> <to-time> BRT"
        window = f"{win_m.group(1)} {win_m.group(2)} → {win_m.group(3)} {win_m.group(4)} BRT"
    qm = QUERIES_RE.search(line)
    queries: list[str] = []
    if qm:
        queries = [q.strip() for q in qm.group(1).split(",") if q.strip()]
    return {"n_stories": n_stories, "window": window, "queries": queries}


def parse_stories(md_text: str) -> list[dict]:
    """Walk lines, group each `- **[KICKER] ...` (modern) or `- **Headline.**`
    (legacy backfill) bullet — possibly multi-line — into a structured record.
    Legacy items get an inferred kicker based on keyword heuristics."""
    lines = md_text.split("\n")
    stories: list[dict] = []
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        kicker: str | None = None
        headline = ""
        body_full = ""

        m = STORY_HEAD_RE.match(line)
        if m:
            kicker = m.group(1)
            headline = m.group(2).strip()
            body_full = m.group(3).strip()
        else:
            m_legacy = LEGACY_STORY_HEAD_RE.match(line)
            if not m_legacy:
                i += 1
                continue
            headline = m_legacy.group(1).strip()
            body_full = m_legacy.group(2).strip()
            kicker = infer_kicker(headline + " " + body_full[:120])
        if not kicker:
            kicker = "MODEL"

        # Pull continuation lines until the next story, section header, or hr.
        j = i + 1
        while j < n:
            nxt = lines[j]
            if STORY_HEAD_RE.match(nxt) or LEGACY_STORY_HEAD_RE.match(nxt):
                break
            if COMING_UP_HEAD_RE.match(nxt):
                break
            if nxt.strip() == "---":
                break
            if nxt.startswith("#"):
                break
            body_full = (body_full + " " + nxt.strip()).strip()
            j += 1
        i = j

        # Split body and trailing "Source: a · b · c".
        body, sources = split_sources(body_full)
        source_links = parse_source_links(sources)
        headline = headline.rstrip(".").strip()
        stories.append(
            {
                "kicker": kicker if kicker in ALLOWED_KICKERS else "MODEL",
                "headline": headline,
                "body": body,
                "sources": source_links,
            }
        )
    return stories


def infer_kicker(text: str) -> str:
    """Heuristic kicker inference for legacy digests that predate the
    `[KICKER]` tag in source markdown. Returns one of the 8 categories."""
    t = text.lower()
    if any(k in t for k in ["open-source", "open source", "open weights", "open-weight", "open weights"]):
        return "OPEN-SOURCE"
    if any(k in t for k in ["raises $", "raised $", " series ", "series f", "series e", "series d", "valuation", " ipo ", "fund close", "fund-raise", " $", "fund ", "funds "]):
        return "FUNDING"
    if any(k in t for k in [" cve", "vulnerab", "exploit", "leak", "breach", "security", " pwn", " vuln", "attack"]):
        return "SECURITY"
    if any(k in t for k in ["arxiv", "paper", "benchmark", "leaderboard", "beating", "beats", "scores"]):
        return "RESEARCH"
    if any(k in t for k in [" law", "regulation", "policy", " ai act", " ai bill", "executive order", "government"]):
        return "POLICY"
    if any(k in t for k in ["launch", "ship", "ships", "release", "introduce", "introducing", "available", "deploy", "rollout"]):
        return "PRODUCT"
    if any(k in t for k in ["tool", "sdk", "ide", "vs code", "jetbrains", "xcode"]):
        return "TOOLING"
    return "MODEL"


def split_sources(body_full: str) -> tuple[str, str]:
    """Return (body_without_sources, sources_text). Sources begin at the LAST
    occurrence of 'Source:' on its own or after whitespace."""
    if not body_full:
        return "", ""
    # Find the last 'Source:' (case-insensitive) that introduces the link list.
    matches = list(SOURCE_PREFIX_RE.finditer(body_full))
    if not matches:
        return body_full.strip(), ""
    last = matches[-1]
    body = body_full[: last.start()].rstrip()
    sources = body_full[last.end():].strip()
    return body, sources


def parse_source_links(sources: str) -> list[tuple[str, str]]:
    """Return [(name, url), ...] from `Source: [a](url) · [b](url)`."""
    if not sources:
        return []
    out: list[tuple[str, str]] = []
    for m in SOURCE_LINK_RE.finditer(sources):
        name, url = m.group(1), m.group(2)
        # Skip empty / placeholder URLs (the markdown has [Microsoft AI](https://.microsoft.ai/...) — caught with `url.lstrip`. keep it.)
        out.append((name.strip(), url.strip()))
    return out


def parse_coming_up(md_text: str) -> list[dict]:
    """Parse the `## Coming up (next 48 h)` section into [{'when': 'Mon ...', 'text': '...'}]."""
    lines = md_text.split("\n")
    out: list[dict] = []
    in_section = False
    for raw in lines:
        if COMING_UP_HEAD_RE.match(raw):
            in_section = True
            continue
        if not in_section:
            continue
        if raw.strip() == "---":
            break
        if raw.startswith("#"):
            break
        if not raw.startswith("- "):
            continue
        item = raw[2:].strip()
        # Format: **Day YYYY-MM-DD** — text
        m = re.match(r"^\*\*([^*]+)\*\*\s*[\u2014\-]\s*(.+)$", item)
        if m:
            out.append({"when": m.group(1).strip(), "text": m.group(2).strip()})
        else:
            out.append({"when": "", "text": item})
    return out


def format_date_long(date: str) -> str:
    """Return `Mon 2026-07-27` style date label."""
    try:
        dt = datetime.strptime(date, "%Y-%m-%d")
    except ValueError:
        return date
    return dt.strftime("%a %Y-%m-%d")


def format_window(window: str) -> str:
    """Shorten `2026-07-26 06:00 → 2026-07-27 06:00 BRT` → `26 Jul → 27 Jul · 06:00 BRT`."""
    if not window:
        return ""
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}:\d{2})\s+\u2192\s+(\d{4})-(\d{2})-(\d{2})\s+(\d{2}:\d{2})\s+BRT$", window)
    if not m:
        return window
    from_date = f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    to_date = f"{m.group(5)}-{m.group(6)}-{m.group(7)}"
    return f"{_short_date(from_date)} \u2192 {_short_date(to_date)} \u00b7 {m.group(8)} BRT"


def _short_date(d: str) -> str:
    try:
        dt = datetime.strptime(d, "%Y-%m-%d")
        return dt.strftime("%d %b")
    except ValueError:
        return d


def _estimate_audio_duration(size_bytes: int, bitrate_kbps: int = 96) -> str:
    """Approximate the audio duration from the MP3 file size.

    Voxtral renders at 24 kHz mono; the encoded MP3 is 96 kbps. We use that
    as the basis so the label matches what the user will actually hear.
    The real duration is also embedded in the MP3 header but parsing it
    requires mutagen / ffprobe, so we approximate from size alone."""
    if size_bytes <= 0:
        return "?"
    seconds = (size_bytes * 8) / (bitrate_kbps * 1000)
    m, s = divmod(int(seconds + 0.5), 60)
    return f"{m}:{s:02d}"


# ----- HTML emitters ------------------------------------------------------

def render_story(s: dict) -> str:
    kicker = cat_value(s["kicker"])
    headline = escape_html(s["headline"])
    body_md = s["body"].strip()
    body_html = markdown.markdown(body_md, extensions=["sane_lists"], output_format="html5") if body_md else ""
    body_html = body_html.replace("<p>", "").replace("</p>", "")  # stories are paragraphless in card layout

    sources_html = ""
    if s["sources"]:
        items = "".join(
            f'<li><a href="{escape_html(url)}" rel="noopener" target="_blank">{escape_html(name)}</a></li>'
            for name, url in s["sources"]
        )
        sources_html = (
            '<p class="sources"><span class="sources-label">Source</span>'
            f'<ul class="sources-list">{items}</ul></p>'
        )

    return f"""<article class="story">
  <div class="story-head">
    <span class="kicker-pill" data-cat="{escape_html(kicker)}">{escape_html(kicker)}</span>
    <h3 class="story-headline">{headline}</h3>
  </div>
  <div class="story-body">{body_html}</div>
  {sources_html}
</article>
"""


def render_coming_up(items: list[dict]) -> str:
    if not items:
        return ""
    rows = "".join(
        f'<li><span class="when">{escape_html(it["when"])}</span> {escape_html(it["text"])}</li>'
        for it in items
    )
    return f'<section class="coming-up"><h2>Coming up · next 48 h</h2><ul>{rows}</ul></section>\n'


def render_meta_pills(meta: dict, date: str) -> str:
    pills: list[str] = []
    n_stories = meta.get("n_stories", 0)
    if n_stories:
        pills.append(f'<span class="meta-pill">{n_stories} stor{"y" if n_stories == 1 else "ies"}</span>')
    window = meta.get("window", "")
    if window:
        pills.append(f'<span class="meta-pill">Window · {escape_html(format_window(window))}</span>')
    queries = meta.get("queries", [])
    for q in queries[:3]:
        pills.append(f'<span class="meta-pill">⌕ {escape_html(q)}</span>')
    if not pills:
        return ""
    return f'<div class="meta-pills">{"".join(pills)}</div>\n'


def escape_html(s: str) -> str:
    return (
        str(s)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def make_html(date: str, meta: dict, stories: list[dict], coming_up: list[dict], site_url: str, audio_html: str = "") -> str:
    title = f"Morning Letter \u2014 {date}"
    canonical = f"{site_url.rstrip('/')}/d/{date}/"
    og_image = f"{site_url.rstrip('/')}/d/{date}/og.png"
    date_label = format_date_long(date)

    title_html = f"{escape_html(date_label)}"
    description_parts = []
    if meta.get("n_stories"):
        description_parts.append(f"{meta['n_stories']} stories")
    if meta.get("queries"):
        description_parts.append(", ".join(meta["queries"][:3]))
    description = " · ".join(description_parts) or f"AI Morning Letter for {date}."

    # First story's headline as social preview hint if available
    first_headline = stories[0]["headline"] if stories else ""
    og_description = (first_headline + ". " + description)[:240] if first_headline else description

    stories_html = "\n".join(render_story(s) for s in stories)
    coming_up_html = render_coming_up(coming_up)
    pills_html = render_meta_pills(meta, date)

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="{escape_html(description)}">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{escape_html(og_description)}">
<meta property="og:image" content="{og_image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:type" content="article">
<meta property="og:url" content="{canonical}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="{og_image}">
<meta name="twitter:title" content="{title}">
<meta name="twitter:description" content="{escape_html(og_description)}">
<meta name="theme-color" content="#c2410c">
<link rel="canonical" href="{canonical}">
<link rel="alternate icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='12' fill='%23c2410c'/%3E%3Ctext x='32' y='44' font-size='38' font-family='sans-serif' fill='white' text-anchor='middle' font-weight='bold'%3EM%3C/text%3E%3C/svg%3E">
<link rel="stylesheet" href="/static/styles.css">
</head>
<body>
<main class="container">
  <header class="masthead">
    <p class="brand"><a href="/">AI Morning Letter</a></p>
    <nav class="toplinks">
      <a href="/">Archive</a>
      <a class="current" href="/d/{date}/">{date_label}</a>
    </nav>
  </header>

  <section class="day-header">
    <p class="kicker">Morning Letter</p>
    <h1>Morning Letter — {date_label}</h1>
    <p class="lead">A daily morning note on what actually mattered in AI.</p>
    {pills_html}
  </section>

  {audio_html}

  <section class="stories" aria-label="Today's stories">
{stories_html}
  </section>

  {coming_up_html}

  <footer class="daily-footer">
    <p>← <a href="/">Back to the archive</a> · <a href="/today.html">latest</a> · <a href="{canonical}digest.md">raw markdown</a></p>
    <p style="margin-top:0.5rem">Generated each morning at 06:00 BRT.</p>
  </footer>
</main>
</body>
</html>
"""


# ----- entry point --------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input_md")
    parser.add_argument("output_html")
    parser.add_argument("--site-url", default=os.environ.get("SITE_URL", DEFAULT_SITE_URL))
    args = parser.parse_args()

    try:
        with open(args.input_md, "r", encoding="utf-8") as f:
            md_text = f.read()
    except FileNotFoundError:
        print(f"input not found: {args.input_md}", file=sys.stderr)
        return 2

    fallback_date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    date = extract_date(md_text, fallback_date)
    title = f"Morning Letter \u2014 {date}"

    # Meta line.
    meta_line_m = re.search(r"^\*([^\n]+)\*\s*$", md_text, re.MULTILINE)
    meta_line = meta_line_m.group(1) if meta_line_m else ""
    meta = parse_meta_line(meta_line) if meta_line else {"n_stories": 0, "window": "", "queries": []}

    # Stories + coming-up.
    cleaned = strip_h1(md_text)
    stories = parse_stories(cleaned)
    coming_up = parse_coming_up(cleaned)

    # Audio player — only if a podcast.mp3 sits next to the markdown. The
    # <audio> element is native HTML5 with `controls`; styling lives in
    # static/styles.css under `.podcast-card`. The mp3 is co-located with
    # digest.md and index.html in d/<DATE>/, so the relative URL is just
    # "podcast.mp3". File size is read for the label.
    audio_html = ""
    audio_path = os.path.join(os.path.dirname(os.path.abspath(args.input_md)), "podcast.mp3")
    if os.path.isfile(audio_path):
        size_bytes = os.path.getsize(audio_path)
        size_mb = size_bytes / (1024 * 1024)
        duration_label = _estimate_audio_duration(size_bytes)
        audio_html = (
            f'<section class="podcast-card" aria-label="Listen to this edition">\n'
            f'  <p class="podcast-kicker">🎙 Listen to today\'s letter</p>\n'
            f'  <audio class="podcast-player" controls preload="metadata" src="podcast.mp3"></audio>\n'
            f'  <p class="podcast-meta">Joe Rogan-style narration · ~{duration_label} · {size_mb:.1f} MB MP3</p>\n'
            f'</section>\n'
        )

    # Recompute n_stories from the parsed list if the meta line was missing.
    if not meta["n_stories"]:
        meta["n_stories"] = len(stories)

    html = make_html(date, meta, stories, coming_up, args.site_url, audio_html=audio_html)

    os.makedirs(os.path.dirname(os.path.abspath(args.output_html)), exist_ok=True)
    with open(args.output_html, "w", encoding="utf-8", newline="\n") as f:
        f.write(html)

    # Self-check: ensure the title (with em-dash) is byte-present in the file.
    with open(args.output_html, "rb") as f:
        raw = f.read()
    expected = title.encode("utf-8")
    if expected not in raw:
        print(
            f"Self-check FAILED: title sequence {expected!r} not found in output "
            f"(possible mojibake regression).",
            file=sys.stderr,
        )
        return 3
    if "\u2014".encode("utf-8") not in raw:
        print("Self-check WARNING: file contains no em-dash bytes (U+2014).", file=sys.stderr)
    print(
        f"rendered {args.output_html}: title={title!r} stories={len(stories)} "
        f"coming_up={len(coming_up)}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
