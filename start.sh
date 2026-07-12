#!/bin/bash

# Install yt-dlp if not already installed
if ! command -v yt-dlp &> /dev/null; then
  echo "Installing yt-dlp to ~/.local/bin..."
  mkdir -p "$HOME/.local/bin"
  if curl -L "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" -o "$HOME/.local/bin/yt-dlp" 2>&1; then
    chmod +x "$HOME/.local/bin/yt-dlp"
    echo "yt-dlp installed successfully"
  else
    echo "WARNING: yt-dlp install failed - video analysis will not work"
  fi
fi

export PATH="$HOME/.local/bin:$PATH"

# Ensure the RUNTIME python3 (the exact one the server spawns for Python scorers) has
# numpy + boto3 + requests. Doing this here — not just at build time — guarantees they land
# in the interpreter that actually runs, regardless of build/runtime python drift.
echo "Ensuring python3 deps (numpy, boto3, requests) for scoring…"
python3 -c "import numpy, boto3, requests" 2>/dev/null \
  && echo "  python3 already has numpy+boto3+requests" \
  || python3 -m pip install --user --quiet numpy boto3 requests 2>/dev/null \
  || python3 -m pip install --user --break-system-packages --quiet numpy boto3 requests 2>/dev/null \
  || pip install --user --quiet numpy boto3 requests 2>/dev/null \
  || echo "  WARNING: could not install numpy/boto3/requests — scoring will be unavailable"
python3 -c "import numpy, boto3, requests" 2>/dev/null && echo "  ✓ python3 scoring deps OK" || echo "  ✗ python3 still missing scoring deps"

# Check tools
command -v yt-dlp &> /dev/null && echo "yt-dlp: $(yt-dlp --version 2>/dev/null || echo 'found')" || echo "WARNING: yt-dlp not available"
command -v ffmpeg &> /dev/null && echo "ffmpeg: available" || echo "WARNING: ffmpeg not available"

# Start the server.
# Cap V8's old-space to the container, NOT the host. In a 2 GB container Node
# otherwise detects the host's RAM and lets its heap grow past the cgroup limit,
# so Render OOM-kills the process instead of Node garbage-collecting. 1024 MB
# leaves ~1 GB for the ffmpeg CHILD process used by footage coverage (child RAM
# counts against the same container cgroup), off-heap Buffers, code and V8
# overhead — so RSS stays under the 2 GB cap. Override with NODE_MAX_OLD_SPACE.
exec node --max-old-space-size="${NODE_MAX_OLD_SPACE:-1024}" server.js
