# ai-digest-site — SPEC

Static website that hosts the daily AI world digest with one addressable page per
day. Replaces the previous PDF-pushed Telegram delivery with a public, searchable,
Git-backed surface that updates every morning via cron → git push → Vercel auto-deploy.

## 1. Purpose

- Surface: a permanent Vercel-hosted website (`https://ai-digest.vercel.app`).
- Update cadence: daily, 06:00 America/Sao_Paulo, automatic.
- Source of truth: a Markdown file per day (`d/<YYYY-MM-DD>/digest.md`).
- Telegram topic behavior changes: a one-line "today's digest is live at <url>"
  post replaces the previous long-form Markdown + PDF attachment. The deep content
  lives on the site; the topic exists for awareness.

## 2. Stack and topology

- Pure static site. No framework, no build step. Matches the existing pattern
  used by `projects/llm-presentation`.
- Git-backed deploy: push to `main` → Vercel auto-deploys via the GitHub App
  (link-API pattern, per MEMORY 2026-07-07).
- Repository: `LeafarG/ai-digest-site` on GitHub. Visibility: **public** (the
  digest content is news, no credentials or PII; public also gives the boss a
  permanent, shareable URL). Local mirror:
  `D:\.openclaw\repos\ai-digest-site.git` (bare).
- Working tree: `D:\.openclaw\workspace\projects\ai-digest-site\`.

## 3. Directory layout

```
projects/ai-digest-site/                 # working tree (deployable)
├── .git/                                # linked to bare + GitHub remote
├── .gitignore                           # ignore .DS_Store, *.swp, __pycache__
├── README.md                            # what this is, link to live site
├── SPEC.md                              # this file
├── index.html                           # archive list (loads archive.json)
├── archive.json                         # manifest: [{date, title, n_stories, url}]
├── today.html                           # redirect → latest d/YYYY-MM-DD/
├── d/
│   └── YYYY-MM-DD/
│       ├── index.html                   # rendered, UTF-8-clean digest
│       └── digest.md                    # raw markdown source
├── static/
│   ├── styles.css                       # shared minimal CSS
│   └── app.js                           # loads archive.json and renders list
└── scripts/
    ├── render_html.py                   # markdown → standalone HTML (UTF-8)
    └── publish_site.ps1                 # cron-driven import + commit + push
```

## 4. Per-day page

Each `d/YYYY-MM-DD/index.html`:

- Single self-contained document with embedded CSS so it renders identically when
  shared as a URL preview (Slack, Telegram, etc.).
- Title tag: `AI Digest — YYYY-MM-DD` (em-dash U+2014, NOT a question mark).
- Open Graph: `og:title`, `og:description` (short excerpt of the lead story).
- Footer block: link to the archive (`← Back to the archive`) and to the next
  day's page if it exists; the date window (`window YYYY-MM-DD HH:MM →
  YYYY-MM-DD HH:MM BRT`); the source-link list.
- Sibling `digest.md` ships in the same folder for archival and copy/paste.

## 5. Front page

- `index.html` displays the title "AI Digest" plus a one-line description
  ("Daily AI world digest, fresh every morning at 06:00 BRT").
- On load, `static/app.js` fetches `archive.json` and renders a chronological
  list (newest first) of every digest with: date (link), title, story count,
  query names.
- A search box filters by date, title, or kicker (e.g. `[MODEL]`, `[FUNDING]`).
- The list also groups by month with `### July 2026` headings for long spans.

## 6. Daily pipeline (`daily-ai-digest-0600-brt`)

The cron is the single trigger. Steps the running agent will execute:

1. **Research** (≤ 7 min): existing prompt, unchanged. Produce `N` stories +
   "Coming up (next 48 h)" + footer.
2. **Save the Markdown**: write directly to
   `d/<YYYY-MM-DD>/digest.md` (not the old `projects/ai-digest/digests/`
   tree). The legacy tree becomes a static back-up of historical digests.
3. **Render HTML**: `python scripts/render_html.py d/<YYYY-MM-DD>/digest.md
   d/<YYYY-MM-DD>/index.html`. UTF-8 throughout; em-dash is preserved.
4. **Regenerate archive.json**: `node scripts/rebuild_archive.js` (reads
   every `d/*/digest.md`, emits `archive.json`). Bumps front of the list with
   today's entry.
5. **Refresh `today.html`**: simple `mv today.html today.html.prev ; echo
   '<meta http-equiv="refresh" content="0; url=d/YYYY-MM-DD/">' >
   today.html` (or an actual meta-refresh HTML stub). Keeps the URL stable
   for any Telegram/chat links that hard-code `/today.html`.
6. **Commit + push**: `git add . && git commit -m "feat(digest): YYYY-MM-DD
   edition" && git push origin main`. Vercel auto-deploys.
7. **Telegram topic reply**: ONE line of text only — no PDF attachment, no
   long body:
   `Today's AI digest is live: https://ai-digest.vercel.app/d/YYYY-MM-DD/`

The previous `md_to_pdf.py` PDF-rendering step is **removed**. PDFs are no
longer produced; the Vercel site supersedes them.

## 7. Render quality rules (anti-mojibake)

- `render_html.py` reads with explicit UTF-8 (`encoding='utf-8'` on `open()`),
  writes with explicit UTF-8 (`open(..., 'w', encoding='utf-8')`).
- All `<meta charset>` is set to `utf-8`.
- Title and any U+2014 em-dash strings are written as raw characters, never
  `?` or `&#8212;` substitutions.
- Self-test: after rendering, the script greps the produced HTML for the
  expected `AI Digest — YYYY-MM-DD` title; if the title byte sequence is not
  present, the script exits non-zero. This catches encoder regressions.

## 8. Backfill

- Read every `*.md` from `projects/ai-digest/digests/` (legacy tree).
- Render every one with `render_html.py` into `d/YYYY-MM-DD/index.html`.
- Copy the source `.md` to `d/YYYY-MM-DD>/digest.md`.
- Confirm each render is mojibake-free before adding to git.
- Generate initial `archive.json`. Sorted newest first.
- One squashed commit: `feat(site): backfill 19 archived digests (2026-07-08
  → 2026-07-26)`.

## 9. Vercel topology

- Project: `ai-digest-site` (URL: `https://ai-digest-site.vercel.app` if
  `ai-digest` is unavailable; verify first via `vercel project ls`).
- Production branch: `main`. Auto-deploy on push via the GitHub App on
  `LeafarG`. Per-project SSO protection disabled (per the 2026-06-30 MEMORY
  rule — preview URLs must be publicly readable).
- Custom domain: out of scope for v1. Default Vercel URL only.

## 10. Cron changes

- Existing cron `daily-ai-digest-0600-brt` prompt will be patched:
  - Output path: `projects/ai-digest/digests/YYYYMMDD_aidigest.md` →
    `projects/ai-digest-site/d/YYYY-MM-DD/digest.md`.
  - Add new steps 3-6 (render → archive → today.html → push) per §6.
  - Remove PDF render and MEDIA: attachment rules.
  - Topic reply is now step 7 only — one line with the URL, no body, no
    attachment.
- Timeout stays at 600 s. Measured last-duration was 344 s; new flow
  adds ≈ 10 s, still well within budget.
- Failure alert stays the same: 2 consecutive misses, 24 h cooldown, to the
  same topic.

## 11. Success criteria

1. `curl -sI https://ai-digest-site.vercel.app/` → `200`.
2. `curl -s https://ai-digest-site.vercel.app/archive.json` → valid JSON
   listing all digests.
3. `curl -s https://ai-digest-site.vercel.app/d/2026-07-26/` → `200`,
   page title contains `AI Digest — 2026-07-26` with a proper em-dash.
4. No mojibake in any rendered page (sampled manually + scripted).
5. Cron run (`cron run`) creates a new commit on `main` within 30 s and
   Vercel surfaces the new digest URL within 60 s.
6. Telegram topic receives a one-line post with the URL and no PDF.

## 12. Out of scope (v1)

- Email newsletter, RSS feed, Twitter cross-post.
- Custom domain (`aidigest.com` etc.).
- Per-day OG image generation.
- Search indexed by full-text client-side (a simple keyword filter suffices).
- Tags / kicker-based browsing beyond a single keyword search box.
