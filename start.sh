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

# Start the server
exec node server.js
