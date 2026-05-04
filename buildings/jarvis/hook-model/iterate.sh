#!/bin/bash
# Hook Model iteration script — runs cross-indicator experiments, rebuilds model, validates
# Called every hour by cron
cd /Users/tylercsatari/Desktop/BusinessHub/BusinessWorld
env -u ANTHROPIC_API_KEY /Users/tylercsatari/.local/bin/claude \
  --permission-mode bypassPermissions \
  --print "$(cat /Users/tylercsatari/Desktop/BusinessHub/BusinessWorld/buildings/jarvis/hook-model/iterate_prompt.txt)" \
  >> /Users/tylercsatari/Desktop/BusinessHub/BusinessWorld/buildings/jarvis/hook-model/iterate.log 2>&1
