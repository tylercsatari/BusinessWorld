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

# Downloads use the web_safari/mweb player clients (raw_embed.py default) which bypass the bot wall
# WITHOUT cookies. Full speed; retry any transient fails each pass until every account video is in.
for pass in $(seq 1 60); do
  RAW_SKIP_STEER_REBUILD=1 RAW_OWNED_ONLY=1 RAW_WORKERS=4 RAW_OWNED_JITTER=1 python3 raw_embed.py >> raw_embed.log 2>&1
  REMAIN=$(grep -E "^todo: [0-9]+ of" raw_embed.log | tail -1 | sed -E 's/^todo: ([0-9]+) of.*/\1/')
  echo "supervisor: pass $pass done, ~$REMAIN account videos pending $(date)" >> raw_embed.log
  [ "$REMAIN" = "0" ] && break
  sleep 60
done

# The completed pass leaves unsteered maps under map.pending.json. Validate every
# required projection and compact artifact before replacing the last complete live maps.
echo "supervisor: validating and publishing steered projections (keep/ret5/realviews/swipe) $(date)" >> raw_embed.log
RAW_STEER_USE_PENDING=1 python3 add_steered_proj.py >> raw_embed.log 2>&1

echo "supervisor: account embed finished — resuming crawler $(date)" >> raw_embed.log
launchctl load "$PLIST" 2>/dev/null
