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
  RAW_OWNED_ONLY=1 RAW_WORKERS=4 RAW_OWNED_JITTER=1 python3 raw_embed.py >> raw_embed.log 2>&1
  REMAIN=$(grep -E "^todo: [0-9]+ of" raw_embed.log | tail -1 | sed -E 's/^todo: ([0-9]+) of.*/\1/')
  echo "supervisor: pass $pass done, ~$REMAIN account videos pending $(date)" >> raw_embed.log
  [ "$REMAIN" = "0" ] && break
  sleep 60
done

# raw_embed.py's build_map() rewrites each raw/<chan>/map.json from scratch every pass, STRIPPING the
# per-account steered projections (keep/ret5/realviews/swipe). Re-inject them now so they don't vanish
# from the 🔬 Raw tab after an embed run (this is the durable fix for the disappearing-projection bug).
echo "supervisor: re-injecting steered projections (keep/ret5/realviews/swipe) $(date)" >> raw_embed.log
python3 add_steered_proj.py >> raw_embed.log 2>&1

echo "supervisor: account embed finished — resuming crawler $(date)" >> raw_embed.log
launchctl load "$PLIST" 2>/dev/null
