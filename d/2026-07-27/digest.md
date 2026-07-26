# AI Digest — 2026-07-27

*Test edition · window 2026-07-26 06:00 → 2026-07-27 06:00 BRT · queries: cron-flow simulation.*

This is a stub entry placed by the agent to validate the end-to-end cron → publish_site.js → Vercel pipeline. It will be replaced by the real digest on the next cron run.

- **[MODEL] Cron flow validated end-to-end.** The publish pipeline (render HTML, rebuild archive, commit, deploy) ran successfully for `2026-07-27`, demonstrating that the live Vercel alias serves today's URL within seconds. Source: [ai-digest-site.vercel.app](https://ai-digest-site-pink.vercel.app/)
- **[TOOLING] New `publish_site.js` orchestrator.** Replaces per-call PDF and inline Markdown tooling with a single Node script that owns render → archive → commit → Vercel. Source: [GitHub](https://github.com/LeafarG/ai-digest-site)

## Coming up (next 48 h)

- **Mon 2026-07-27** — Real cron-run publishes today's actual digest at 06:00 BRT.
- **Tue 2026-07-28** — First full Monday-morning automated run is the true test of the new pipeline.

---
*Generated 2026-07-26 17:30 BRT by OpenClaw daily-ai-digest-0600-brt (test-only stub).*
