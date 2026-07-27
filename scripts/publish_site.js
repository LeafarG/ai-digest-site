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
const SITE_URL = process.env.SITE_URL || "https://ai-morning-letter.vercel.app";

const mdPath = path.join(SITE_ROOT, "d", DATE, "digest.md");
const htmlPath = path.join(SITE_ROOT, "d", DATE, "index.html");
const ogPath = path.join(SITE_ROOT, "d", DATE, "og.png");

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

function stripAnsi(s) {
  // Remove ANSI escape sequences (Vercel CLI uses [\u001b[2K[\u001b[1A ...]).
  return String(s || "").replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

// Brand alias — written by hand into publish_site.js so .last-deploy-url
// always carries the right canonical URL for the cron agent to read.
const PRIMARY_HOST = "ai-morning-letter.vercel.app";

function extractDeployInfo(output) {
  const raw = stripAnsi(output);
  const lines = raw.split(/\r?\n/);
  const aliasedSet = [];
  let production = null;
  let perDeploy = null;
  for (const rawLine of lines) {
    const line = stripAnsi(rawLine);
    let m;
    if ((m = line.match(/Aliased\s+(https?:\/\/\S+)/))) {
      aliasedSet.push(m[1].trim().replace(/\/$/, ""));
    } else if ((m = line.match(/Production\s+(https?:\/\/\S+)/))) {
      production = m[1].trim().replace(/\/$/, "");
    } else if ((m = line.match(/(https?:\/\/(?:ai-morning-letter|ai-digest-site)-[a-z0-9]+\.vercel\.app\/?)/))) {
      const url = m[1].trim().replace(/\/$/, "");
      if (url !== production) perDeploy = url;
    }
  }
  if (aliasedSet.length === 0 && !production && !perDeploy) {
    throw new Error("could not parse any Vercel URL from output");
  }
  // Priority for the cron agent's reply URL:
  //  1) The brand alias (PRIMARY_HOST) if Vercel attached it.
  //  2) Otherwise, the production URL.
  //  3) Otherwise, the per-deploy URL.
  let canonical = `https://${PRIMARY_HOST}`;
  if (!aliasedSet.includes(canonical)) {
    canonical = (production || perDeploy);
  }
  // First aliased URL is also reported for legacy tooling.
  const aliased = aliasedSet[0] || null;
  return { aliased, production, perDeploy, canonical, aliasedSet };
}

(async function main() {
  // 1) Render HTML
  run("render_html", "python", [
    path.join(SITE_ROOT, "scripts", "render_html.py"),
    mdPath,
    htmlPath,
  ]);

  // 1b) Render OG image (1200x630 PNG for social previews). Best-effort:
  // if Pillow isn't installed or the font is missing, log and continue.
  try {
    run("render_og", "python", [
      path.join(SITE_ROOT, "scripts", "render_og.py"),
      mdPath,
      ogPath,
      "--site-url",
      SITE_URL,
    ]);
  } catch (e) {
    console.warn("[publish_site] OG image render failed (continuing without): " + (e.message || e));
  }

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

  // 5) Re-anchor the brand alias. After a project rename, Vercel does NOT
  //    auto-attach the bare `ai-morning-letter.vercel.app` alias to new prod
  //    deploys (the old `ai-digest-site-pink.vercel.app` continues to flow
  //    through). We move the brand alias onto the latest production deploy
  //    so the cron agent's reply URL stays stable on the new host.
  const brandUrl = `https://${PRIMARY_HOST}`;
  const newDeployUrl = (extractDeployInfo(allOut).production || "").replace(/^https?:\/\//, "https://");
  // The "Inspect" URL points at the latest deployment but uses the bare ID;
  // the Vercel API needs the `dpl_XXX`-prefixed full UID. Resolve it via the
  // deployments list (find the deploy whose `url` matches the production line).
  let deployId = null;
  try {
    const { execFileSync } = require("child_process");
    const curlBin = process.platform === "win32" ? "curl.exe" : "curl";
    const tok = process.env.VERCEL_TOKEN || readToken();
    if (tok && newDeployUrl) {
      const out = execFileSync(curlBin, [
        "-sS", "-H", "Authorization: Bearer " + tok,
        "https://api.vercel.com/v6/deployments?projectId=prj_wCbATzb0PNXsdjKVzHuode9jfBeI&limit=5&teamId=team_eXXOxECFjvUEbTXratuOKotI&target=production",
      ], { encoding: "utf8" });
      const j = JSON.parse(out);
      const prodHost = newDeployUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
      const hit = (j.deployments || []).find((d) => (d.url || "").replace(/^https?:\/\//, "").replace(/\/$/, "") === prodHost);
      if (hit) deployId = hit.uid;
    }
  } catch (_) {}
  if (deployId) {
    ensureBrandAlias(deployId, brandUrl);
  } else {
    console.warn("[publish_site] could not resolve latest production deploy id; skipping brand-alias swap");
  }

  // 6) Parse the deploy URL(s) and emit a digest URL on the canonical alias.
  const info = extractDeployInfo(allOut);
  // If the bare alias is on this deploy now, prefer it; otherwise still use
  // PRIMARY_HOST as the cron agent's reply target (so the reply URL is the
  // brand host even if the live swap hasn't propagated yet).
  const canonical = `https://${PRIMARY_HOST}`;
  const digestUrl = canonical + "/d/" + DATE + "/";
  const lastUrlFile = path.join(SITE_ROOT, ".last-deploy-url");
  const lines = [
    "deploy=" + canonical,
    "digest=" + digestUrl,
    "date=" + DATE,
  ];
  if (newDeployUrl) lines.push("per_deploy=" + newDeployUrl);
  if (info.aliased) lines.push("alias=" + info.aliased);
  if (info.aliasedSet && info.aliasedSet.length > 0) {
    lines.push("aliases=" + info.aliasedSet.join(","));
  }
  lines.push("vercel_deploy=" + (deployId || "unknown"));
  fs.writeFileSync(lastUrlFile, lines.join("\r\n") + "\r\n", "utf8");
  console.log("[publish_site] OK");
  console.log("  canonical = " + canonical);
  console.log("  digest    = " + digestUrl);
  if (newDeployUrl) console.log("  per_deploy= " + newDeployUrl);
  if (deployId) console.log("  vercel_deploy= " + deployId);
  if (info.aliasedSet && info.aliasedSet.length > 1) {
    console.log("  aliasedSet= " + info.aliasedSet.join(","));
  }
})().catch((e) => {
  console.error("[publish_site] FAILED: " + (e && e.message ? e.message : e));
  process.exit(1);
});


// ---------- brand-alias swap -------------------------------------------

function readToken() {
  // Pull the Vercel CLI's OAuth token from its XDG config dir.
  const candidates = [];
  if (process.env.USERPROFILE) candidates.push(require("path").join(process.env.USERPROFILE, ".vercel", "auth.json"));
  if (process.env.HOME) candidates.push(require("path").join(process.env.HOME, ".vercel", "auth.json"));
  if (process.env.APPDATA) candidates.push(require("path").join(process.env.APPDATA, "xdg.data", "com.vercel.cli", "auth.json"));
  if (process.env.HOME) candidates.push(require("path").join(process.env.HOME, ".config", "com.vercel.cli", "auth.json"));
  for (const p of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      if (j && j.token) return j.token;
    } catch (_) {}
  }
  return "";
}

function ensureBrandAlias(newDeployId, brandUrl) {
  // 1) Read the project's deployment list (find any deploy currently
  //    holding the brand alias).
  const token = process.env.VERCEL_TOKEN || readToken();
  if (!token) {
    console.warn("[publish_site] no Vercel token; skipping brand-alias swap");
    return;
  }
  const teamId = "team_eXXOxECFjvUEbTXratuOKotI";
  const projectId = "prj_wCbATzb0PNXsdjKVzHuode9jfBeI";
  const aliasBase = brandUrl.replace(/^https?:\/\//, "");

  const { execFileSync } = require("child_process");
  // On Windows, PowerShell exposes `curl` as an alias for Invoke-WebRequest.
  // We MUST spawn the real curl.exe and pass JSON safely.
  const curlBin = process.platform === "win32" ? "curl.exe" : "curl";

  function curl(method, url, extraHeaders, body) {
    const args = [
      "-sS",
      "-X", method,
      "-H", "Authorization: Bearer " + token,
    ];
    if (extraHeaders) for (const h of extraHeaders) args.push("-H", h);
    if (body != null) args.push("--data-raw", body);
    args.push(url);
    const out = execFileSync(curlBin, args, { encoding: "utf8" });
    return out;
  }

  // 2) Find old deploys with the brand alias and remove it.
  let deployments = [];
  try {
    const res = JSON.parse(curl("GET", `https://api.vercel.com/v6/deployments?projectId=${projectId}&limit=15&teamId=${teamId}`));
    deployments = res.deployments || [];
  } catch (e) {
    console.warn("[publish_site] could not list deployments: " + (e.message || e));
    return;
  }
  for (const d of deployments) {
    if (d.uid === newDeployId) continue;
    try {
      const aRes = JSON.parse(curl("GET", `https://api.vercel.com/v1/deployments/${d.uid}/aliases?teamId=${teamId}`));
      for (const a of (aRes.aliases || [])) {
        if (a.alias === aliasBase) {
          console.log("[publish_site] removing stale brand alias from " + d.uid.slice(4, 16) + "...");
          try { curl("DELETE", `https://api.vercel.com/v2/aliases/${a.uid}`); } catch (_) {}
        }
      }
    } catch (_) {}
  }

  // 3) Attach brand alias to the new prod deploy (idempotent).
  try {
    console.log("[publish_site] attaching " + aliasBase + " to " + newDeployId.slice(4, 16) + "...");
    const body = JSON.stringify({ alias: aliasBase });
    const r = curl(
      "POST",
      `https://api.vercel.com/v2/deployments/${newDeployId}/aliases`,
      ["Content-Type: application/json"],
      body
    );
    let parsed;
    try { parsed = JSON.parse(r); } catch (_) { parsed = { raw: r }; }
    if (parsed.status === "SUCCESS" || parsed.alias) {
      console.log("  brand alias attached");
    } else {
      console.warn("  brand alias POST returned: " + r);
    }
  } catch (e) {
    console.warn("[publish_site] brand alias attach failed: " + (e.message || e));
  }
}
