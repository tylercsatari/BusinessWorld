#!/bin/zsh
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT/buildings/jarvis/predictor-lab"
EMBED_LOG="$LOG_DIR/embed-backfill.log"
ANALYSIS_LOG="$LOG_DIR/analysis-refresh.log"
RETRY_SECONDS="${RAW_RETRY_SECONDS:-30}"
PID_FILE="$LOG_DIR/embed-backfill.pid"

cd "$ROOT" || exit 1
mkdir -p "$LOG_DIR"
if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  print -r -- "Predictor backfill is already running as PID $(cat "$PID_FILE")."
  exit 0
fi
print -r -- "$$" >"$PID_FILE"
cleanup() {
  rm -f "$PID_FILE"
}
stop_backfill() {
  cleanup
  exit 130
}
trap cleanup EXIT
trap stop_backfill INT TERM

if [[ "${SKIP_METADATA:-0}" != "1" ]]; then
  python3 buildings/jarvis/predictor-lab/backfill_saved_channel_metadata.py >>"$ANALYSIS_LOG" 2>&1
fi

while true; do
  env \
    RAW_BACKFILL=1 \
    RAW_STREAM_R2="${RAW_STREAM_R2:-1}" \
    RAW_WORKERS="${RAW_WORKERS:-6}" \
    RAW_CHECKPOINT_EVERY="${RAW_CHECKPOINT_EVERY:-5000}" \
    RAW_MAP_EVERY=0 \
    RAW_STATUS_EVERY="${RAW_STATUS_EVERY:-25}" \
    python3 raw_embed.py >>"$EMBED_LOG" 2>&1
  code=$?
  if [[ $code -eq 0 ]]; then
    break
  fi
  print -r -- "$(date -u +%FT%TZ) raw_embed.py exited $code; resuming in ${RETRY_SECONDS}s" >>"$EMBED_LOG"
  sleep "$RETRY_SECONDS"
done

python3 buildings/jarvis/predictor-lab/run_predictor_lab.py >>"$ANALYSIS_LOG" 2>&1
