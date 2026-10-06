#!/bin/sh
# hqterm installer: https://hqterm.sh
#
#   curl -fsSL https://hqterm.sh/install | sh                  # hqterm + hqsh (+ desktop app on a Linux desktop)
#   curl -fsSL https://hqterm.sh/install | sh -s -- --desktop  # also the desktop app, display or not
#   curl -fsSL https://hqterm.sh/install | sh -s -- --server   # hqsh only (remote hosts)
#
# Installs prebuilt binaries from the latest GitHub releases of
# profullstack/hqterm and profullstack/hqsh into ~/.local/bin (or $HQTERM_BIN).
# The desktop app (Linux x86_64/arm64 AppImage) goes to
# ~/.local/opt/hqterm-desktop with an app-launcher entry. No sudo, safe to run
# again. Pin versions with HQTERM_VERSION / HQSH_VERSION (e.g. v0.2.0).
set -eu

BIN="${HQTERM_BIN:-$HOME/.local/bin}"
SERVER=0
DESKTOP=auto
for arg in "$@"; do
  case "$arg" in
    --server) SERVER=1 ;;
    --desktop) DESKTOP=1 ;;
    --no-desktop) DESKTOP=0 ;;
    --bin=*) BIN="${arg#--bin=}" ;;
    -h|--help)
      echo "usage: install.sh [--server] [--desktop|--no-desktop] [--bin=DIR]"
      echo "  --server      install only hqsh (for hosts you connect to)"
      echo "  --desktop     also install the hqterm desktop app (Linux AppImage)"
      echo "  --no-desktop  never install the desktop app"
      echo "                (default: install it on Linux when a display is present)"
      echo "  --bin=DIR     install into DIR (default ~/.local/bin, or \$HQTERM_BIN)"
      exit 0 ;;
    *) echo "hqterm install: unknown option $arg" >&2; exit 2 ;;
  esac
done
if [ "$SERVER" = 1 ]; then
  if [ "$DESKTOP" = 1 ]; then
    echo "hqterm install: --server and --desktop do not mix" >&2
    exit 2
  fi
  DESKTOP=0
fi
DESKTOP_AUTO=0
if [ "$DESKTOP" = auto ]; then
  DESKTOP_AUTO=1
  if [ "$(uname -s)" = Linux ] && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then DESKTOP=1; else DESKTOP=0; fi
fi
if [ -n "${HQTERM_INSTALL_PARSE_ONLY:-}" ]; then
  echo "bin=$BIN server=$SERVER desktop=$DESKTOP auto=$DESKTOP_AUTO"
  exit 0
fi

say() { printf '%s\n' "hqterm install: $*"; }
die() { printf '%s\n' "hqterm install: error: $*" >&2; exit 1; }

case "$(uname -s)" in
  Linux) OS=linux ;;
  Darwin) OS=darwin ;;
  *) die "unsupported OS $(uname -s) (linux and macOS only)" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "unsupported CPU $(uname -m) (x86_64 and arm64 only)" ;;
esac

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --retry 2 -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q -O "$2" "$1"; }
else
  die "need curl or wget"
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  sha256() { echo ""; }
fi

TMP="$(mktemp -d 2>/dev/null || mktemp -d -t hqterm)"
trap 'rm -rf "$TMP"' EXIT INT TERM
mkdir -p "$BIN" || die "cannot create $BIN"

# release_base REPO VERSION: the download URL prefix of a release.
release_base() {
  if [ -n "$2" ]; then
    echo "https://github.com/profullstack/$1/releases/download/$2"
  else
    echo "https://github.com/profullstack/$1/releases/latest/download"
  fi
}

# verify BASE ASSET REPO: check $TMP/ASSET against the release's SHA256SUMS.
verify() {
  if fetch "$1/SHA256SUMS" "$TMP/SHA256SUMS.$2" 2>/dev/null; then
    want="$(grep " \*\{0,1\}$2\$" "$TMP/SHA256SUMS.$2" | cut -d' ' -f1 | head -n1)"
    got="$(sha256 "$TMP/$2")"
    if [ -z "$want" ]; then
      say "warning: $2 is not listed in SHA256SUMS; not verified"
    elif [ -z "$got" ]; then
      say "warning: no sha256sum/shasum here; $2 not verified"
    elif [ "$want" != "$got" ]; then
      die "checksum mismatch for $2 (expected $want, got $got)"
    else
      say "verified $2 (sha256 $got)"
    fi
  else
    say "warning: no SHA256SUMS in the $3 release; $2 not verified"
  fi
}

# install_one REPO NAME VERSION: download NAME-OS-ARCH, verify, install as BIN/NAME.
# Returns 1 (without exiting) when the release or asset does not exist.
install_one() {
  repo="$1"; name="$2"; version="$3"
  asset="$name-$OS-$ARCH"
  base="$(release_base "$repo" "$version")"
  say "downloading $asset from github.com/profullstack/$repo${version:+ ($version)}"
  if ! fetch "$base/$asset" "$TMP/$asset"; then
    return 1
  fi
  verify "$base" "$asset" "$repo"
  chmod 755 "$TMP/$asset"
  # macOS on Apple silicon refuses unsigned binaries: ad-hoc sign if needed.
  if [ "$OS" = darwin ] && ! "$TMP/$asset" --version >/dev/null 2>&1 && command -v codesign >/dev/null 2>&1; then
    codesign --force --sign - "$TMP/$asset" >/dev/null 2>&1 || true
  fi
  # Replace atomically, so a running copy is never half-written.
  mv -f "$TMP/$asset" "$BIN/$name.new.$$"
  mv -f "$BIN/$name.new.$$" "$BIN/$name"
  say "installed $BIN/$name"
  return 0
}

# install_desktop: the AppImage, an icon and an app-launcher entry (Linux only).
install_desktop() {
  if [ "$OS" != linux ]; then
    say "the desktop app is Linux-only for now; skipping it"
    return 1
  fi
  case "$ARCH" in
    amd64) aarch=x86_64 ;;
    *) aarch=aarch64 ;;
  esac
  asset="hqterm-desktop-linux-$aarch.AppImage"
  base="$(release_base hqterm "${HQTERM_VERSION:-}")"
  say "downloading $asset"
  fetch "$base/$asset" "$TMP/$asset" || return 1
  verify "$base" "$asset" hqterm
  dir="$HOME/.local/opt/hqterm-desktop"
  mkdir -p "$dir"
  chmod 755 "$TMP/$asset"
  mv -f "$TMP/$asset" "$dir/hqterm-desktop.AppImage.new.$$"
  mv -f "$dir/hqterm-desktop.AppImage.new.$$" "$dir/hqterm-desktop.AppImage"
  say "installed $dir/hqterm-desktop.AppImage"

  icons="$HOME/.local/share/icons"
  apps="$HOME/.local/share/applications"
  mkdir -p "$icons" "$apps"
  if fetch "$base/hqterm-desktop.png" "$TMP/hqterm.png" 2>/dev/null \
    || fetch "https://raw.githubusercontent.com/profullstack/openemoji/main/png/256/1f5a5-fe0f.png" "$TMP/hqterm.png" 2>/dev/null; then
    mv -f "$TMP/hqterm.png" "$icons/hqterm.png"
  fi
  # AppImages mount through FUSE; without it they can unpack and run instead.
  extra=""
  if ! command -v fusermount >/dev/null 2>&1 && ! command -v fusermount3 >/dev/null 2>&1; then
    extra=" --appimage-extract-and-run"
    say "note: no FUSE (fusermount) here, so the launcher uses --appimage-extract-and-run"
  fi
  cat > "$apps/hqterm.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=hqterm
GenericName=Terminal
Comment=Terminal with tabs, split panes, images and HD emoji; persistent hqsh sessions
Exec=$dir/hqterm-desktop.AppImage$extra --no-sandbox
Icon=$icons/hqterm.png
Terminal=false
Categories=System;TerminalEmulator;
Keywords=terminal;shell;ssh;hqsh;
StartupWMClass=hqterm
EOF
  chmod 644 "$apps/hqterm.desktop"
  if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database "$apps" >/dev/null 2>&1 || true; fi
  for k in kbuildsycoca6 kbuildsycoca5; do
    if command -v "$k" >/dev/null 2>&1; then "$k" >/dev/null 2>&1 || true; break; fi
  done
  say "added app launcher entry $apps/hqterm.desktop"
  return 0
}

STATUS=0
if [ "$SERVER" = 0 ]; then
  install_one hqterm hqterm "${HQTERM_VERSION:-}" || die "could not download hqterm for $OS-$ARCH (no release asset yet?)"
fi
if ! install_one hqsh hqsh "${HQSH_VERSION:-}"; then
  if [ "$SERVER" = 1 ]; then
    die "could not download hqsh for $OS-$ARCH: is there an hqsh release yet? (github.com/profullstack/hqsh/releases)"
  fi
  say "warning: no hqsh release for $OS-$ARCH yet; hqterm is installed, run this again later for hqsh"
  STATUS=0
fi

DESKTOP_OK=0
if [ "$DESKTOP" = 1 ]; then
  if install_desktop; then
    DESKTOP_OK=1
  elif [ "$DESKTOP_AUTO" = 1 ] || [ "$OS" != linux ]; then
    say "warning: the desktop app was not installed; hqterm and hqsh are"
  else
    die "could not download the desktop app for $OS-$ARCH (no release asset yet?)"
  fi
fi

case ":$PATH:" in
  *":$BIN:"*) ;;
  *)
    say "note: $BIN is not on your PATH. Add it, e.g.:"
    # shellcheck disable=SC2016
    say "  echo 'export PATH=\"$BIN:\$PATH\"' >> ~/.profile && . ~/.profile"
    ;;
esac

if [ "$SERVER" = 1 ]; then
  say "done: hqsh is ready on this host"
else
  say "done. Try: hqterm doctor   then: hqterm"
  if [ "$DESKTOP_OK" = 1 ]; then say "desktop app: run  hqterm desktop  or pick hqterm in your app launcher"; fi
fi
exit "$STATUS"
