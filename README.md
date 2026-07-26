# AI Digest — daily site

A daily English digest of the AI world, refreshed automatically every morning at 06:00 BRT.

Read it at <https://ai-digest-site.vercel.app/>.

## Structure

- `d/YYYY-MM-DD/index.html` — rendered digest for that day.
- `d/YYYY-MM-DD/digest.md` — raw markdown source.
- `archive.json` — manifest of every digest; consumed by the front page.
- `index.html` — front page (loads `archive.json`).
- `static/` — shared CSS and JS.
- `scripts/render_html.py` — markdown → standalone HTML renderer (UTF-8 clean).
- `scripts/rebuild_archive.js` — rebuilds `archive.json` from `d/*/digest.md`.

## Local run

```bash
python scripts/render_html.py d/2026-07-26/digest.md d/2026-07-26/index.html
node scripts/rebuild_archive.js
```

Open `index.html` in a browser. No build step.

## Deploy

`git push origin main` triggers a Vercel auto-deploy via the GitHub App.

Production URL: `https://ai-digest-site.vercel.app/`
