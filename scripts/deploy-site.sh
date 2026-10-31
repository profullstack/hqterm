#!/bin/sh
# Publish hqterm.sh: site/ plus the two installers. Each HTML page carries the
# shared Profullstack footer and refreshes it from the published template.
#
#   scripts/deploy-site.sh            build dist/site and rsync it to dev2
#   scripts/deploy-site.sh --build    build dist/site only
#
# hqterm.sh is plain files behind nginx (no server code); its pages include a
# server-rendered fallback and load the shared template in the browser.
set -eu
cd "$(dirname "$0")/.."

OUT=dist/site
DEST=${DEST:-anthony@dev2.profullstack.com:/var/www/hqterm.sh/}
rm -rf "$OUT"
mkdir -p "$OUT"
cp -R site/. "$OUT/"
cp install.sh install.ps1 "$OUT/"

[ "${1:-}" = "--build" ] && exit 0
# Explicit modes: a restrictive local umask (007) would otherwise publish
# 0770/0660 files that nginx cannot read, and every page 500s.
rsync -a --chmod=D755,F644 "$OUT/" "$DEST"
echo "published to $DEST"
