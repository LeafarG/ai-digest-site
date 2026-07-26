# publish_site.ps1 — runs after the daily cron writes digest.md.
# Renders the per-day HTML, regenerates archive.json, runs `vercel deploy --prod`,
# and writes the deployed URL into .last-deploy-url for the cron agent to read.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/publish_site.ps1 -Date 2026-07-27
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Date  # YYYY-MM-DD (site-folder date)
)
$ErrorActionPreference = "Stop"

$siteRoot = (Resolve-Path -Path "$PSScriptRoot\..").Path
$mdDir    = Join-Path $siteRoot "d/$Date"
$mdPath   = Join-Path $mdDir "digest.md"
$htmlPath = Join-Path $mdDir "index.html"
$vcjs     = "C:\Users\rafae\AppData\Roaming\npm\node_modules\vercel\dist\vc.js"

if (-not (Test-Path $mdPath)) {
    Write-Error "missing source: $mdPath"
    exit 2
}

# 1) Render HTML.
Write-Host "[publish_site] rendering $mdPath -> $htmlPath"
& python (Join-Path $siteRoot "scripts/render_html.py") $mdPath $htmlPath
if ($LASTEXITCODE -ne 0) { throw "render_html.py failed (exit $LASTEXITCODE)" }

# 2) Regenerate archive.json + today.html.
Write-Host "[publish_site] rebuilding archive.json + today.html"
& node (Join-Path $siteRoot "scripts/rebuild_archive.js")
if ($LASTEXITCODE -ne 0) { throw "rebuild_archive.js failed (exit $LASTEXITCODE)" }

# 3) Git commit (no push — Vercel deploys from local state).
Push-Location $siteRoot
try {
    git config user.name "openclaw-ai-digest"
    git config user.email "ai-digest-bot@openclaw.local"
    git add -A
    $staged = git status --porcelain
    if ($staged) {
        git commit -m "feat(digest): $Date edition"
        if ($LASTEXITCODE -ne 0) { throw "git commit failed (exit $LASTEXITCODE)" }
    } else {
        Write-Host "[publish_site] no git changes to commit"
    }
} finally {
    Pop-Location
}

# 4) Vercel deploy (production). The URL Vercel assigns to the new deploy
#    is captured below so the cron agent can post it to the Telegram topic.
Write-Host "[publish_site] deploying to Vercel production"
$deployOutput = & node $vcjs deploy --prod --yes --scope leafargs-projects --no-color 2>&1 | Out-String
Write-Host $deployOutput

# Parse the deploy URL from the output. Vercel prints:
#   "▲ Production  https://ai-digest-site-XXXX-leafargs-projects.vercel.app"
#   or
#   "Aliased       https://ai-digest-site-pink.vercel.app"
#   "Inspect       https://vercel.com/..."
# Prefer the canonical alias line if present; fall back to the Production URL.
$deployUrl = $null
foreach ($line in ($deployOutput -split "`r?`n")) {
    if ($line -match '^\s*Aliased\s+(https?://\S+)') {
        $deployUrl = $Matches[1].Trim()
        break
    }
}
if (-not $deployUrl) {
    foreach ($line in ($deployOutput -split "`r?`n")) {
        if ($line -match 'Production\s+(https?://\S+)') {
            $deployUrl = $Matches[1].Trim()
            break
        }
    }
}
if (-not $deployUrl) {
    foreach ($line in ($deployOutput -split "`r?`n")) {
        if ($line -match '(https?://ai-digest-site[a-z0-9-]*\.vercel\.app\/?)') {
            $deployUrl = $Matches[1].Trim()
            if (-not $deployUrl.EndsWith("/")) { $deployUrl += "/" }
            break
        }
    }
}
if (-not $deployUrl) {
    throw "could not parse Vercel deploy URL from output"
}

$digestUrl = $deployUrl.TrimEnd('/') + "d/$Date/"
$lastUrlFile = Join-Path $siteRoot ".last-deploy-url"
"deploy=$deployUrl`r`ndigest=$digestUrl" | Out-File -Encoding utf8 $lastUrlFile

Write-Host "[publish_site] OK deploy=$deployUrl digest=$digestUrl"
