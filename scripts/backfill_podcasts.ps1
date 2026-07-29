# backfill_podcasts.ps1 — Windows-side backfill orchestrator.
# Usage: powershell -ExecutionPolicy Bypass -File scripts/backfill_podcasts.ps1 [N]
# Default N = 7 days back.
[CmdletBinding()]
param(
  [int]$Days = 7,
  [string]$SiteRoot = "D:\.openclaw\workspace\projects\ai-digest-site"
)

Set-Location $SiteRoot
$dates = Get-ChildItem -Directory -Force -Path (Join-Path $SiteRoot "d") |
  Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}$' } |
  Sort-Object Name -Descending |
  Select-Object -First $Days

foreach ($d in $dates) {
  $date = $d.Name
  $mp3 = Join-Path $d.FullName "podcast.mp3"
  $md = Join-Path $d.FullName "digest.md"
  if (-not (Test-Path $md)) {
    Write-Host "[$date] no digest.md, skip"
    continue
  }
  if (Test-Path $mp3) {
    Write-Host "[$date] podcast.mp3 already exists, skip"
    continue
  }
  Write-Host "[$date] rendering..."
  & node "scripts/render_podcast.js" --date $date
  $rc = $LASTEXITCODE
  if ($rc -ne 0) {
    Write-Host "[$date] render failed (exit $rc)"
  } else {
    Write-Host "[$date] OK"
  }
}

Write-Host "Backfill complete."