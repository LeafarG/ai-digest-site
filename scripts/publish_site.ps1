# publish_site.ps1 — runs after the daily cron writes digest.md.
# Renders the per-day HTML, regenerates archive.json, commits, and pushes.
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

if (-not (Test-Path $mdPath)) {
    Write-Error "missing source: $mdPath"
    exit 2
}

# 1) Render HTML.
Write-Host "rendering $mdPath -> $htmlPath"
python (Join-Path $siteRoot "scripts/render_html.py") $mdPath $htmlPath
if ($LASTEXITCODE -ne 0) { throw "render_html.py failed (exit $LASTEXITCODE)" }

# 2) Regenerate archive.json + today.html.
Write-Host "rebuilding archive.json"
node (Join-Path $siteRoot "scripts/rebuild_archive.js")
if ($LASTEXITCODE -ne 0) { throw "rebuild_archive.js failed (exit $LASTEXITCODE)" }

# 3) git commit + push.
Push-Location $siteRoot
try {
    git config user.name "openclaw-ai-digest"
    git config user.email "ai-digest-bot@openclaw.local"

    git add "d/$Date/" archive.json today.html
    $staged = git status --porcelain
    if (-not $staged) {
        Write-Host "no changes to commit"
        return
    }
    git commit -m "feat(digest): $Date edition"
    if ($LASTEXITCODE -ne 0) { throw "git commit failed (exit $LASTEXITCODE)" }
    git push origin main
    if ($LASTEXITCODE -ne 0) { throw "git push failed (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}

Write-Host "publish_site ok: $Date"
