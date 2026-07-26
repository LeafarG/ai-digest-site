#!/usr/bin/env node
// publish_site.js — runs after the daily cron writes digest.md.
// Renders the per-day HTML, regenerates archive.json + today.html,
// runs `vercel deploy --prod`, and writes the deployed URL into
// .last-deploy-url for the cron agent to read.
//
// Usage:  node scripts/publish_site.js --date 2026-07-27

const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i === -1 || i + 1 >= process.argv.length) {
    console.error("missing required flag: " + name);
    process.exit(2);
  }
  return process.argv[i + 1];
}

const DATE = arg("--date");
const SITE_ROOT = path.resolve(__dirname, "..");
const VCJS =
  "C:\\Users\\rafae\\AppData\\Roaming\\npm\\node_modules\\vercel\\dist\\vc.js";

const mdPath = path.join(SITE_ROOT, "d", DATE, "digest.md");
const htmlPath = path.join(SITE_ROOT, "d", DATE, "index.html");

if (!fs.existsSync(mdPath)) {
  console.error("missing source: " + mdPath);
  process.exit(2);
}

function run(label, cmd, args, opts = {}) {
  console.log("[publish_site] " + label + ": " + cmd + " " + args.join(" "));
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd || SITE_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0 && !opts.tolerate) {
    throw new Error(label + " failed with exit " + r.status);
  }
  return r;
}

function extractDeployUrl(output) {
  const lines = String(output || "").split(/\r?\n/);
  let url = null;
  for (const line of lines) {
    const m = line.match(/^\s*Aliased\s+(https?:\/\/\S+)/);
    if (m) { url = m[1].trim(); break; }
  }
  if (!url) {
    for (const line of lines) {
      const m = line.match(/Production\s+(https?:\/\/\S+)/);
      if (m) { url = m[1].trim(); break; }
    }
  }
  if (!url) {
    for (const line of lines) {
      const m = line.match(/(https?:\/\/ai-digest-site[a-z0-9-]*\.vercel\.app\/?)/);
      if (m) {
        url = m[1].trim();
        if (!url.endsWith("/")) url += "/";
        break;
      }
    }
  }
  if (!url) throw new Error("could not parse Vercel deploy URL from output");
  return url;
}

(async function main() {
  // 1) Render HTML
  run("render_html", "python", [
    path.join(SITE_ROOT, "scripts", "render_html.py"),
    mdPath,
    htmlPath,
  ]);

  // 2) Rebuild archive.json + today.html
  run("rebuild_archive", "node", [
    path.join(SITE_ROOT, "scripts", "rebuild_archive.js"),
  ]);

  // 3) Git commit (no push — Vercel deploys from local state).
  try {
    execFileSync("git", ["config", "user.name", "openclaw-ai-digest"], { cwd: SITE_ROOT });
    execFileSync("git", ["config", "user.email", "ai-digest-bot@openclaw.local"], { cwd: SITE_ROOT });
  } catch (_) {}
  run("git add", "git", ["add", "-A"]);
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: SITE_ROOT, encoding: "utf8" });
  if (status.stdout && status.stdout.trim().length > 0) {
    run("git commit", "git", ["commit", "-m", "feat(digest): " + DATE + " edition"]);
  } else {
    console.log("[publish_site] no git changes to commit");
  }

  // 4) Deploy to Vercel production. Use spawnSync directly so we capture
  //    stdout+stderr cleanly.
  console.log("[publish_site] deploying to Vercel production");
  const d = spawnSync("node", [VCJS, "deploy", "--prod", "--yes", "--scope", "leafargs-projects"], {
    encoding: "utf8",
    cwd: SITE_ROOT,
  });
  const allOut = (d.stdout || "") + (d.stderr || "");
  process.stdout.write(allOut);
  if (d.status !== 0) {
    // Try to parse anyway — sometimes exit codes are misreported.
    console.error("[publish_site] vercel exited with status " + d.status + " (attempting to parse output)");
  }

  // 5) Parse the deploy URL and emit the digest URL.
  const deployUrl = extractDeployUrl(allOut).replace(/\/$/, "");
  const digestUrl = deployUrl + "/d/" + DATE + "/";
  const lastUrlFile = path.join(SITE_ROOT, ".last-deploy-url");
  const payload = "deploy=" + deployUrl + "\r\ndigest=" + digestUrl + "\r\ndate=" + DATE + "\r\n";
  fs.writeFileSync(lastUrlFile, payload, "utf8");
  console.log("[publish_site] OK");
  console.log("  deploy = " + deployUrl);
  console.log("  digest = " + digestUrl);
})().catch((e) => {
  console.error("[publish_site] FAILED: " + (e && e.message ? e.message : e));
  process.exit(1);
});
