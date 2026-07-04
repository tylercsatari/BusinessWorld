#!/bin/bash
# crawler-watchdog.sh — self-heal for the background crawlers.
#
# KeepAlive relaunches a crawler if its *process* crashes, but it does NOT help
# if the launchd agent itself gets unloaded (manual `launchctl unload`, a bootout
# on logout, etc.) — that's how the shorts crawler silently stopped on
# 2026-07-04. This watchdog runs on an interval and re-loads any agent that's
# missing from `launchctl list`. Covers BOTH crawlers.
set -euo pipefail

LABELS=(
  "com.businessworld.library-crawler"     # shorts video crawler
  "com.businessworld.longform-crawler"    # long-form thumbnail crawler
)
PLIST_DIR="$HOME/Library/LaunchAgents"
LOG="/Users/tylercsatari/Desktop/BusinessHub/BusinessWorld/crawler-watchdog.log"

ts() { date "+%Y-%m-%dT%H:%M:%S%z"; }

for LABEL in "${LABELS[@]}"; do
  if launchctl list 2>/dev/null | grep -q "$LABEL"; then
    continue   # loaded — nothing to do (stay quiet to keep the log small)
  fi
  PLIST="$PLIST_DIR/${LABEL}.plist"
  echo "[$(ts)] $LABEL not loaded — reloading from $PLIST" >> "$LOG"
  if launchctl load -w "$PLIST" >> "$LOG" 2>&1; then
    echo "[$(ts)] $LABEL reload issued OK" >> "$LOG"
  else
    echo "[$(ts)] $LABEL reload FAILED (exit $?)" >> "$LOG"
  fi
done
