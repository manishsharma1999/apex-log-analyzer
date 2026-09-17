#!/bin/bash
# Double-click launcher for Apex Log Analyzer.
# Needs NOTHING pre-installed: uses your system Node if it's new enough,
# otherwise downloads an official Node build into this folder (one-time),
# then starts the local server (which opens your browser).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

RUNTIME="$DIR/.runtime"
MIN_MAJOR=22           # node:sqlite is usable unflagged on 22.13+ / 24+
MIN_MINOR=13

# Prefer a system Node that's new enough; fall back to a Node we manage locally.
node_ok() {
  local n="$1"
  command -v "$n" >/dev/null 2>&1 || [ -x "$n" ] || return 1
  local v; v="$("$n" -v 2>/dev/null | sed 's/^v//')" || return 1
  local maj="${v%%.*}"; local rest="${v#*.}"; local min="${rest%%.*}"
  [ "${maj:-0}" -gt "$MIN_MAJOR" ] && return 0
  [ "${maj:-0}" -eq "$MIN_MAJOR" ] && [ "${min:-0}" -ge "$MIN_MINOR" ] && return 0
  return 1
}

NODE=""
if node_ok node; then
  NODE="node"
elif node_ok "$RUNTIME/bin/node"; then
  NODE="$RUNTIME/bin/node"
else
  echo "First run: setting up a private Node runtime for this app (~30 MB, one-time)…"
  case "$(uname -m)" in
    arm64)  NARCH="arm64" ;;
    x86_64) NARCH="x64" ;;
    *)      NARCH="x64" ;;
  esac
  BASE="https://nodejs.org/dist/latest-v24.x"
  FILE="$(curl -fsSL "$BASE/" | grep -oE "node-v24[0-9.]+-darwin-$NARCH\.tar\.gz" | head -1)"
  if [ -z "$FILE" ]; then
    echo "Could not find a Node download. Please install Node 24 from https://nodejs.org and try again."
    read -r -p "Press Return to close." _; exit 1
  fi
  rm -rf "$RUNTIME"; mkdir -p "$RUNTIME"
  curl -fL "$BASE/$FILE" | tar -xz -C "$RUNTIME" --strip-components=1
  NODE="$RUNTIME/bin/node"
  echo "Done."
fi

exec "$NODE" "$DIR/server.js"
