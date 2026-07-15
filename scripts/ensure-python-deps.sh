#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

PYTHON_BIN="${RAW_PYTHON:-python3}"
IMPORTS='import numpy, boto3, requests, scipy, sklearn, yt_dlp'

if "$PYTHON_BIN" -c "$IMPORTS" >/dev/null 2>&1; then
  echo "Python scoring dependencies are already available."
  exit 0
fi

echo "Installing Python scoring dependencies from requirements.txt..."
if "$PYTHON_BIN" -m pip install --quiet -r requirements.txt; then
  :
elif "$PYTHON_BIN" -m pip install --user --quiet -r requirements.txt; then
  :
elif "$PYTHON_BIN" -m pip install --break-system-packages --quiet -r requirements.txt; then
  :
elif "$PYTHON_BIN" -m pip install --user --break-system-packages --quiet -r requirements.txt; then
  :
else
  echo "ERROR: unable to install Python scoring dependencies." >&2
  exit 1
fi

"$PYTHON_BIN" -c "$IMPORTS"
echo "Python scoring dependencies verified."
