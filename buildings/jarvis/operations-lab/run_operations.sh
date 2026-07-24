#!/bin/zsh
set -u

ROOT="/Users/tylercsatari/Desktop/BusinessHub/BusinessWorld"
HERE="$ROOT/buildings/jarvis/operations-lab"
LOG="$HERE/operations.log"
PID_FILE="$HERE/operations.pid"
PYTHON="${OPERATIONS_PYTHON:-$HOME/miniforge3/bin/python3}"

mkdir -p "$HERE/.cache"
cd "$ROOT" || exit 1

if [[ -f "$PID_FILE" ]]; then
  old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
    print "Operations is already running as PID $old_pid"
    exit 0
  fi
fi

print "$$" > "$PID_FILE"
trap 'rm -f "$PID_FILE"' EXIT

print "\n[$(date -u +%Y-%m-%dT%H:%M:%SZ)] starting Shorts Hook Operations" >> "$LOG"
exec "$PYTHON" "$HERE/build_operations.py" "$@" >> "$LOG" 2>&1
