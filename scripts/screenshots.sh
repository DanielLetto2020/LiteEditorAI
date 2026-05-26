#!/usr/bin/env bash
# Regenerate README screenshots: renders the REAL renderer with fake data
# (renderer/mock.html + mock-lite.js) via headless Chrome. No GPU/display needed.
set -e
cd "$(dirname "$0")/.."
node build.js >/dev/null
mkdir -p assets/screenshots
BASE="file://$PWD/renderer/mock.html"
UDD=$(mktemp -d)
CHROME=${CHROME:-$(command -v google-chrome || command -v chromium || command -v google-chrome-stable)}

shot() { # <name> <scene>
  "$CHROME" --headless=new --disable-gpu --no-sandbox --user-data-dir="$UDD" \
    --hide-scrollbars --force-device-scale-factor=1 --window-size=1380,860 \
    --virtual-time-budget=6000 --screenshot="assets/screenshots/$1.png" "$BASE?scene=$2" >/dev/null 2>&1
  echo "  assets/screenshots/$1.png"
}

echo "rendering screenshots with $CHROME"
shot main main
shot viewer viewer
shot preview preview
shot notes notes
rm -rf "$UDD"
echo "done."
