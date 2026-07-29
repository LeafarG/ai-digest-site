#!/bin/bash
# Backfill podcast audio for the last N days (skipping days that already
# have a podcast.mp3).
#
# Usage: backfill_podcasts.sh [N]   (default 7)

set -u

N=${1:-7}
SITE_ROOT="/mnt/d/.openclaw/workspace/projects/ai-digest-site"
cd "$SITE_ROOT" || exit 1

# List date dirs, sorted descending, take the first N that have digest.md.
DATES=$(ls -1d d/202?-*-* 2>/dev/null | sort -r | head -n "$N")
if [ -z "$DATES" ]; then
  echo "no date dirs found"
  exit 1
fi

echo "Backfilling podcasts for up to $N days..."
for d in $DATES; do
  DATE=$(basename "$d")
  if [ ! -f "$d/digest.md" ]; then
    echo "[$DATE] no digest.md, skip"
    continue
  fi
  if [ -f "$d/podcast.mp3" ]; then
    echo "[$DATE] podcast.mp3 already exists, skip"
    continue
  fi
  echo "[$DATE] rendering..."
  cd "$SITE_ROOT" && node scripts/render_podcast.js --date "$DATE"
  rc=$?
  if [ $rc -ne 0 ]; then
    echo "[$DATE] render failed (exit $rc)"
  else
    echo "[$DATE] OK"
  fi
done

echo "Backfill complete."