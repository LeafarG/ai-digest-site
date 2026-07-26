# ai-digest-site — MEMORY

A Vercel-hosted static site that hosts the daily English AI world digest, one page per day. Replaces the previous PDF-pushed Telegram delivery with a permanent, searchable, Git-backed surface that updates every morning via cron → git commit → `vercel deploy --prod` → auto-alias.

## Purpose and scope

- Surface the day's digest at a stable URL.
- Archive every day's digest permanently.
- Discover prior digests via search, date, kicker, or query.
- Source of truth: a Markdown file per day (`d/<YYYY-MM-DD>/digest.md`).
- Telegram topic behavior: **one-liner URL only**, no PDF, no body — the site is the primary surface.

## URLs (canonical aliases)

The `vercel deploy --prod` flow re-aliases the project every run. Current production:

- **Site root / archive:** `https://ai-digest-site-pink.vercel.app/`
- **Today's digest:** `https://ai-digest-site-pink.vercel.app/d/YYYY-MM-DD/`
- **Raw Markdown:** `https://ai-digest-site-pink.vercel.app/d/YYYY-MM-DD/digest.md`
- **Manifest:** `https://ai-digest-site-pink.vercel.app/archive.json`

Do NOT use `https://ai-digest-site.vercel.app/` — that hostname is held by an unrelated third-party Astro project; Vercel's CLI auto-suffixes ours to `-pink` (or another colored suffix if `-pink` is reclaimed later).

## Stack

- Pure static site. No framework, no build step. Matches `projects/llm-presentation`.
- Git-backed deploy: `git push origin main` triggers an additional GitHub-Link auto-deploy; the **primary** daily deploy is `vercel deploy --prod` invoked from `publish_site.js`.
- Python 3 (`markdown` 3.10.2) for the per-day HTML renderer.
- Node.js (uses Node's built-in `child_process`) for `publish_site.js` and `rebuild_archive.js`.

## Repository layout

| Path | Purpose |
|---|---|
| `index.html` | Archive page; loads `archive.json` via `/static/app.js` |
| `today.html` | Meta-refresh redirect to the latest day |
| `archive.json` | Manifest consumed by the front page (date, title, kicker, queries) |
| `d/YYYY-MM-DD/index.html` | Per-day rendered HTML |
| `d/YYYY-MM-DD/digest.md` | Raw Markdown source |
| `static/styles.css` | Shared CSS, dark-mode-aware |
| `static/app.js` | Archive loader + keyword search |
| `scripts/render_html.py` | UTF-8-clean Markdown → standalone HTML |
| `scripts/rebuild_archive.js` | Emits `archive.json` + `today.html` from `d/*/digest.md` |
| `scripts/publish_site.js` | The daily orchestrator: render → archive → commit → vercel deploy --prod → write `.last-deploy-url` |
| `.last-deploy-url` | Ephemeral handoff file consumed by the cron agent |

## Cron

- Job: `daily-ai-digest-0600-brt` (id `fdd91f98-4647-4437-a168-74c05199044d`)
- Schedule: `0 6 * * *` America/Sao_Paulo
- Session target: `isolated` (cron-runner spawns a fresh agent for each run)
- Delivery: announce to Telegram topic `-1003807014641:5529` (Jarvis / AI digest)
- Failure alert: same topic, after 2 consecutive misses, 24 h cooldown

The agent's prompt now lives in the cron job payload (`cron get <jobId>`). Key facts:

- Reply must be **exactly one line**: `Today's AI digest is live: <url>` where `<url>` is the `digest=` value from `.last-deploy-url`.
- No `MEDIA:` directive. No body. No PDF.
- Output path: `D:\.openclaw\workspace\projects\ai-digest-site\d\<YYYY-MM-DD>\digest.md`.
- The agent runs `node scripts\publish_site.js --date <YYYY-MM-DD>` after writing the digest.

## Daily pipeline

1. Cron triggers at 06:00 BRT in an isolated agent session.
2. Agent does research (≤ 7 min) and composes a digest Markdown.
3. Agent writes `d/<YYYY-MM-DD>/digest.md` (UTF-8).
4. Agent calls `node scripts/publish_site.js --date <YYYY-MM-DD>`:
   a. `scripts/render_html.py` → `d/<date>/index.html` (UTF-8 clean, em-dash preserved).
   b. `scripts/rebuild_archive.js` → fresh `archive.json` + `today.html`.
   c. `git add -A && git commit -m "feat(digest): <date> edition"` (no push).
   d. `vercel deploy --prod --yes --scope leafargs-projects` (auto-aliases to `-pink.vercel.app`).
   e. Writes `D:\.openclaw\workspace\projects\ai-digest-site\.last-deploy-url`.
5. Agent reads `.last-deploy-url` and replies with the digest= URL on a single line.

## Moijibake guard

The render script enforces UTF-8 and self-checks for the em-dash title byte sequence. If `AI Digest — YYYY-MM-DD` is not byte-present in the output, the script exits non-zero and the cron fails loudly.

The legacy `md_to_pdf.py` had a known mojibake bug in `<title>` (em-dash was rendered as `?"`). That script is preserved for the legacy archive but is no longer invoked by the cron.

## Backfill (one-time, completed 2026-07-26)

- Imported `projects/ai-digest/digests/*.md` (19 files, 2026-07-08 → 2026-07-26) into `d/<date>/`.
- All rendered with the new `render_html.py` (no mojibake).
- Initial commit `f52c006`.

## Verifications

- `curl -sI https://ai-digest-site-pink.vercel.app/` → 200 with `text/html`.
- `curl -s https://ai-digest-site-pink.vercel.app/archive.json` → 200, valid JSON, 19+ entries.
- `curl -s https://ai-digest-site-pink.vercel.app/d/2026-07-26/` → 200, title contains `AI Digest — 2026-07-26` with proper em-dash bytes (`E2 80 94`).
- No `MEDIA:` line in the Telegram reply.

## Repo / hosting facts

- GitHub: `LeafarG/ai-digest-site` (public).
- Vercel project: `ai-digest-site` under `leafargs-projects` scope (id `prj_wCbATzb0PNXsdjKVzHuode9jfBeI`).
- SSO protection disabled on the project (per MEMORY 2026-06-30).
- GitHub App installed on `LeafarG` → auto-deploy on push works (verified).
- Primary daily deploy is `vercel deploy --prod` from `publish_site.js`, not git auto-deploy (more reliable URL stability on this team).

## Toolchain

- Python: `markdown` 3.10.2
- Node: 24.14.1 (uses built-in `child_process`)
- Vercel CLI: 54.14.0 (path: `C:\Users\rafae\AppData\Roaming\npm\node_modules\vercel\dist\vc.js`)
- Git: authenticated via Git Credential Manager for `https://github.com`
- Vercel auth: OAuth stored globally; cron-runner inherits it

## Out of scope (v1)

- Email newsletter, RSS, Twitter cross-post.
- Custom domain (`aidigest.com` etc.).
- Per-day OG image generation.
- Tags / kicker-based browsing beyond the single keyword search box.
- Replacing the legacy `projects/ai-digest/digests/` tree (kept for historical reference, no longer auto-generated).
