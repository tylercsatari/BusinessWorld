#!/bin/bash
# embed-accounts-supervisor.sh — patiently embeds the Account 1/2/3 videos past YouTube's bot wall.
# Cookieless slow pulls (1 worker + jitter) like the library crawler, retried each pass so the
# still-blocked videos succeed as the IP flag decays. If raw-cookies.txt exists (a cookies.txt export),
# it's used → authenticated, full speed. The library crawler stays PAUSED for the duration (max IP
# budget + fastest flag decay), then is auto-resumed. Logs to raw_embed.log. Detached via the launcher.
cd "$(dirname "$0")" || exit 1
PLIST="$HOME/Library/LaunchAgents/com.businessworld.library-crawler.plist"
launchctl unload "$PLIST" 2>/dev/null; pkill -f library-crawler.js 2>/dev/null   # pause crawler
echo "supervisor: crawler paused; starting gentle account embed $(date)" >> raw_embed.log

# Cookieless pulls are bot-walled on this IP right now and PROBING SUSTAINS THE FLAG, so without a
# cookies.txt we only do a tiny probe (a few videos) then sleep LONG — minimal load, doesn't sustain
# the flag, and occasionally tests whether it has cleared. The instant a raw-cookies.txt export appears
# we switch to authenticated full-speed (4 workers, no cap) — that bypasses the wall entirely.
for pass in $(seq 1 200); do
  if [ -f raw-cookies.txt ]; then
    RAW_OWNED_ONLY=1 RAW_WORKERS=4 RAW_OWNED_JITTER=1 RAW_COOKIES=raw-cookies.txt python3 raw_embed.py >> raw_embed.log 2>&1
    NAP=30
  else
    RAW_OWNED_ONLY=1 RAW_WORKERS=1 RAW_OWNED_JITTER=4 RAW_MAX=5 python3 raw_embed.py >> raw_embed.log 2>&1
    NAP=1800   # 30-min quiet window so the IP flag can decay (gentle hedge while waiting for cookies.txt)
  fi
  REMAIN=$(grep -E "^todo: [0-9]+ of" raw_embed.log | tail -1 | sed -E 's/^todo: ([0-9]+) of.*/\1/')
  echo "supervisor: pass $pass done, ~$REMAIN account videos pending, cookies=$([ -f raw-cookies.txt ] && echo yes || echo no) $(date)" >> raw_embed.log
  [ "$REMAIN" = "0" ] && break
  sleep "$NAP"
done

echo "supervisor: account embed finished — resuming crawler $(date)" >> raw_embed.log
launchctl load "$PLIST" 2>/dev/null
