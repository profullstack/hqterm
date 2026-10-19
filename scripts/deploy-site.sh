#!/bin/sh
# Publish hqterm.sh: site/ plus the two installers, with the pit.world network
# footer baked in as the last thing in <body> of every page.
#
#   scripts/deploy-site.sh            build dist/site and rsync it to dev2
#   scripts/deploy-site.sh --build    build dist/site only
#
# hqterm.sh is plain files behind nginx (no server code), so the footer is
# fetched here, at deploy time, not per request. If pit.world is slow (3 s) or
# down, the pages ship without it rather than failing the deploy.
set -eu
cd "$(dirname "$0")/.."

OUT=dist/site
DEST=${DEST:-anthony@dev2.profullstack.com:/var/www/hqterm.sh/}
PIT_URL='https://pit.world/snippets/footer.html?site=hqterm.sh'

rm -rf "$OUT"
mkdir -p "$OUT"
cp -R site/. "$OUT/"
cp install.sh install.ps1 "$OUT/"

PIT=$(curl -fsS -m 3 "$PIT_URL" 2>/dev/null || true)
case "$PIT" in
  *data-pit-footer*)
    export PIT
    for f in "$OUT"/*.html; do
      # Before the LAST </body> only.
      perl -0pi -e 's{</body>(?![\s\S]*</body>)}{$ENV{PIT}\n</body>}' "$f"
    done
    echo "pit footer baked into $(ls "$OUT"/*.html | wc -l) page(s)"
    ;;
  *) echo "pit footer unavailable; publishing without it" >&2 ;;
esac

[ "${1:-}" = "--build" ] && exit 0
# Explicit modes: a restrictive local umask (007) would otherwise publish
# 0770/0660 files that nginx cannot read, and every page 500s.
rsync -a --chmod=D755,F644 "$OUT/" "$DEST"
echo "published to $DEST"
