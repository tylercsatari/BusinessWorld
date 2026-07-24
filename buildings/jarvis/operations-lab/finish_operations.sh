#!/bin/zsh
set -u

ROOT="/Users/tylercsatari/Desktop/BusinessHub/BusinessWorld"
HERE="$ROOT/buildings/jarvis/operations-lab"
STATUS_FILE="$HERE/status.json"
DESCRIBE_LABEL="com.businessworld.operations-describe"
FOLLOWUP_LABEL="com.businessworld.operations-build-followup"

while ! /usr/bin/grep -q '"stage": "descriptions_complete"' "$STATUS_FILE" 2>/dev/null; do
  /bin/sleep 2
done

launchctl remove "$DESCRIBE_LABEL" >/dev/null 2>&1 || true
while /usr/bin/pgrep -f "[b]uild_operations.py --describe-only" >/dev/null; do
  /bin/sleep 2
done

while true; do
  /usr/bin/caffeinate -dims /bin/zsh "$HERE/run_operations.sh"
  if /usr/bin/grep -q '"stage": "complete"' "$STATUS_FILE" 2>/dev/null; then
    break
  fi
  /bin/sleep 60
done

launchctl remove "$FOLLOWUP_LABEL" >/dev/null 2>&1 || true
