#!/bin/bash
# Assembles "Apex Log Analyzer.app" (a self-contained macOS bundle) from the
# source files in this repo, and zips it for distribution. No signing.
#
#   ./build-app.sh            -> dist/Apex Log Analyzer.app  + ~/Apex Log Analyzer.zip
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="Apex Log Analyzer"
DIST="$DIR/dist"
APP="$DIST/$APP_NAME.app"

rm -rf "$DIST"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app"

# App metadata + launcher.
cp "$DIR/mac-app/Info.plist" "$APP/Contents/Info.plist"
cp "$DIR/mac-app/launcher"   "$APP/Contents/MacOS/launcher"
chmod +x "$APP/Contents/MacOS/launcher"

# App icon: build icon.icns from the 1024px PNG (all required sizes).
if [ -f "$DIR/mac-app/icon.png" ]; then
  ICONSET="$(mktemp -d)/icon.iconset"; mkdir -p "$ICONSET"
  for s in 16 32 64 128 256 512; do
    sips -z "$s" "$s"           "$DIR/mac-app/icon.png" --out "$ICONSET/icon_${s}x${s}.png"      >/dev/null
    sips -z "$((s*2))" "$((s*2))" "$DIR/mac-app/icon.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/icon.icns"
  rm -rf "$(dirname "$ICONSET")"
fi

# Bundle the runnable files (server + front-end + metadata).
cp "$DIR/server.js" "$DIR/chrome-session.js" "$DIR/package.json" "$DIR/README.md" "$DIR/LICENSE" \
   "$APP/Contents/Resources/app/"
cp -R "$DIR/web" "$APP/Contents/Resources/app/web"

# Sets the Finder "extension hidden" flag so the icon reads just
# "Apex Log Analyzer" (no visible .app). Byte 9 of com.apple.FinderInfo = 0x10.
hide_ext() {
  xattr -wx com.apple.FinderInfo \
    "00 00 00 00 00 00 00 00 00 10 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00" \
    "$1" 2>/dev/null || true
}

# Remove the quarantine on our own build so it runs locally without the prompt,
# then hide the extension (xattr -cr wipes all xattrs, so order matters).
xattr -cr "$APP" 2>/dev/null || true
hide_ext "$APP"

# Put a ready-to-run copy on the Desktop (labelled without .app).
DESKTOP="$HOME/Desktop"
if [ -d "$DESKTOP" ]; then
  rm -rf "$DESKTOP/$APP_NAME.app"
  cp -R "$APP" "$DESKTOP/$APP_NAME.app"
  xattr -cr "$DESKTOP/$APP_NAME.app" 2>/dev/null || true
  hide_ext "$DESKTOP/$APP_NAME.app"
fi

# Zip with ditto (NOT plain zip): it preserves the bundle's permissions and the
# hidden-extension flag, so the unzipped copy is a real, recognized .app that
# Finder labels just "Apex Log Analyzer" — not a plain folder showing ".app".
rm -f "$HOME/$APP_NAME.zip"
/usr/bin/ditto -c -k --keepParent "$APP" "$HOME/$APP_NAME.zip"

echo "Built:   $APP"
echo "Desktop: $DESKTOP/$APP_NAME.app"
echo "Zip:     $HOME/$APP_NAME.zip"
