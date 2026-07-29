#!/usr/bin/env node
// render_podcast.js - generate a Joe Rogan-style narration audio for a digest.
//
// Usage:  node scripts/render_podcast.js --date 2026-07-29
//
// Pipeline:
//   1) Parse d/<DATE>/digest.md → stories + coming-up
//   2) Build a deterministic Joe Rogan-style narration script
//   3) Split at sentence boundaries into chunks <1500 chars
//   4) Render each chunk via WSL → bash → tts.sh → casual_female
//   5) Concatenate WAVs + convert to MP3 (96 kbps mono)
//   6) Drop the MP3 at d/<DATE>/podcast.mp3
//
// Graceful failure:
//   - Voxtral server down → tries to start it (cold start 2-5 min)
//   - Cold start times out (5 min) → log warning, exit 0 (no audio, no error)
//   - Render failure → log warning, exit 1 (publish_site.js continues without audio)
//
// The Joe Rogan transformation is deterministic (no LLM call) so the daily
// output is reproducible.  Variety comes from rotating intros/outros keyed
// off the index of each story.  Voice: casual_female (the only Voxtral
// voice validated for English on this build host).

const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i === -1 || i + 1 >= process.argv.length) {
    console.error("[render_podcast] missing required flag: " + name);
    process.exit(2);
  }
  return process.argv[i + 1];
}

const DATE = arg("--date");
const SITE_ROOT = path.resolve(__dirname, "..");
const mdPath = path.join(SITE_ROOT, "d", DATE, "digest.md");
const mp3Path = path.join(SITE_ROOT, "d", DATE, "podcast.mp3");

if (!fs.existsSync(mdPath)) {
  console.error("[render_podcast] missing source: " + mdPath);
  process.exit(2);
}

// Idempotency: if podcast.mp3 already exists and is newer than digest.md,
// skip the render. Useful when the cron re-runs the pipeline on the same
// day (e.g. after a transient Vercel failure) and avoids paying 5+ min of
// Voxtral compute for identical input.
if (fs.existsSync(mp3Path)) {
  const mdMtime = fs.statSync(mdPath).mtimeMs;
  const mp3Mtime = fs.statSync(mp3Path).mtimeMs;
  if (mp3Mtime >= mdMtime) {
    const sizeBytes = fs.statSync(mp3Path).size;
    console.log(`[render_podcast] ${mp3Path} is up-to-date (${(sizeBytes/1024/1024).toFixed(1)} MB); skipping render`);
    process.exit(0);
  }
}

// ---------- Voxtral server management -----------------------------------

const WSL_DISTRO = "Ubuntu";
const VOXTRAL_MODEL = "/mnt/d/.openclaw/workspace/projects/stats-learning/models/voxtral";
const VOXTRAL_VENV = "/root/voxtral-venv-py313/bin/vllm";
const VOXTRAL_LOG = "/root/voxtral_logs/server.log";
const VOXTRAL_URL = "http://localhost:8091";
const VOXTRAL_TTS_SCRIPT = "/mnt/d/.openclaw/workspace/skills/voxtral-tts/scripts/tts.sh";
const WSL_TMP = `/tmp/podcast_${DATE}`;
const WSL_FILENAME = `podcast.mp3`;

function wslBash(cmd) {
  // Run a single command inside the Ubuntu WSL distro and return stdout.
  const args = ["-d", WSL_DISTRO, "--", "bash", "-lc", cmd];
  return execFileSync("wsl.exe", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function wslBashStatus(cmd, timeoutMs = 0) {
  const args = ["-d", WSL_DISTRO, "--", "bash", "-lc", cmd];
  return spawnSync("wsl.exe", args, { encoding: "utf8", timeout: timeoutMs || undefined, stdio: ["ignore", "pipe", "pipe"] });
}

function voxtralHealthy() {
  try {
    const out = wslBash(`curl -s --max-time 3 ${VOXTRAL_URL}/v1/models`);
    return out && out.includes("object");
  } catch (_) {
    return false;
  }
}

function startVoxtral() {
  // Idempotent: if a vllm process is already running, do nothing.
  console.log("[render_podcast] starting Voxtral server (cold start 2-5 min)");
  try {
    wslBash(
      `pgrep -f 'vllm serve.*voxtral' >/dev/null 2>&1 && exit 0; ` +
      `nohup setsid ${VOXTRAL_VENV} serve ${VOXTRAL_MODEL} --omni --port 8091 --host 0.0.0.0 --enforce-eager > ${VOXTRAL_LOG} 2>&1 < /dev/null & disown; ` +
      `exit 0`
    );
  } catch (e) {
    console.warn("[render_podcast] could not spawn Voxtral start: " + (e.message || e));
    return false;
  }
  // Wait up to 5 min for /v1/models to respond.
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    if (voxtralHealthy()) {
      console.log("[render_podcast] Voxtral is up");
      return true;
    }
    execFileSync("wsl.exe", ["-d", WSL_DISTRO, "--", "bash", "-lc", "sleep 10"], { stdio: "ignore" });
  }
  console.warn("[render_podcast] Voxtral did not become healthy within 5 min");
  return false;
}

function ensureVoxtral() {
  if (voxtralHealthy()) return true;
  return startVoxtral();
}

// ---------- markdown parsing --------------------------------------------

const STORY_RE = /^- \*\*\[([A-Z-]+)\]\s+(.+?)\.\*\*\s*([\s\S]*?)(?=^- \*\*|^##\s+Coming|^---|\Z)/gm;
const COMING_UP_HEAD_RE = /^##\s+Coming up/m;
const COMING_UP_ITEM_RE = /^- \*\*([^*]+)\*\*\s*[—\-]\s*(.+)$/gm;
const SOURCE_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;

function parseDigest(md) {
  const stories = [];
  let m;
  while ((m = STORY_RE.exec(md)) !== null) {
    const kicker = m[1];
    const headline = m[2].trim();
    let body = m[3].trim();
    // Drop trailing source block. Sources can be inline (e.g. `... Microsoft. Source: [a](url) · [b](url)`)
    // or on their own line. Split at the last "Source:" marker (case-insensitive).
    const sourceRe = /\bsource:\s*/gi;
    const srcMatches = [...body.matchAll(sourceRe)];
    if (srcMatches.length > 0) {
      const lastSrc = srcMatches[srcMatches.length - 1];
      body = body.slice(0, lastSrc.index).trim();
    }
    // Trim to first paragraph to keep audio tight.
    const firstPara = body.split(/\n\n/)[0].trim();
    stories.push({ kicker, headline, body: firstPara });
  }
  const comingUp = [];
  let cm;
  while ((cm = COMING_UP_ITEM_RE.exec(md)) !== null) {
    comingUp.push({ when: cm[1].trim(), text: cm[2].trim() });
  }
  return { stories, comingUp };
}

// ---------- TTS pre-processor ------------------------------------------

// Goal: hand Voxtral text that reads naturally. The big wins:
//
//   * Hyphens → spaces (otherwise TTS reads "minus")
//   * Em-dashes / en-dashes → commas (otherwise silent gaps)
//   * Curly/straight quotes stripped (otherwise "quote ... end quote")
//   * Markdown bold/link syntax stripped
//   * Dates as words ("July 29, 2026" not "2026-07-29")
//   * "US$ 1 B" → "one billion US dollars" (currency expanded)
//   * "10%" → "ten percent", "3.7×" → "three point seven times"
//   * "1,100" → "1100" (no comma-pause from TTS)
//   * "230M" / "8 K" → "two hundred thirty million" / "eight thousand"
//   * Decimal points read as "point"
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function tts(text) {
  let out = text;

  // 1) Dates first (so hyphens in YYYY-MM-DD don't get touched below).
  out = out.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_m, y, mo, d) =>
    `${MONTHS[parseInt(mo, 10) - 1]} ${parseInt(d, 10)}, ${y}`);

  // 2) Em-dash / en-dash → comma (natural pause).
  out = out.replace(/[—–]/g, ", ");

  // 3) Double-hyphen → comma.
  out = out.replace(/--/g, ", ");

  // 4) Hyphen with whitespace on BOTH sides (clause separator) → comma.
  out = out.replace(/\s+-\s+/g, ", ");

  // 5) Hyphen between a letter and a digit (e.g., "AES-7" → "AES 7").
  out = out.replace(/([A-Za-z])-(\d)/g, "$1 $2");

  // 6) Markdown bold + italics + links.
  out = out.replace(/\*\*([^*]+)\*\*/g, "$1");
  out = out.replace(/\*([^*]+)\*/g, "$1");
  out = out.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

  // 7) Currency. "US$ 1 B" / "US$ 250 B" / "US$ 600 M" / "US$ 100 K".
  out = out.replace(/US\$\s*(\d+(?:\.\d+)?)\s*B(?:illion)?\b/gi, "$1 billion US dollars");
  out = out.replace(/US\$\s*(\d+(?:\.\d+)?)\s*M(?:illion)?\b/gi, "$1 million US dollars");
  out = out.replace(/US\$\s*(\d+(?:\.\d+)?)\s*K(?:,000)?\b/gi, "$1 thousand US dollars");
  out = out.replace(/US\$\s*(\d+(?:\.\d+)?)/g, "$1 US dollars");
  out = out.replace(/\$\s*(\d+(?:\.\d+)?)\s*B\b/g, "$1 billion dollars");
  out = out.replace(/\$\s*(\d+(?:\.\d+)?)\s*M\b/g, "$1 million dollars");
  out = out.replace(/\$\s*(\d+(?:\.\d+)?)\s*K\b/g, "$1 thousand dollars");

  // 8) Approx values.
  out = out.replace(/~(\d+(?:\.\d+)?)/g, "about $1");

  // 9) Percent / multiplier.
  out = out.replace(/(\d+(?:\.\d+)?)\s*%/g, "$1 percent");
  out = out.replace(/(\d+(?:\.\d+)?)\s*×/g, "$1 times");

  // 10) M-token / K-token patterns.
  out = out.replace(/(\d+)\s*M[\s-]*token/gi, "$1 million token");
  out = out.replace(/(\d+)\s*K[\s-]*token/gi, "$1 thousand token");

  // 11) Thousands-comma numbers (avoid TTS comma-pause).
  out = out.replace(/(\d),(\d{3})\b/g, "$1$2");

  // 12) Decimals → "point".
  out = out.replace(/(\d+)\.(\d+)/g, "$1 point $2");

  // 13) Energy / data units.
  out = out.replace(/(\d+(?:\.\d+)?)\s*GW\b/gi, "$1 gigawatt");
  out = out.replace(/(\d+(?:\.\d+)?)\s*MW\b/gi, "$1 megawatt");
  out = out.replace(/(\d+(?:\.\d+)?)\s*TB\b/gi, "$1 terabytes");
  out = out.replace(/(\d+(?:\.\d+)?)\s*GB\b/gi, "$1 gigabytes");

  // 13b) Compact / spaced unit suffixes. "230M" / "8 K" → spelled out.
  out = out.replace(/(\d+(?:\.\d+)?)\s*M\b/g, "$1 million");
  out = out.replace(/(\d+(?:\.\d+)?)\s*K\b/g, "$1 thousand");
  out = out.replace(/(\d+(?:\.\d+)?)\s*B\b/g, "$1 billion");

  // 14) Time tokens.
  out = out.replace(/(\d+(?:\.\d+)?)\s*hours?\b/gi, "$1 hours");

  // 15) Strip ALL quote marks (TTS reads "quote ... end quote" markers).
  out = out.replace(/[""'']/g, "");

  // 16) Convert any remaining hyphens to spaces (final safety net so TTS
  //     never reads "minus"). Compounds like "co-founders" → "co founders"
  //     and "non-human" → "non human" both sound natural.
  out = out.replace(/-/g, " ");

  // 17) Cleanup: duplicate commas + whitespace.
  out = out.replace(/\s+,/g, ",");
  out = out.replace(/,{2,}/g, ",");
  out = out.replace(/\s+\./g, ".");
  out = out.replace(/\s+/g, " ");
  out = out.trim();

  return out;
}

// ---------- Joe Rogan transformation ------------------------------------

const REACTIONS = [
  "Okay, this one's wild.",
  "Listen, this matters.",
  "Big one here.",
  "Here's the deal.",
  "So here's what happened.",
  "You need to know about this.",
  "This is significant.",
  "Okay, look.",
  "Right, so.",
  "Check this out.",
];

const KICKER_INTROS = {
  POLICY: ["Big policy move.", "Policy alert.", "Government angle.", "Big government story."],
  FUNDING: ["Funding alert.", "Money move.", "M and A news.", "Big money story."],
  SECURITY: ["Security story.", "Big security move.", "Cyber news.", "Security alert."],
  MODEL: ["Model drop.", "Big model release.", "New model alert.", "Frontier model stuff."],
  PRODUCT: ["Product launch.", "New product.", "Product update.", "Product news."],
  RESEARCH: ["Research paper.", "New study.", "Paper drop."],
  TOOLING: ["Developer tools.", "Dev tooling drop.", "Tools alert."],
  "OPEN-SOURCE": ["Open source release.", "Open weights news.", "OSS alert."],
};

const WHY_MATTERS = [
  "Big deal.",
  "Watch this one.",
  "That's the story.",
  "That's where we are.",
  "Keep your eye on this.",
  "That's how fast this is moving.",
  "That matters.",
  "Okay, next.",
];

const INTROS = [
  (d, n) => `What's up my friends. It's ${d}. ${n} stories, all heavy hitters, plus your upcoming calendar. Let's get into it.`,
  (d, n) => `Hey, welcome back. It's ${d}, and today's Morning Letter is stacked. ${n} stories for you. Let's dive in.`,
  (d, n) => `Good morning. It's ${d}. Big day in AI. ${n} stories. Let's go.`,
];

const OUTROS = [
  (d, n) => `That's the AI Morning Letter for ${d}. ${n} stories, one wild morning. If you enjoyed this, share it with someone. The more people who understand what's happening, the better. We'll see you tomorrow. Peace.`,
];

function pick(arr, i) { return arr[i % arr.length]; }

// ---------- 2-host JRE dialog -------------------------------------------

// Two voices alternate: Joe (host, energetic) opens each story with the
// framing + headline, then Guest (analyst, measured) walks through the
// substance of the body, then Joe closes with a quick reaction. Voices are
// dispatched per chunk by speaker tag.
const VOICE_BY_SPEAKER = {
  joe: "casual_male",
  guest: "neutral_male",
};

// Phrase banks for each speaker.
const JOE_FOLLOWUPS = [
  "Big deal.",
  "Watch this one.",
  "That's the story.",
  "That's where we are.",
  "Keep your eye on this.",
  "That matters.",
  "Okay, next.",
  "Right.",
  "Got it.",
];

const GUEST_OPENERS = [
  "Right, so look,",
  "Okay, so what's happening here,",
  "Let me explain.",
  "So here's the deal.",
  "Here's the read.",
  "Right,",
];

const GUEST_CLOSERS = [
  "That's the substance.",
  "So that's where it stands.",
  "And that's why it matters.",
  "Bottom line.",
  "That's the key.",
];

const JOE_INTROS = [
  (d, n) => `What's up my friends. It's ${d}. ${n} stories, all heavy hitters, plus your upcoming calendar. Let's get into it.`,
  (d, n) => `Hey, welcome back. It's ${d}, and today's Morning Letter is stacked. ${n} stories for you. Let's dive in.`,
  (d, n) => `Good morning. It's ${d}. Big day in AI. ${n} stories. Let's go.`,
];

const JOE_OUTROS = [
  (d, n) => `That's the AI Morning Letter for ${d}. ${n} stories, one wild morning. If you enjoyed this, share it with someone. The more people who understand what's happening, the better. We'll see you tomorrow. Peace.`,
];

function buildSegments(stories, comingUp, dateLabel) {
  const segments = [];

  // Joe intro.
  segments.push({ speaker: "joe", text: tts(pick(JOE_INTROS, 0)(dateLabel, stories.length)) });

  // Each story: Joe framing → Guest body → Joe reaction.
  stories.forEach((s, i) => {
    const reaction = pick(REACTIONS, i);
    const kickerIntro = pick(KICKER_INTROS[s.kicker] || KICKER_INTROS.MODEL, i);

    // Joe: opener + kicker intro + headline.
    segments.push({
      speaker: "joe",
      text: tts(`${reaction} ${kickerIntro} ${s.headline}.`),
    });

    // Guest: opener + body + closer.
    const gOpen = pick(GUEST_OPENERS, i);
    const gClose = pick(GUEST_CLOSERS, i + 2);
    segments.push({
      speaker: "guest",
      text: tts(`${gOpen} ${s.body} ${gClose}`),
    });

    // Joe: brief reaction / why-it-matters.
    segments.push({
      speaker: "joe",
      text: tts(pick(JOE_FOLLOWUPS, i + 3)),
    });
  });

  // Coming up.
  if (comingUp.length) {
    segments.push({
      speaker: "joe",
      text: tts("Coming up in the next forty eight hours."),
    });
    const cu = comingUp.map((it) => `${it.when}, ${it.text}`).join(". Then ");
    segments.push({
      speaker: "guest",
      text: tts(`${cu}. Big week ahead.`),
    });
  } else {
    segments.push({
      speaker: "joe",
      text: tts("That's the letter for today. We'll see you tomorrow."),
    });
  }

  // Joe outro.
  segments.push({
    speaker: "joe",
    text: tts(pick(JOE_OUTROS, 0)(dateLabel, stories.length)),
  });

  return segments;
}

// ---------- chunking -----------------------------------------------------

// Group consecutive same-speaker segments together, then split any oversized
// segment at sentence boundaries. Returns [{speaker, voice, text}, ...].
function flattenSegments(segments, maxChars = 1200) {
  const grouped = [];
  let buf = "";
  let bufSpeaker = null;
  for (const seg of segments) {
    if (bufSpeaker === seg.speaker && (buf.length + seg.text.length + 2) <= maxChars) {
      buf += " " + seg.text;
    } else {
      if (buf) grouped.push({ speaker: bufSpeaker, voice: VOICE_BY_SPEAKER[bufSpeaker], text: buf.trim() });
      buf = seg.text;
      bufSpeaker = seg.speaker;
    }
  }
  if (buf) grouped.push({ speaker: bufSpeaker, voice: VOICE_BY_SPEAKER[bufSpeaker], text: buf.trim() });

  // Split any chunk that's still too long at sentence boundaries (preserving speaker).
  const chunks = [];
  for (const g of grouped) {
    if (g.text.length <= maxChars) { chunks.push(g); continue; }
    const sentences = g.text.match(/[^.!?]+[.!?]+(?:\s+|$)/g) || [g.text];
    let subBuf = "";
    for (const s of sentences) {
      if (subBuf && (subBuf.length + s.length + 1) > maxChars) {
        chunks.push({ speaker: g.speaker, voice: g.voice, text: subBuf.trim() });
        subBuf = "";
      }
      subBuf = (subBuf + " " + s).trim();
    }
    if (subBuf) chunks.push({ speaker: g.speaker, voice: g.voice, text: subBuf.trim() });
  }
  return chunks;
}

// Legacy chunker — kept for backward compat with the single-voice path.
function chunkNarration(text, maxChars = 1300) {
  const paragraphs = text.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let buf = "";
  for (const p of paragraphs) {
    if (p.length > maxChars) {
      const sentences = p.match(/[^.!?]+[.!?]+(?:\s+|$)/g) || [p];
      for (const s of sentences) {
        if (buf && buf.length + s.length + 1 > maxChars) {
          chunks.push(buf.trim());
          buf = "";
        }
        buf = (buf + " " + s).trim();
      }
    } else if (buf && buf.length + p.length + 2 > maxChars) {
      chunks.push(buf.trim());
      buf = p;
    } else {
      buf = (buf + "\n\n" + p).trim();
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

// ---------- TTS rendering ------------------------------------------------

function renderChunks(narration) {
  // Two-host mode: narration is an array of {speaker, text} segments from
  // buildSegments(). Single-voice (legacy): narration is a plain string.
  const isTwoHost = Array.isArray(narration);
  const chunks = isTwoHost
    ? flattenSegments(narration, 1200)
    : chunkNarration(narration, 1300).map((text) => ({
        text,
        voice: process.env.PODCAST_VOICE || "casual_male",
        speaker: "joe",
      }));

  const totalChars = chunks.reduce((a, c) => a + c.text.length, 0);
  console.log(`[render_podcast] ${chunks.length} chunks, total ${totalChars} chars (${isTwoHost ? "2-host" : "single-voice"})`);

  // Stage chunks in a Windows-side staging dir under d/<DATE>/.podcast_chunks/
  // and read them from WSL via /mnt/d/. This avoids heredoc / shell-quoting
  // bugs that broke the original `cat > ... << EOF` approach.
  const stagingDir = path.join(SITE_ROOT, "d", DATE, ".podcast_chunks");
  fs.mkdirSync(stagingDir, { recursive: true });
  // Wipe any previous run.
  for (const f of fs.readdirSync(stagingDir)) {
    try { fs.unlinkSync(path.join(stagingDir, f)); } catch (_) {}
  }
  wslBash(`mkdir -p ${WSL_TMP} && rm -f ${WSL_TMP}/*.wav ${WSL_TMP}/*.txt ${WSL_TMP}/${WSL_FILENAME}`);

  const wslStaging = `/mnt/d/.openclaw/workspace/projects/ai-digest-site/d/${DATE}/.podcast_chunks`;
  const chunkFiles = [];
  for (let i = 0; i < chunks.length; i++) {
    const idx = i + 1;
    const txt = chunks[i].text;
    const voice = chunks[i].voice || process.env.PODCAST_VOICE || "casual_male";
    const speaker = chunks[i].speaker || "joe";
    const stagingTxt = path.join(stagingDir, `chunk_${idx}.txt`);
    const stagingWav = path.join(stagingDir, `chunk_${idx}.wav`);
    fs.writeFileSync(stagingTxt, txt, "utf8");
    console.log(`[render_podcast] chunk ${idx}/${chunks.length} (${txt.length} chars, voice=${voice}, speaker=${speaker})`);

    // Render via tts.sh reading from the WSL-visible staging dir.
    const r = wslBashStatus(
      `bash ${VOXTRAL_TTS_SCRIPT} '${wslStaging}/chunk_${idx}.txt' '${wslStaging}/chunk_${idx}.wav' ${voice} English`,
      8 * 60 * 1000  // 8-min safety cap per chunk
    );
    if (r.status !== 0) {
      throw new Error(`chunk ${idx} failed (exit ${r.status}): ${(r.stderr || r.stdout || "").slice(-400)}`);
    }
    // Check the file actually appeared on the Windows side.
    if (!fs.existsSync(stagingWav) || fs.statSync(stagingWav).size < 1000) {
      throw new Error(`chunk ${idx} produced no WAV (or too small) at ${stagingWav}`);
    }
    chunkFiles.push(`${wslStaging}/chunk_${idx}.wav`);
  }
  return chunkFiles;
}

function concatAndEncode(chunkFiles) {
  // Build a concat filelist and run ffmpeg inside WSL.
  const listPath = `${WSL_TMP}/filelist.txt`;
  const listContent = chunkFiles.map((f) => `file '${f}'`).join("\n") + "\n";
  wslBash(`printf '%s' '${listContent.replace(/'/g, "'\\''")}' > '${listPath}'`);

  const fullWav = `${WSL_TMP}/full.wav`;
  wslBash(`ffmpeg -y -f concat -safe 0 -i '${listPath}' -c copy '${fullWav}' >/dev/null 2>&1 && echo OK || echo FAIL`);
  wslBash(`ffmpeg -y -i '${fullWav}' -ac 1 -b:a 96k -codec:a libmp3lame '${WSL_TMP}/${WSL_FILENAME}' >/dev/null 2>&1 && echo OK || echo FAIL`);

  const stat = wslBash(`ls -la '${WSL_TMP}/${WSL_FILENAME}'`);
  console.log(`[render_podcast] mp3 ${stat.trim()}`);
  return `${WSL_TMP}/${WSL_FILENAME}`;
}

function copyToSite(wslMp3Path) {
  // Copy from WSL tmp into d/<DATE>/podcast.mp3 (visible to Vercel from Windows).
  const windowsTarget = mp3Path.replace(/\//g, "\\");
  // Use wsl.exe to invoke a copy via /mnt/d.
  const r = wslBashStatus(`cp '${wslMp3Path}' '/mnt/d/.openclaw/workspace/projects/ai-digest-site/d/${DATE}/podcast.mp3' && ls -la '/mnt/d/.openclaw/workspace/projects/ai-digest-site/d/${DATE}/podcast.mp3'`);
  if (r.status !== 0) {
    throw new Error("copy to site failed: " + (r.stderr || ""));
  }
  console.log(`[render_podcast] copied -> ${windowsTarget}`);
  return windowsTarget;
}

// ---------- entry --------------------------------------------------------

(async function main() {
  const md = fs.readFileSync(mdPath, "utf8");
  const { stories, comingUp } = parseDigest(md);
  if (stories.length === 0) {
    console.error("[render_podcast] no stories parsed from " + mdPath);
    process.exit(2);
  }
  console.log(`[render_podcast] parsed ${stories.length} stories, ${comingUp.length} coming-up items`);

  // Build narration. Order of preference:
  //   1. LLM-generated script (write_podcast_script.js) — natural dialog
  //   2. Deterministic 2-host generator (buildSegments) — fallback
  // Set PODCAST_FORCE_DETERMINISTIC=1 to skip the LLM call.
  const dateLabel = (() => {
    const [y, m, d] = DATE.split("-");
    const dt = new Date(Date.UTC(+y, +m - 1, +d));
    return dt.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
  })();
  const singleVoice = process.env.PODCAST_SINGLE_VOICE === "1";
  const forceDet = process.env.PODCAST_FORCE_DETERMINISTIC === "1";

  const jsonPath = path.join(SITE_ROOT, "d", DATE, "podcast_script.json");
  let narration;
  let usedLLM = false;

  if (!forceDet && !singleVoice && fs.existsSync(jsonPath)) {
    // Reuse cached LLM script if newer than the digest.
    const jsonMtime = fs.statSync(jsonPath).mtimeMs;
    const mdMtime = fs.statSync(mdPath).mtimeMs;
    if (jsonMtime >= mdMtime) {
      try {
        const cached = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
        if (Array.isArray(cached) && cached.length > 0 && cached[0].speaker) {
          narration = cached;
          usedLLM = true;
          console.log(`[render_podcast] reusing cached LLM script (${cached.length} segments)`);
        }
      } catch (_) { /* fall through */ }
    }
  }

  if (!usedLLM && !forceDet && !singleVoice) {
    // Run the LLM pass via write_podcast_script.js (separate process so
    // its mmx dependency is isolated).
    console.log("[render_podcast] invoking LLM (M3) to write script...");
    try {
      execFileSync("node", [
        path.join(SITE_ROOT, "scripts", "write_podcast_script.js"),
        "--date", DATE,
      ], { encoding: "utf8", timeout: 5 * 60 * 1000, stdio: ["ignore", "inherit", "inherit"] });
      const cached = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      if (Array.isArray(cached) && cached.length > 0) {
        narration = cached;
        usedLLM = true;
      }
    } catch (e) {
      console.warn(`[render_podcast] LLM script generation failed; falling back to deterministic. ${(e.stderr || e.message || "").toString().slice(-200)}`);
    }
  }

  if (!usedLLM) {
    // Deterministic fallback. buildSegments returns [{speaker, text}] —
    // for single-voice we just join the texts.
    const segs = buildSegments(stories, comingUp, dateLabel);
    narration = singleVoice ? segs.map((s) => s.text).join("\n\n") : segs;
    console.log(`[render_podcast] using deterministic generator (${segs.length} segments)`);
  } else {
    console.log(`[render_podcast] using LLM-generated script (${narration.length} segments)`);
  }

  // Save the script for debugging / re-use (LLM-tagged if from M3).
  const scriptText = Array.isArray(narration)
    ? narration.map((s) => `[${s.speaker.toUpperCase()}] ${s.text}`).join("\n\n")
    : narration;
  const scriptPath = path.join(SITE_ROOT, "d", DATE, "podcast_script.txt");
  fs.writeFileSync(scriptPath, scriptText, "utf8");
  console.log(`[render_podcast] script saved -> ${scriptPath}`);

  // Ensure Voxtral is up.
  if (!ensureVoxtral()) {
    console.warn("[render_podcast] Voxtral unavailable; skipping audio for " + DATE);
    process.exit(0);
  }

  try {
    const chunkFiles = renderChunks(narration);
    const mp3Wsl = concatAndEncode(chunkFiles);
    copyToSite(mp3Wsl);
    console.log(`[render_podcast] OK -> ${mp3Path}`);
  } catch (e) {
    console.warn("[render_podcast] render failed: " + (e.message || e));
    process.exit(1);
  }
})();