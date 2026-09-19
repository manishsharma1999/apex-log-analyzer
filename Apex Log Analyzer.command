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
  # A dot-less version (e.g. "22") has no minor: treat minor as 0 so it can't
  # spuriously satisfy the 22.13 floor.
  local maj="${v%%.*}" min
  case "$v" in *.*) local rest="${v#*.}"; min="${rest%%.*}" ;; *) min=0 ;; esac
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
  # Pinned Node version — the verified artifact is stable across time (a floating
  # "latest-v24.x" would silently change what we checksum). Bump deliberately.
  # (Future hardening: also verify SHASUMS256.txt.sig with Node's GPG keys.)
  NODE_VERSION="v24.21.0"
  BASE="https://nodejs.org/dist/${NODE_VERSION}"
  FILE="node-${NODE_VERSION}-darwin-${NARCH}.tar.gz"
  # Verify the tarball against Node's published SHA-256 before executing it.
  EXPECTED="$(curl -fsSL "$BASE/SHASUMS256.txt" | awk -v f="$FILE" '$2==f {print $1}' | head -1)"
  if [ -z "$EXPECTED" ]; then
    echo "Could not fetch Node's checksum list — aborting for safety."
    read -r -p "Press Return to close." _; exit 1
  fi
  TARBALL="$RUNTIME.tarball.tar.gz"
  curl -fL "$BASE/$FILE" -o "$TARBALL"
  ACTUAL="$(shasum -a 256 "$TARBALL" | awk '{print $1}')"
  if [ "$ACTUAL" != "$EXPECTED" ]; then
    rm -f "$TARBALL"
    echo "Node download failed its integrity check — aborting. (expected $EXPECTED, got $ACTUAL)"
    read -r -p "Press Return to close." _; exit 1
  fi
  rm -rf "$RUNTIME"; mkdir -p "$RUNTIME"
  tar -xzf "$TARBALL" -C "$RUNTIME" --strip-components=1
  rm -f "$TARBALL"
  NODE="$RUNTIME/bin/node"
  echo "Done."
fi

exec "$NODE" "$DIR/server.js"
