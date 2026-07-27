# AI Morning Letter

> A daily morning note on what actually mattered in AI. Fresh every morning at 06:00 BRT, archived forever at **[ai-morning-letter.vercel.app](https://ai-morning-letter.vercel.app/)**.

AI Morning Letter is a fully automated daily digest of the most important AI news from the past 24 hours. A cron agent researches, edits, and publishes an editorialised edition (eight stories, ~700 words, 3–4 min read) to a permanent, searchable, brand-hosted static site.

This repository contains the site code, the publish pipeline, and the historical archive (one Markdown source + rendered HTML + OG image per day).

![Latest edition preview](https://ai-morning-letter.vercel.app/d/2026-07-27/og.png)

## What's in here

- **Twenty editions** of the digest, archived permanently (`d/2026-07-08/` … `d/2026-07-27/`).
- **Card-based story layout** with category-coloured kicker pills.
- **Per-day OG image** so links paste as a branded card in Telegram / Slack / Twitter.
- **Full archive** with monthly card grid, kicker-chip filters, and full-text search.
- **Dark-mode parity** and mobile-friendly responsive layout.
- **Mojibake guard** — em-dash (U+2014) byte-verified in every rendered title.

## Eight categories

Each story carries one category-coded kicker pill:

| | |
|---|---|
| **MODEL** — base model release or major version | indigo `#4f46e5` |
| **PRODUCT** — new product, SDK, GA release | violet `#7c3aed` |
| **RESEARCH** — paper, benchmark, novel training/eval method | emerald `#059669` |
| **FUNDING** — raise, M&A, fund close | amber `#d97706` |
| **POLICY** — regulation, executive order, compliance | red `#dc2626` |
| **SECURITY** — vulnerability, leak, exploit, jailbreak | orange `#ea580c` |
| **TOOLING** — IDE/copilot plugin, gateway, dev tooling | cyan `#0891b2` |
| **OPEN-SOURCE** — notable open-weight release, HF trending | teal `#0d9488` |

## Architecture

```
index.html         # Archive landing (monthly card grid, kicker filters, search box)
today.html         # Meta-refresh redirect to the latest edition
archive.json       # JSON manifest consumed by the front page

d/<YYYY-MM-DD>/
  digest.md        # Raw Markdown source
  index.html       # Rendered per-day page
  og.png           # 1200×630 OG image

static/
  styles.css       # Shared CSS, dark-mode-aware, category-coded kicker pills
  app.js           # Archive loader + kicker filters + search

scripts/
  render_html.py   # Markdown → standalone UTF-8 HTML
  render_og.py     # Pillow-based 1200×630 PNG OG generator
  rebuild_archive.js  # Emits archive.json + today.html
  publish_site.js  # Daily orchestrator (see pipeline below)
```

### Daily pipeline

```
06:00 BRT   cron wakes an isolated agent session
06:01       agent researches the last 24 h of AI news
06:05       agent writes d/<YYYY-MM-DD>/digest.md (UTF-8, [KICKER]-tagged bullets)
06:06       node scripts/publish_site.js --date <YYYY-MM-DD>:
              1. render_html.py   → d/<date>/index.html
              2. render_og.py     → d/<date>/og.png
              3. rebuild_archive.js → archive.json + today.html
              4. git commit (no push)
              5. vercel deploy --prod --yes --scope leafargs-projects
              6. POST brand alias onto the new prod deploy, DELETE it from older deploys
              7. write .last-deploy-url (handoff to the cron agent)
06:07       agent reads .last-deploy-url, replies in Telegram topic:
              Today's Morning Letter is live: https://ai-morning-letter.vercel.app/d/<YYYY-MM-DD>/
```

The `vercel deploy --prod` step gives us a per-deploy URL with a random hash (`ai-morning-letter-HASH-leafargs-projects.vercel.app`). The bare brand alias (`ai-morning-letter.vercel.app`) doesn't auto-attach after a Vercel project rename, so step 6 re-attaches it manually via the Vercel REST API after every publish.

## Stack

- **Static site, no framework.** Pure HTML + CSS + vanilla JS. ~14 KB CSS, ~6 KB JS, ~9 KB HTML per day.
- **Python 3** for `render_html.py` (uses `markdown` 3.10.2) and `render_og.py` (uses `Pillow` 12.3.0).
- **Node.js 24** for `rebuild_archive.js` and `publish_site.js` (uses `child_process` + `curl.exe`).
- **Vercel** hosting with the GitHub App linked (push to `main` also triggers auto-deploy; the daily deploy via `publish_site.js` is the canonical source of truth).
- **GitHub** at `LeafarG/ai-morning-letter` (renamed from `LeafarG/ai-digest-site` on 2026-07-27).

## Local development

```bash
# Render today's HTML from markdown
python scripts/render_html.py d/2026-07-27/digest.md d/2026-07-27/index.html

# Render the OG image
python scripts/render_og.py d/2026-07-27/digest.md d/2026-07-27/og.png

# Rebuild the archive manifest
node scripts/rebuild_archive.js

# Full publish (requires Vercel CLI auth + git remote)
node scripts/publish_site.js --date 2026-07-27
```

Python dependencies: `markdown`, `Pillow`. Install with:

```bash
pip install markdown Pillow
```

## Mojibake guard

The renderer enforces UTF-8 throughout. After writing each per-day HTML, `render_html.py` self-checks that the title byte sequence (with em-dash U+2014) is present in the file; if it's missing, the script exits non-zero and the cron fails loudly. This caught the 2026-07-26 mojibake regression that originally shipped with the site.

## Cron

The publishing cron is `daily-morning-letter-0600-brt` (job id `fdd91f98-4647-4437-a168-74c05199044d`, schedule `0 6 * * *` in `America/Sao_Paulo`). It runs in an isolated agent session and delivers a single-line URL to the Telegram topic after each successful publish. See `MEMORY.md` for the agent-side operational notes.

## License

MIT — see [LICENSE](./LICENSE).

## Author

Rafael Gomes — automated by the OpenClaw daily-morning-letter cron agent.