# ai-morning-letter — SPEC

Static website that hosts the daily AI world digest ("AI Morning Letter") with one addressable page per day. Replaces the previous PDF-pushed Telegram delivery with a permanent, searchable, brand-hosted, Git-backed surface that updates every morning via cron → git commit → `vercel deploy --prod` → brand-alias swap.

## 1. Purpose

- **Surface:** a permanent Vercel-hosted website at the brand canonical alias [`https://ai-morning-letter.vercel.app/`](https://ai-morning-letter.vercel.app/).
- **Update cadence:** daily, 06:00 America/Sao_Paulo, automatic via the `daily-morning-letter-0600-brt` cron job.
- **Source of truth:** a Markdown file per day (`d/<YYYY-MM-DD>/digest.md`).
- **Telegram topic behavior:** a one-line `Today's Morning Letter is live: <url>` post replaces the previous long-form Markdown + PDF attachment. The deep content lives on the site; the topic exists for awareness.

## 2. Stack and topology

- **Pure static site.** No framework, no build step. Matches the existing pattern used by `projects/llm-presentation` and `projects/sp500-digest-site`.
- **Daily deploy:** `node scripts/publish_site.js --date <YYYY-MM-DD>` runs `vercel deploy --prod` from the working tree.
- **Git-backed secondary deploy:** push to `main` triggers a Vercel GitHub-App auto-deploy (link-API pattern). The cron-driven `publish_site.js` deploy is the canonical source of truth (it swaps the brand alias onto the new prod deploy).
- **Repository:** `LeafarG/ai-morning-letter` on GitHub (renamed from `LeafarG/ai-digest-site` on 2026-07-27). Visibility: **public** (the digest content is news, no credentials or PII; public also gives the boss a permanent, shareable URL).
- **Working tree:** `D:\.openclaw\workspace\projects\ai-digest-site\` (on-disk directory name kept for continuity even though the brand has changed).

## 3. Directory layout

```
.
├── index.html              # Archive landing (kicker filters + search + monthly card grid)
├── today.html              # Meta-refresh redirect to the latest edition
├── archive.json            # JSON manifest consumed by index.html
├── README.md               # Public-facing project doc
├── SPEC.md                 # This file — formal project spec
├── CHANGELOG.md            # Release history (Keep-a-Changelog format)
├── LICENSE                 # MIT
├── MEMORY.md               # Agent-side operational notes (internal)
├── .gitignore              # Python, Node, IDE, OS, env, secrets
├── .last-deploy-url        # Ephemeral handoff file (cron reads it for the reply URL)
│
├── d/
│   └── YYYY-MM-DD/
│       ├── digest.md       # Raw Markdown source
│       ├── index.html      # Rendered per-day page
│       └── og.png          # 1200 × 630 OG image (social previews)
│
├── static/
│   ├── styles.css          # Shared CSS (typography, layout, category palette, dark mode)
│   └── app.js              # Archive loader + kicker filters + search
│
└── scripts/
    ├── render_html.py      # Markdown → standalone HTML (UTF-8-clean, mojibake guard)
    ├── render_og.py        # Pillow-based 1200 × 630 PNG generator
    ├── rebuild_archive.js  # Emits archive.json + today.html from d/*/digest.md
    └── publish_site.js     # Daily orchestrator: render → OG → archive → commit → deploy → alias swap
```

## 4. Per-day content shape

Each `d/<YYYY-MM-DD>/digest.md` looks like:

```markdown
# Morning Letter — 2026-07-27

*8 stories · window 2026-07-26 06:00 → 2026-07-27 06:00 BRT · queries: q1, q2, q3.*

- **[MODEL] OpenAI ships GPT-5.6 "Sol" on Thursday...** Summary sentence. Source: [a](url) · [b](url2)
- **[PRODUCT] Meta's Superintelligence Labs launches Muse Image...** Summary. Source: [a](url)

## Coming up (next 48 h)

- **Mon 2026-07-27** — One sentence.
- **Tue 2026-07-28** — One sentence.

---
*Generated 2026-07-27 06:00 BRT by OpenClaw daily-morning-letter-0600-brt.*
```

The `**[KICKER]` tag is one of exactly eight values (case-sensitive, in brackets):

| Kicker | Hex | Use for |
|---|---|---|
| `MODEL` | `#4f46e5` indigo | base model release or major version |
| `PRODUCT` | `#7c3aed` violet | new product, SDK, GA release |
| `RESEARCH` | `#059669` emerald | paper, benchmark, novel training/eval method |
| `FUNDING` | `#d97706` amber | raise, M&A, fund close |
| `POLICY` | `#dc2626` red | regulation, executive order, compliance |
| `SECURITY` | `#ea580c` orange | vulnerability, leak, exploit, jailbreak |
| `TOOLING` | `#0891b2` cyan | IDE/copilot plugin, gateway, dev tooling |
| `OPEN-SOURCE` | `#0d9488` teal | notable open-weight release, HF trending |

Legacy digests without the `[KICKER]` tag (the 19 backfilled editions from 2026-07-08 to 2026-07-26) get a heuristic kicker inferred from keyword cues in the headline + body (`infer_kicker()` in `render_html.py`).

## 5. Daily pipeline

1. **Cron trigger.** `daily-morning-letter-0600-brt` (`0 6 * * *` in `America/Sao_Paulo`) wakes an isolated agent session.
2. **Research.** Agent uses `web_search` / `web_fetch` to find AI news from the last 24 h. Clusters 5–10 top stories.
3. **Compose.** Agent writes `d/<YYYY-MM-DD>/digest.md` (UTF-8, `[KICKER] Headline.**` bullets, sources as `[label](url)`).
4. **Publish.** Agent runs `node scripts/publish_site.js --date <YYYY-MM-DD>`. The script:
   1. `scripts/render_html.py` → `d/<date>/index.html` (UTF-8 clean, em-dash verified).
   2. `scripts/render_og.py` → `d/<date>/og.png` (1200 × 630 PNG).
   3. `scripts/rebuild_archive.js` → fresh `archive.json` + `today.html`.
   4. `git add -A && git commit -m "feat(digest): <date> edition"` (no push).
   5. `vercel deploy --prod --yes --scope leafargs-projects`.
   6. POST `ai-morning-letter.vercel.app` alias onto the new prod deploy; DELETE it from older prod deploys (Vercel doesn't auto-attach the bare alias after a project rename).
   7. Writes `.last-deploy-url` with `deploy=`, `digest=`, `date=`, `per_deploy=`, `aliases=`.
5. **Deliver.** Agent reads `.last-deploy-url`, replies with the `digest=` URL on a single line.

## 6. Mojibake guard

`render_html.py` enforces UTF-8 throughout. After writing each per-day HTML, it self-checks that the title byte sequence `Morning Letter \u2014 YYYY-MM-DD` is byte-present in the file. If it's missing, the script exits non-zero and the cron fails loudly.

This self-check caught the 2026-07-26 mojibake regression (the legacy renderer wrote `\u2014` as `?`); that edition is now re-rendered with em-dash bytes intact.

## 7. Alias plumbing

- **Canonical brand alias:** `https://ai-morning-letter.vercel.app/` (manually swapped onto the latest prod deploy after every publish by `publish_site.js ensureBrandAlias()`).
- **Legacy alias:** `https://ai-digest-site-pink.vercel.app/` (auto-attached to every prod deploy from the pre-rename project config; kept as a courtesy redirect).
- **Default per-deploy aliases:** `https://ai-morning-letter-<hash>-leafargs-projects.vercel.app/` and `https://ai-morning-letter-git-main-leafargs-projects.vercel.app/` (auto-generated by Vercel).

## 8. Out of scope (v2)

- Email newsletter, RSS, Twitter cross-post.
- Custom domain (`aimorningletter.com` etc.).
- Per-day OG image variant per kicker (currently one OG image per edition, first story as the lead).
- Tags / kicker-based browsing beyond the inline chip filters on the archive.
- Removing the legacy `ai-digest-site-pink.vercel.app` alias.
- The legacy `projects/ai-digest/digests/` PDF tree is kept for historical reference only.