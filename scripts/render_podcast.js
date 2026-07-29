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
const COMING_UP_ITEM_RE = /^- \*\*([^*]+)\*\*\s*[-\-]\s*(.+)$/gm;
const SOURCE_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;

function parseDigest(md) {
  const stories = [];
  let m;
  while ((m = STORY_RE.exec(md)) !== null) {
    const kicker = m[1];
    const headline = m[2].trim();
    let body = m[3].trim();
    // Drop trailing source block ("Source: ...")
    const sourceMatch = body.match(/\n+Source:\s*([\s\S]+?)(?:\n\n|\n*$)/);
    if (sourceMatch) body = body.slice(0, sourceMatch.index).trim();
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

// ---------- Joe Rogan transformation ------------------------------------

const STORY_INTROS = [
  "First up - and this is a big one -",
  "Okay, so -",
  "All right, so -",
  "Listen -",
  "Right, so -",
  "Dude -",
  "Check this out -",
  "Okay so -",
  "And this one's wild -",
  "Here we go -",
];

const KICKER_INTROS = {
  POLICY: ["Big policy move.", "Okay, policy alert.", "Listen, this is a big policy thing.", "Policy news.", "Big government story."],
  FUNDING: ["Funding alert.", "Big money move.", "Okay, this is money.", "Money news.", "M&A alert."],
  SECURITY: ["Big security move.", "Security stuff.", "Okay, this is wild, security.", "Cyber news.", "Security alert."],
  MODEL: ["Okay, model news.", "Big model release.", "New model alert.", "Model drop.", "Frontier-model stuff."],
  PRODUCT: ["Product news.", "Okay, product launch.", "Product drop.", "New product alert.", "Product update."],
  RESEARCH: ["Research paper news.", "Okay, research.", "Paper drop.", "Research alert.", "New paper."],
  TOOLING: ["Tooling news.", "Okay, dev tools.", "Dev tooling drop.", "Tools alert.", "New tooling."],
  "OPEN-SOURCE": ["Open-source news.", "OSS alert.", "Open-source drop.", "OSS news.", "New open weights."],
};

const STORY_OUTROS = [
  "That's wild.",
  "I mean, come on.",
  "That's a big deal.",
  "Crazy.",
  "That's the move.",
  "And that's where we are.",
  "Wild.",
  "That's nuts.",
  "Big deal.",
  "That's how fast this is moving.",
];

function pick(arr, i) {
  return arr[i % arr.length];
}

function stripKickerPrefix(headline) {
  // The headlines already start with the news, no prefix needed.
  return headline.replace(/^["']|["']$/g, "").trim();
}

function buildNarration(stories, comingUp, dateLabel) {
  const lines = [];
  lines.push(
    `What's up, my friends. It's ${dateLabel}. Oh man, oh man, oh man. We have got a wild AI Morning Letter to get into today. ${stories.length} stories. All heavy hitters. So let's just dive right in, okay? Like, if you thought AI was moving fast before - bro. Today is gonna make your head spin. Let's go.`
  );

  stories.forEach((s, i) => {
    const intro = pick(STORY_INTROS, i);
    const kickerIntro = pick(KICKER_INTROS[s.kicker] || KICKER_INTROS.MODEL, i);
    const outro = pick(STORY_OUTROS, i);
    const h = stripKickerPrefix(s.headline);
    lines.push(`${intro} ${kickerIntro} ${h}. ${s.body} ${outro}`);
  });

  if (comingUp.length) {
    const cu = comingUp.map((it) => `${it.when} - ${it.text}`).join(". Next up: ");
    lines.push(`Coming up in the next forty-eight hours. ${cu}. Let the drama begin.`);
  } else {
    lines.push(`That's the letter. We'll see you tomorrow with what's coming up.`);
  }

  lines.push(
    `All right. That's the letter. ${stories.length} stories. One wild morning. I'm telling you, the AI world is moving fast right now. And if you enjoyed this, share it with someone. The more people who understand what's happening, the better. We'll see you tomorrow. Peace.`
  );

  return lines.join("\n\n");
}

// ---------- chunking -----------------------------------------------------

// Split narration at paragraph + sentence boundaries, max ~1300 chars per chunk.
function chunkNarration(text, maxChars = 1300) {
  const paragraphs = text.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let buf = "";
  for (const p of paragraphs) {
    if (p.length > maxChars) {
      // Split a long paragraph at sentence boundaries.
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
  const chunks = chunkNarration(narration, 1300);
  console.log(`[render_podcast] ${chunks.length} chunks, total ${narration.length} chars`);

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
    const txt = chunks[i];
    const stagingTxt = path.join(stagingDir, `chunk_${idx}.txt`);
    const stagingWav = path.join(stagingDir, `chunk_${idx}.wav`);
    fs.writeFileSync(stagingTxt, txt, "utf8");
    console.log(`[render_podcast] chunk ${idx}/${chunks.length} (${txt.length} chars)`);

    // Render via tts.sh reading from the WSL-visible staging dir.
    const r = wslBashStatus(
      `bash ${VOXTRAL_TTS_SCRIPT} '${wslStaging}/chunk_${idx}.txt' '${wslStaging}/chunk_${idx}.wav' casual_female English`,
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

  // Build narration.
  const dateLabel = (() => {
    const [y, m, d] = DATE.split("-");
    const dt = new Date(Date.UTC(+y, +m - 1, +d));
    return dt.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
  })();
  const narration = buildNarration(stories, comingUp, dateLabel);

  // Save narration for debugging / re-use.
  const scriptPath = path.join(SITE_ROOT, "d", DATE, "podcast_script.txt");
  fs.writeFileSync(scriptPath, narration, "utf8");
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