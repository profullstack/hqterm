#!/usr/bin/env bash
# CI smoke test of a built desktop app on macOS or Windows (Linux runs the
# AppImage under Xvfb in the workflow itself). Launches it twice against a
# fresh config: one shell split once (2 PTYs), then the saved layout restored
# and split again (3 PTYs). Screenshots land in smoke-1.png and smoke-2.png.
#
#   desktop/scripts/ci-smoke.sh path/to/app-executable
set -uo pipefail
exe="$1"
# Paths the app (not bash) reads: on Windows they must be C:/... not /c/...
here="$(pwd -W 2>/dev/null || pwd)"
cfg="$here/smoke-cfg"
rm -rf "$cfg"

smoke() {
  HQTERM_DESKTOP_SMOKE="${HQTERM_DESKTOP_SMOKE:-12000}" HQTERM_DESKTOP_SMOKE_SHOT="$here/$1" XDG_CONFIG_HOME="$cfg" \
    "$exe" 2>&1 | tee "$1.log"
  echo "exit ${PIPESTATUS[0]}"
}

smoke smoke-1.png
grep -q "hqterm-desktop smoke: ok (ptys=2)" smoke-1.png.log || { echo "first launch failed"; exit 1; }
cat "$cfg/hqterm/desktop-layout.json"
smoke smoke-2.png
grep -q "hqterm-desktop smoke: ok (ptys=3)" smoke-2.png.log || { echo "second launch failed"; exit 1; }
echo "smoke: ok"
