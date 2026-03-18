#!/bin/bash
set -e

# Install yt-dlp if not already installed
if ! command -v yt-dlp &> /dev/null; then
  echo "Installing yt-dlp..."
  curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
  chmod a+rx /usr/local/bin/yt-dlp
  echo "yt-dlp installed: $(yt-dlp --version)"
fi

# Check ffmpeg
if command -v ffmpeg &> /dev/null; then
  echo "ffmpeg available: $(ffmpeg -version 2>&1 | head -1)"
else
  echo "WARNING: ffmpeg not found - frame extraction will fail"
fi

# Start the server
exec node server.js
