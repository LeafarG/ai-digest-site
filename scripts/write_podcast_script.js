#!/usr/bin/env node
// write_podcast_script.js — uses MiniMax-M3 to write a 2-host JRE-style
// podcast script for today's AI Morning Letter. Reads digest.md, calls the
// LLM, parses the response into [{speaker, text}] segments, writes
// podcast_script.json alongside digest.md. Falls back to deterministic
// buildNarration (via the parent render_podcast.js) if the LLM call fails.
//
// Usage: node write_podcast_script.js --date YYYY-MM-DD
// Or: set DATE env var.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const SITE_ROOT = "D:\\.openclaw\\workspace\\projects\\ai-digest-site";
const args = process.argv.slice(2);
let DATE = process.env.DATE;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--date" && args[i + 1]) { DATE = args[i + 1]; i++; }
}
if (!DATE) {
  console.error("[write_podcast_script] missing --date YYYY-MM-DD");
  process.exit(2);
}

const mdPath = path.join(SITE_ROOT, "d", DATE, "digest.md");
const outJson = path.join(SITE_ROOT, "d", DATE, "podcast_script.json");
const outTxt = path.join(SITE_ROOT, "d", DATE, "podcast_script.txt");

if (!fs.existsSync(mdPath)) {
  console.error(`[write_podcast_script] no digest.md at ${mdPath}`);
  process.exit(3);
}

const md = fs.readFileSync(mdPath, "utf8");

// ---------- Parse digest into a compact prompt payload ----------
const STORY_RE = /^- \*\*\[([A-Z-]+)\]\s+(.+?)\.\*\*\s*([\s\S]*?)(?=^- \*\*|^##\s+Coming|^---|\Z)/gm;
const COMING_UP_ITEM_RE = /^- \*\*([^*]+)\*\*\s*[—\-]\s*(.+)$/gm;

function trimBody(body) {
  // Drop trailing "Source: ..." block.
  const sourceRe = /\bsource:\s*/gi;
  const srcMatches = [...body.matchAll(sourceRe)];
  if (srcMatches.length > 0) body = body.slice(0, srcMatches[srcMatches.length - 1].index).trim();
  // Drop trailing markdown link labels (keep the visible text only).
  body = body.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // Drop markdown bold/italic markers.
  body = body.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1");
  // Drop em/en-dashes (TTS artefacts) — replace with comma.
  body = body.replace(/[—–]/g, ", ");
  // Drop quotation marks (TTS reads them as "quote ... end quote").
  body = body.replace(/[""'']/g, "");
  return body.split(/\n\n/)[0].trim();
}

const stories = [];
let m;
while ((m = STORY_RE.exec(md)) !== null) {
  stories.push({
    kicker: m[1],
    headline: m[2].trim().replace(/\.$/, ""),
    body: trimBody(m[3]),
  });
}
const comingUp = [];
let cm;
while ((cm = COMING_UP_ITEM_RE.exec(md)) !== null) {
  comingUp.push({ when: cm[1].trim(), text: trimBody(cm[2]) });
}

// Pretty date label.
const [y, mo, d] = DATE.split("-");
const dt = new Date(Date.UTC(+y, +mo - 1, +d));
const dateLabel = dt.toLocaleDateString("en-US", {
  weekday: "long", month: "long", day: "numeric", timeZone: "UTC",
});

// Build a compact digest payload for the prompt (saves tokens).
const digestPayload = [
  `Date: ${dateLabel}`,
  `Stories: ${stories.length}`,
  "",
  ...stories.map((s, i) =>
    `STORY ${i + 1} [${s.kicker}]\nHeadline: ${s.headline}\nBody: ${s.body}`
  ),
  "",
  "Coming up (next 48h):",
  ...comingUp.map((c, i) => `  ${i + 1}. ${c.when} — ${c.text}`),
].join("\n");

// ---------- System prompt ----------
const SYSTEM = `You write a 2-host podcast script for Voxtral TTS (text-to-speech synthesis). The script is read aloud by two distinct voices.

SPEAKERS
- JOE: JRE-style host. Energetic, curious, asks big-picture questions. Reacts with short lines like "Big deal", "That's wild", "Right", "Okay, next", "Watch this one".
- GUEST: measured analyst. Explains the substance of each story with context and "so what" analysis.

OUTPUT FORMAT — each turn on its own line, prefixed with [JOE] or [GUEST]. No blank lines between turns. Example:
[JOE] Hey what's up my friends. It's Wednesday July 29, 2026. Eight stories, all heavy hitters. Let's get into it.
[GUEST] Right, so first up, big policy news.
[JOE] Okay, this one's wild.
[GUEST] Right, so what happened is...
[JOE] Big deal.

TTS RULES (CRITICAL — the text is read aloud by a speech synthesizer)
- NEVER use hyphens as separators. They get read as "minus". Use commas or "and".
- NEVER use em-dashes (—) or en-dashes (–). Use commas or "and".
- NEVER use quotation marks anywhere. Drop them entirely.
- "US$ 1 B" → "one billion US dollars". "US$ 600 M" → "six hundred million US dollars".
- Percentages: "10%" → "ten percent". Multipliers: "3.7x" → "three point seven times".
- "1,100" → "eleven hundred". Drop thousands commas.
- "230M" / "8 K" → "two hundred thirty million" / "eight thousand".
- Decimals: "3.7" → "three point seven". "5.6" → "five point six".
- Dates: "2026-07-29" → "July 29, 2026".
- "AES-7" → "AES 7" or "AES seven". "post-quantum" → "post quantum".
- Use periods and commas for pacing. Never hyphens, em-dashes, or quotes anywhere in your output.
- Apostrophes in contractions are fine: "What's", "let's", "AI's".

STRUCTURE (target 10 to 12 minutes spoken, 1500 to 2200 words)
1. JOE: short intro, welcome, date, story count.
2. For each of the ${stories.length} stories:
   - JOE: reaction + kicker intro + headline (one to two sentences)
   - GUEST: explain the substance + why it matters (two to four sentences)
   - JOE: brief reaction (one short sentence)
3. JOE: "Coming up in the next forty eight hours."
4. GUEST: list the calendar items (one sentence each).
5. JOE: outro, sign off.

STYLE
- Conversational, natural cadence. Vary sentence length. Don't be repetitive.
- Don't read the digest verbatim — summarize and add color.
- Use the digest facts (numbers, names, dates) faithfully. Don't invent.
- Mix short punchy reactions with longer explanations.
- The Joe lines should feel like a real host; the Guest lines should feel like a thoughtful analyst.

OUTPUT ONLY THE SCRIPT. No markdown, no commentary, no preamble. Just the [JOE] and [GUEST] lines.`;

const USER = `Today's AI Morning Letter digest (${dateLabel}):

${digestPayload}

Write the 2-host podcast script now. Output ONLY [JOE] and [GUEST] lines — nothing else.`;

// ---------- Call M3 ----------
console.log(`[write_podcast_script] calling mmx (M3) for ${DATE} (${stories.length} stories)...`);
let raw;
try {
  // mmx is on PATH but Node's execFileSync can't find it directly. Use
  // the absolute path of the npm-shim cmd file.
  const { execSync } = require("child_process");
  const msgsFile = path.join(require("os").tmpdir(), `podcast-msgs-${Date.now()}.json`);
  fs.writeFileSync(msgsFile, JSON.stringify([
    { role: "system", content: SYSTEM },
    { role: "user", content: USER },
  ]), "utf8");
  // Invoke mmx via the npm-shim cmd. execSync (string mode) routes through
  // cmd.exe automatically and handles quoting properly.
  const mmxCmd = "C:\\Users\\rafae\\AppData\\Roaming\\npm\\mmx.cmd";
  const cmdStr = `"${mmxCmd}" text chat --messages-file "${msgsFile}" --model MiniMax-M3 --max-tokens 8000 --temperature 0.7 --output json --quiet --non-interactive`;
  raw = execSync(cmdStr, {
    encoding: "utf8",
    timeout: 5 * 60 * 1000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try { fs.unlinkSync(msgsFile); } catch (_) {}
} catch (e) {
  console.error(`[write_podcast_script] mmx call failed: ${(e.stderr || e.message || e).toString().slice(-400)}`);
  process.exit(4);
}

let content;
try {
  const json = JSON.parse(raw);
  // mmx JSON shape: { content: [{type:"text", text:"..."}], model, role, ... }
  if (Array.isArray(json.content)) {
    content = json.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  } else if (typeof json.content === "string") {
    content = json.content;
  } else {
    content = json.choices?.[0]?.message?.content
      ?? json.choices?.[0]?.text
      ?? json.text
      ?? "";
  }
  if (typeof content !== "string" || !content) {
    console.error("[write_podcast_script] unexpected JSON shape:", raw.slice(0, 400));
    process.exit(5);
  }
} catch (e) {
  // Not JSON — maybe the CLI returned plain text. Use it directly.
  content = raw;
}

// ---------- Parse [JOE]/[GUEST] lines ----------
const segments = [];
for (const line of content.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  const m = trimmed.match(/^\[(JOE|GUEST)\]\s*(.*)$/i);
  if (!m) continue;
  const speaker = m[1].toLowerCase() === "joe" ? "joe" : "guest";
  const text = m[2].trim();
  if (text) segments.push({ speaker, text });
}

if (segments.length === 0) {
  console.error("[write_podcast_script] no [JOE]/[GUEST] lines parsed from LLM output");
  console.error("--- raw content ---");
  console.error(content.slice(0, 1500));
  process.exit(6);
}

console.log(`[write_podcast_script] parsed ${segments.length} segments (joe=${segments.filter(s=>s.speaker==='joe').length}, guest=${segments.filter(s=>s.speaker==='guest').length})`);

// ---------- Write outputs ----------
fs.writeFileSync(outJson, JSON.stringify(segments, null, 2), "utf8");
const txtView = segments.map((s) => `[${s.speaker.toUpperCase()}] ${s.text}`).join("\n\n");
fs.writeFileSync(outTxt, txtView, "utf8");

console.log(`[write_podcast_script] wrote ${outJson}`);
console.log(`[write_podcast_script] wrote ${outTxt}`);

// Quality report.
const allText = segments.map((s) => s.text).join(" ");
const minusCount = (allText.match(/\s-\s|--|[—–]/g) || []).length;
const hyphenCount = (allText.match(/-/g) || []).length;
const quoteCount = (allText.match(/[""'']/g) || []).length;
const wordCount = allText.split(/\s+/).filter(Boolean).length;
console.log(`[write_podcast_script] quality: ${wordCount} words, ${hyphenCount} hyphens, ${quoteCount} quotes, ${segments.length} turns`);
if (minusCount > 0 || quoteCount > 0) {
  console.warn(`[write_podcast_script] WARNING: ${minusCount} minus-prone artefacts and ${quoteCount} quotes — TTS may sound robotic.`);
}