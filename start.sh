#!/bin/bash
set -e

# Install yt-dlp if not already installed (try user bin first, then /usr/local/bin)
if ! command -v yt-dlp &> /dev/null; then
  echo "Installing yt-dlp..."
  mkdir -p "$HOME/.local/bin"
  curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o "$HOME/.local/bin/yt-dlp"
  chmod a+rx "$HOME/.local/bin/yt-dlp"
  export PATH="$HOME/.local/bin:$PATH"
  echo "yt-dlp installed: $(yt-dlp --version)"
fi

export PATH="$HOME/.local/bin:$PATH"

# Check ffmpeg
if command -v ffmpeg &> /dev/null; then
  echo "ffmpeg available: $(ffmpeg -version 2>&1 | head -1)"
else
  echo "WARNING: ffmpeg not found - frame extraction will fail"
fi

# Start the server
exec node server.js
