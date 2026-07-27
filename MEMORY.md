# ai-morning-letter — MEMORY

A Vercel-hosted static site that hosts the daily English AI world digest as an "AI Morning Letter" — one editorialised page per day. Rebuilt (visual + brand rename) on 2026-07-27 from the original `ai-digest-site`. Replaces the previous PDF-pushed Telegram delivery with a permanent, searchable, Git-backed surface that updates every morning via cron → git commit → `vercel deploy --prod` → brand-alias swap → auto-alias.

## Purpose and scope

- Surface the day's edition at a stable brand URL.
- Archive every edition permanently.
- Discover prior editions via search, date, kicker, or query.
- Source of truth: a Markdown file per day (`d/<YYYY-MM-DD>/digest.md`).
- Telegram topic behavior: **one-liner URL only**, no PDF, no body — the site is the primary surface.

## URLs (canonical aliases)

The canonical brand alias now resolves through Vercel to the latest production deploy. After each `publish_site.js` run we POST the brand alias onto the freshly minted prod deploy, so the cron agent's reply URL is always stable on the new host.

- **Site root / archive:** `https://ai-morning-letter.vercel.app/`
- **Today's edition:** `https://ai-morning-letter.vercel.app/d/YYYY-MM-DD/`
- **Raw Markdown:** `https://ai-morning-letter.vercel.app/d/YYYY-MM-DD/digest.md`
- **Manifest:** `https://ai-morning-letter.vercel.app/archive.json`

A legacy alias `https://ai-digest-site-pink.vercel.app/` is still attached as a courtesy redirect to the same project (Vercel auto-attaches it to every prod deploy — we don't delete it to avoid breaking bookmarks). Use only the brand alias going forward.

Do NOT use the bare `ai-digest-site.vercel.app/` — that hostname is held by an unrelated third-party Astro project. (Was relevant only on the previous project name.)

## Editorial design (v2, 2026-07-27)

- **Masthead** with "AI Morning Letter" brand and "Archive / Latest" links.
- **Day header**: branded kicker ("MORNING LETTER"), h1 with the date, lead sentence, and a row of meta pills (story count, window date range, top query).
- **Story cards**: each `- **[KICKER] Headline.**` bullet renders as a separate card with:
  - Category-colored kicker pill (MODEL=indigo, PRODUCT=violet, RESEARCH=emerald, FUNDING=amber, POLICY=red, SECURITY=orange, TOOLING=cyan, OPEN-SOURCE=teal).
  - Headline (sans-serif, bold).
  - Body paragraph (serif).
  - Source list as inline pills separated by middots.
- **Coming up** callout box with prefixed "DAY YYYY-MM-DD" labels.
- **Daily footer**: archive / latest / raw markdown links.
- **Archive (front page)**: monthly sections, each with a 2- or 3-column responsive card grid; live search box filters by date / kicker / headline / query. **Kicker-chip filter row** above the search box: 8 buttons (MODEL / PRODUCT / RESEARCH / FUNDING / POLICY / SECURITY / TOOLING / OPEN-SOURCE) with live counts per chip, click to toggle, multiple active = AND. `/` keypress focuses the search box (GitHub-style), `Esc` blurs.
- **Typography**: serif body (Iowan Old Style / Charter stack), sans-serif chrome (system-ui), wider reading column (760px), 18px base, 1.7 line-height.
- **Dark mode**: prefers-color-scheme parity; category colors retain readability on the dark surface.
- **Responsive**: collapses to single column under 600px.

## Stack

- Pure static site. No framework, no build step. Matches `projects/llm-presentation`.
- Git-backed deploy: `git push origin main` triggers an additional GitHub-Link auto-deploy; the **primary** daily deploy is `vercel deploy --prod` invoked from `publish_site.js`.
- Python 3 (`markdown` 3.10.2) for the per-day HTML renderer.
- Node.js (uses Node's built-in `child_process` + `node-fetch`-style direct curl calls) for `publish_site.js`, `rebuild_archive.js`, and the per-run brand-alias swap.

## Repository layout

| Path | Purpose |
|---|---|
| `index.html` | Archive page; loads `archive.json` via `/static/app.js` |
| `today.html` | Meta-refresh redirect to the latest edition |
| `archive.json` | Manifest consumed by the front page (date, title, kicker, queries, description) |
| `d/YYYY-MM-DD/index.html` | Per-edition rendered HTML |
| `d/YYYY-MM-DD/digest.md` | Raw Markdown source |
| `static/styles.css` | Shared CSS, dark-mode-aware, category-coded kicker pills |
| `static/app.js` | Archive loader + keyword search + monthly card grid |
| `scripts/render_html.py` | UTF-8-clean Markdown → standalone HTML (handles both `**[KICKER]**` new format and legacy `**Headline.**` digests with heuristic kicker inference). Injects `og:image` + `twitter:image` meta pointing at the per-day `og.png`. |
| `scripts/render_og.py` | Pillow-based 1200×630 PNG generator. Branded card: wordmark + date + kicker pill + first headline (wrapped) + N-more line + URL footer. Uses local Segoe UI / Arial with cross-platform fallbacks (Liberation / DejaVu on Linux). |
| `scripts/rebuild_archive.js` | Emits `archive.json` + `today.html` from `d/*/digest.md` |
| `scripts/publish_site.js` | The daily orchestrator: render → render OG → archive → commit → `vercel deploy --prod` → swap brand alias onto the new deploy → write `.last-deploy-url` |
| `.last-deploy-url` | Ephemeral handoff file consumed by the cron agent |

## Cron

- Job: `daily-morning-letter-0600-brt` (id `fdd91f98-4647-4437-a168-74c05199044d`; renamed from `daily-ai-digest-0600-brt` on 2026-07-27; same id, just a new name + payload)
- Schedule: `0 6 * * *` America/Sao_Paulo
- Session target: `isolated` (cron-runner spawns a fresh agent for each run)
- Delivery: announce to Telegram topic `-1003807014641:5529` (Jarvis / AI digest)
- Failure alert: same topic, after 2 consecutive misses, 24 h cooldown

The agent's prompt lives in the cron job payload (`cron get <jobId>`). Key facts after the 2026-07-27 rename:

- Reply must be **exactly one line**: `Today's Morning Letter is live: <url>` where `<url>` is the `digest=` value from `.last-deploy-url`.
- No `MEDIA:` directive. No body. No PDF.
- Output path: `D:\.openclaw\workspace\projects\ai-digest-site\d\<YYYY-MM-DD>\digest.md` (project dir name kept for on-disk continuity; only the public brand and GitHub repo name were renamed).
- The agent runs `node scripts\publish_site.js --date <YYYY-MM-DD>` after writing the digest.

## Daily pipeline

1. Cron triggers at 06:00 BRT in an isolated agent session.
2. Agent does research (≤ 7 min) and composes a digest Markdown with `**[KICKER] Headline.**` bullets.
3. Agent writes `d/<YYYY-MM-DD>/digest.md` (UTF-8).
4. Agent calls `node scripts/publish_site.js --date <YYYY-MM-DD>`:
   a. `scripts/render_html.py` → `d/<date>/index.html` (UTF-8 clean, em-dash preserved, branded H1).
   b. `scripts/rebuild_archive.js` → fresh `archive.json` + `today.html`.
   c. `git add -A && git commit -m "feat(digest): <date> edition"` (no push).
   d. `vercel deploy --prod --yes --scope leafargs-projects` (this still auto-attaches the project's legacy alias `ai-digest-site-pink.vercel.app`).
   e. POSTs the brand alias `ai-morning-letter.vercel.app` onto the freshly-deployed prod (using `curl.exe` against the Vercel API with the OAuth token read from `xdg.data/com.vercel.cli/auth.json`); deletes the brand alias from any older prod deployment.
   f. Writes `D:\.openclaw\workspace\projects\ai-digest-site\.last-deploy-url` with `deploy=` and `digest=` pointing at the brand host.
5. Agent reads `.last-deploy-url` and replies with `digest=` URL on a single line.

## Mojibake guard

The render script enforces UTF-8 and self-checks for the em-dash title byte sequence. If `Morning Letter — YYYY-MM-DD` is not byte-present in the output, the script exits non-zero and the cron fails loudly.

## Legacy `**Headline.**` digests

The 19 archived digests (2026-07-08 → 2026-07-26) predate the `[KICKER]` tag convention. The renderer detects both formats and uses a small keyword heuristic (`infer_kicker()`) to assign a category when the source uses the legacy form. The legacy digests render correctly with appropriate colored pills.

## Backfill

- Imported `projects/ai-digest/digests/*.md` (19 files, 2026-07-08 → 2026-07-26) into `d/<date>/`.
- All rendered with the new `render_html.py` (no mojibake, new card layout, heuristic kicker).
- Re-rendered 2026-07-27 with the new template.
- **OG image** (`d/<date>/og.png`, 1200×630, ~40KB each) generated for all 20 archived editions. Per-day `<head>` carries `og:image` + `og:image:width` + `og:image:height` + `twitter:image`. Social previews now render as branded cards in Telegram / Slack / Twitter.

## Verifications

- `curl -sI https://ai-morning-letter.vercel.app/` → 200.
- `curl -sI https://ai-morning-letter.vercel.app/d/2026-07-27/` → 200 with title `Morning Letter — 2026-07-27` (em-dash bytes E2 80 94 verified).
- `curl -s https://ai-morning-letter.vercel.app/archive.json` → 200, valid JSON, 20 entries.
- No `MEDIA:` line in the Telegram reply.

## Repo / hosting facts

- GitHub: `LeafarG/ai-morning-letter` (renamed from `LeafarG/ai-digest-site` on 2026-07-27 via REST `PATCH /repos/{owner}/{repo}`).
- Vercel project: `ai-morning-letter` under `leafargs-projects` scope (id `prj_wCbATzb0PNXsdjKVzHuode9jfBeI`; project renamed via REST `PATCH /v9/projects/{id}` on 2026-07-27).
- Brand alias: `https://ai-morning-letter.vercel.app` (manually attached to the latest prod deploy after each publish; brand alias is *not* a project-level setting that auto-flows to new prod deploys on the renamed project).
- Legacy alias: `https://ai-digest-site-pink.vercel.app` (auto-attached to every prod deploy from the pre-rename project config — kept as a courtesy redirect; identical content served).
- SSO protection disabled on the project (per MEMORY 2026-06-30).
- GitHub App installed on `LeafarG` → auto-deploy on push works (verified).
- Primary daily deploy is `vercel deploy --prod` from `publish_site.js`, not git auto-deploy (more reliable URL stability on this team).

## Toolchain

- Python: `markdown` 3.10.2
- Node: 24.14.1 (uses built-in `child_process`)
- curl.exe: invoked from Node via `child_process.execFileSync` (PowerShell's `curl` alias points at `Invoke-WebRequest`, so we must spawn `curl.exe` directly on Windows).
- Vercel CLI: 54.14.0 (path: `C:\Users\rafae\AppData\Roaming\npm\node_modules\vercel\dist\vc.js`)
- Git: authenticated via Git Credential Manager for `https://github.com`
- Vercel auth: OAuth stored at `C:\Users\rafae\AppData\Roaming\xdg.data\com.vercel.cli\auth.json`

## Out of scope (v2)

- Email newsletter, RSS, Twitter cross-post.
- Custom domain (`aimorningletter.com` etc.).
- Per-day OG image generation.
- Tags / kicker-based browsing beyond the single keyword search box.
- Replacing the legacy `projects/ai-digest/digests/` tree (kept for historical reference, no longer auto-generated).
- Removing `ai-digest-site-pink.vercel.app` legacy alias from project production auto-aliases (requires a one-time Vercel dashboard step or a manual `delete alias` for each prod deploy; kept in place to avoid breaking any active bookmarks).
