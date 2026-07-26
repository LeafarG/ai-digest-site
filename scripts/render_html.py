#!/usr/bin/env python3
"""render_html.py — markdown → standalone UTF-8 HTML for ai-digest-site.

Reads a digest markdown file, converts it with python-markdown, and writes a
self-contained HTML document with a clean typographic shell. Designed to be
called both for backfill (one-shot imports) and on every cron run.

Anti-mojibake guarantees:
  * All reads/writes use explicit UTF-8 (encoding="utf-8").
  * <meta charset="utf-8"> is set.
  * Title is rendered with raw em-dash (U+2014) preserved from the source.
  * Self-check verifies the title byte sequence after writing.

Usage:
    python render_html.py <input.md> <output.html>
"""
from __future__ import annotations

import argparse
import re
import sys
from datetime import datetime, timezone

import markdown


# ----- constants ----------------------------------------------------------

TITLE_RE = re.compile(r"^#\s+AI Digest\s+\u2014\s+(\d{4}-\d{2}-\d{2})", re.MULTILINE)
KICKER_RE = re.compile(r"\[(MODEL|PRODUCT|RESEARCH|FUNDING|POLICY|SECURITY|TOOLING|OPEN-SOURCE)\]")
BULLET_RE = re.compile(r"^\s*-\s+\*\*", re.MULTILINE)
H1_DATE_FALLBACK_RE = re.compile(r"(\d{4}-\d{2}-\d{2})")
WINDOW_RE = re.compile(r"window\s+(\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}\s*\u2192\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s*BRT", re.IGNORECASE)

EXPECTED_EM_DASH = "\u2014"


# ----- helpers ------------------------------------------------------------

def extract_date(md_text: str, fallback: str) -> str:
    m = TITLE_RE.search(md_text)
    if m:
        return m.group(1)
    return fallback


def extract_title(md_text: str, date: str) -> str:
    return f"AI Digest {EXPECTED_EM_DASH} {date}"


def extract_meta(md_text: str) -> dict:
    """Pull window, story count, kicker list, queries."""
    m = re.search(r"^\*([^\n]+)\*\s*$", md_text, re.MULTILINE)
    meta_line = m.group(1) if m else ""
    n_stories = len(BULLET_RE.findall(md_text))
    kickers = KICKER_RE.findall(md_text)
    queries: list[str] = []
    qm = re.search(r"queries:\s*([^\n]+)$", meta_line, re.IGNORECASE | re.MULTILINE)
    if qm:
        queries = [q.strip() for q in qm.group(1).split(",") if q.strip()]
    window = WINDOW_RE.search(meta_line)
    window_str = ""
    if window:
        window_str = f"{window.group(1)} \u2192 {window.group(2)} {window.group(3)} BRT"
    first_kicker = kickers[0] if kickers else ""
    description = ""
    bm = re.search(r"^\s*-\s+\*\*\[[^\]]+\]\s+\*\*([^\n.]+)", md_text, re.MULTILINE)
    if bm:
        description = bm.group(1).strip()[:200]
    return {
        "meta_line": meta_line,
        "n_stories": n_stories,
        "kickers": kickers,
        "first_kicker": first_kicker,
        "queries": queries,
        "window": window_str,
        "description": description,
    }


def render_kickers_in_html(html: str) -> str:
    """Wrap each [KICKER] tag in a styled span."""
    return KICKER_RE.sub(
        lambda m: f'<span class="kicker">[{m.group(1)}]</span>',
        html,
    )


def make_html(md_text: str, date: str, meta: dict) -> str:
    title = extract_title(md_text, date)
    body_md = markdown.markdown(
        md_text,
        extensions=["extra", "smarty", "sane_lists"],
        output_format="html5",
    )
    body_html = render_kickers_in_html(body_md)
    description = meta["description"] or "Daily AI world digest for " + date + "."
    canonical = f"https://ai-digest-site.vercel.app/d/{date}/"

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="{description}">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{description}">
<meta property="og:type" content="article">
<meta property="og:url" content="{canonical}">
<meta name="twitter:card" content="summary">
<meta name="theme-color" content="#111827">
<link rel="canonical" href="{canonical}">
<link rel="stylesheet" href="/static/styles.css">
</head>
<body>
<main class="container">
  <header class="header">
    <p style="margin:0;font-size:0.85rem;color:var(--fg-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:600">AI Digest</p>
    <h1 style="margin-top:0.25rem">{title}</h1>
    <p class="lead">{meta['window'] or 'Daily digest'}{(' \u00b7 ' + str(meta['n_stories']) + ' stories') if meta['n_stories'] else ''}</p>
  </header>

  <article class="digest-body">
{body_html}
  </article>

  <footer class="footer">
    <p>\u2190 <a href="/">Back to the archive</a> \u00b7 <a href="/today.html">latest</a></p>
    <p style="margin-top:0.5rem">Generated automatically each morning at 06:00 BRT.</p>
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
    args = parser.parse_args()

    try:
        with open(args.input_md, "r", encoding="utf-8") as f:
            md_text = f.read()
    except FileNotFoundError:
        print(f"input not found: {args.input_md}", file=sys.stderr)
        return 2

    fallback_date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    date = extract_date(md_text, fallback_date)
    title = extract_title(md_text, date)
    meta = extract_meta(md_text)
    html = make_html(md_text, date, meta)

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
    if "\xe2\x80\x94".encode("utf-8") not in raw:
        print("Self-check WARNING: file contains no em-dash bytes (U+2014).", file=sys.stderr)
    print(f"rendered {args.output_html}: title={title!r} stories={meta['n_stories']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
