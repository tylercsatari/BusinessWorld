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

COOK=""; [ -f raw-cookies.txt ] && COOK="raw-cookies.txt"
for pass in $(seq 1 40); do
  # count account videos still needing embedding (the run prints "todo: N of ...")
  RAW_OWNED_ONLY=1 RAW_WORKERS=$([ -n "$COOK" ] && echo 4 || echo 1) RAW_OWNED_JITTER=$([ -n "$COOK" ] && echo 1 || echo 6) \
    RAW_COOKIES="$COOK" python3 raw_embed.py >> raw_embed.log 2>&1
  REMAIN=$(grep -E "^todo: [0-9]+ of" raw_embed.log | tail -1 | sed -E 's/^todo: ([0-9]+) of.*/\1/')
  echo "supervisor: pass $pass done, ~$REMAIN account videos still pending $(date)" >> raw_embed.log
  [ "$REMAIN" = "0" ] && break
  [ -f raw-cookies.txt ] && [ -z "$COOK" ] && COOK="raw-cookies.txt"   # pick up a cookies.txt dropped mid-run
  sleep 300   # let the IP flag decay between passes
done

echo "supervisor: account embed finished — resuming crawler $(date)" >> raw_embed.log
launchctl load "$PLIST" 2>/dev/null
