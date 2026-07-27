# Changelog

All notable changes to AI Morning Letter are recorded here.

## [Unreleased]

- README.md, LICENSE, CHANGELOG added for repo hygiene.

## [2.0.0] — 2026-07-27

### Brand & repo rename
- GitHub repo `LeafarG/ai-digest-site` → **`LeafarG/ai-morning-letter`**.
- Vercel project `ai-digest-site` → **`ai-morning-letter`** (bare host now `https://ai-morning-letter.vercel.app/`).
- Cron job `daily-ai-digest-0600-brt` → **`daily-morning-letter-0600-brt`** (same id, new name + payload).
- Telegram reply: `Today's AI digest is live: <url>` → **`Today's Morning Letter is live: <url>`**.

### Editorial redesign
- Story cards with **category-coloured kicker pills** (MODEL / PRODUCT / RESEARCH / FUNDING / POLICY / SECURITY / TOOLING / OPEN-SOURCE).
- Serif body (Iowan Old Style stack), sans-serif chrome, 18 px / 1.7 / 760 px reading column.
- "Coming up" callout block on every per-day page.
- **Dark-mode parity** with category-coloured kicker pills retained.
- Mobile-friendly responsive layout (collapses to single column under 600 px).

### Archive
- **Monthly card grid** on the archive front page.
- **Kicker-chip filters** above the search box (click to toggle, multi-select = AND, live count per chip).
- Full-text search with `/` to focus, `Esc` to blur.
- Each card shows date, story count, kicker pill, two query pills, and the first-story headline.

### Per-day OG image
- New `scripts/render_og.py` (Pillow) renders a **1200 × 630 PNG** per edition.
- Card layout: AI Morning Letter wordmark + date + TOP STORY kicker pill (coloured by category) + first headline (auto-wrapped, auto-shrinks) + "N more stories inside" + URL footer.
- All 20 archived editions backfilled.
- `render_html.py` now emits `og:image` / `og:image:width` / `og:image:height` / `twitter:image` meta.

### Mojibake fix
- HTML `<title>` em-dash (U+2014) byte-verified after every render; previous mojibake regression caught by this self-check.

### Infrastructure
- `publish_site.js` now POSTs the bare brand alias to the new prod deploy after every publish (Vercel doesn't auto-attach the bare alias after a project rename). Old prod deploys get the alias removed.
- PowerShell's `curl` alias → `Invoke-WebRequest` is bypassed: scripts spawn `curl.exe` directly.

## [1.x] — 2026-07-26

- Initial public site (`ai-digest-site-pink.vercel.app`).
- 19 backfilled editions from the legacy `projects/ai-digest/digests/` PDF flow.
- Vercel auto-suffixing because the bare `ai-digest-site.vercel.app` was held by an unrelated Astro project.
- Cron: `daily-ai-digest-0600-brt` (06:00 BRT).
- Telegram delivery: PDF + one-liner URL.
- Mojibake in legacy HTML `<title>` (em-dash lost).

[2.0.0]: https://github.com/LeafarG/ai-morning-letter/releases/tag/v2.0.0
[1.x]: https://github.com/LeafarG/ai-morning-letter/releases/tag/v1.x