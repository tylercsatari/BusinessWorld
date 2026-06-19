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

# Check tools
command -v yt-dlp &> /dev/null && echo "yt-dlp: $(yt-dlp --version 2>/dev/null || echo 'found')" || echo "WARNING: yt-dlp not available"
command -v ffmpeg &> /dev/null && echo "ffmpeg: available" || echo "WARNING: ffmpeg not available"

# Start the server.
# Cap V8's old-space to the container, NOT the host. In a 2 GB container Node
# otherwise detects the host's RAM and lets its heap grow past the cgroup limit,
# so Render OOM-kills the process instead of Node garbage-collecting. 1280 MB
# leaves ~700 MB for off-heap Buffers (footage clip downloads, R2 up/downloads),
# code and V8 overhead so RSS stays under the 2 GB cap. Override with
# NODE_MAX_OLD_SPACE if the instance size changes.
exec node --max-old-space-size="${NODE_MAX_OLD_SPACE:-1280}" server.js
