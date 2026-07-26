#!/usr/bin/env node
// rebuild_archive.js — scan d/*/digest.md, emit archive.json (UTF-8).

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DIGESTS = path.join(ROOT, "d");
const OUT = path.join(ROOT, "archive.json");

function extractDateFromHeader(text) {
  const m = text.match(/^#\s+AI Digest\s+\u2014\s+(\d{4}-\d{2}-\d{2})/m);
  return m ? m[1] : null;
}

function extractQueries(text) {
  const meta = text.match(/^\*([^\n]+)\*$/m);
  if (!meta) return [];
  const qm = meta[1].match(/queries:\s*([^\n]+)/i);
  if (!qm) return [];
  return qm[1].split(",").map((q) => q.trim()).filter(Boolean);
}

function extractFirstKicker(text) {
  const m = text.match(/\*\*\[(MODEL|PRODUCT|RESEARCH|FUNDING|POLICY|SECURITY|TOOLING|OPEN-SOURCE)\]/);
  return m ? "[" + m[1] + "]" : "";
}

function extractStories(text) {
  return (text.match(/^\s*-\s+\*\*\[(MODEL|PRODUCT|RESEARCH|FUNDING|POLICY|SECURITY|TOOLING|OPEN-SOURCE)\]/gm) || []).length;
}

function extractTitle(text, date) {
  const m = text.match(/^#\s+AI Digest\s+\u2014\s+\d{4}-\d{2}-\d{2}.*$/m);
  if (m) return m[0].replace(/^#\s+/, "").trim();
  return `AI Digest \u2014 ${date}`;
}

function extractDescription(text) {
  const m = text.match(/^\s*-\s+\*\*\[[^\]]+\]\s+\*\*([^\n.]+)/m);
  return m ? m[1].trim().slice(0, 160) : "";
}

function listDates() {
  if (!fs.existsSync(DIGESTS)) return [];
  return fs
    .readdirSync(DIGESTS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n))
    .sort()
    .reverse();
}

function main() {
  const dates = listDates();
  const items = [];
  for (const date of dates) {
    const mdPath = path.join(DIGESTS, date, "digest.md");
    if (!fs.existsSync(mdPath)) continue;
    const text = fs.readFileSync(mdPath, "utf8");
    const headerDate = extractDateFromHeader(text) || date;
    items.push({
      date: headerDate,
      title: extractTitle(text, headerDate),
      n_stories: extractStories(text),
      first_kicker: extractFirstKicker(text),
      queries: extractQueries(text),
      description: extractDescription(text),
      url: `/d/${headerDate}/`,
    });
  }
  fs.writeFileSync(OUT, JSON.stringify(items, null, 2) + "\n", "utf8");
  // Also refresh today.html to point at the newest entry.
  const todayPath = path.join(ROOT, "today.html");
  if (items.length > 0) {
    const latest = items[0].date;
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0; url=/d/${latest}/">
<title>Latest AI Digest \u2014 ${latest}</title>
<meta property="og:title" content="Latest AI Digest \u2014 ${latest}">
<meta property="og:url" content="https://ai-digest-site.vercel.app/d/${latest}/">
<link rel="canonical" href="/d/${latest}/">
</head>
<body>
<p>Redirecting to <a href="/d/${latest}/">today's digest (${latest})</a>\u2026</p>
</body>
</html>
`;
    fs.writeFileSync(todayPath, html, "utf8");
  }
  console.log(`archive.json: ${items.length} entries`);
  if (items.length > 0) console.log(`today.html \u2192 ${items[0].date}`);
}

main();
