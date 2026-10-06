#!/bin/sh
# hqterm installer: https://hqterm.sh
#
#   curl -fsSL https://hqterm.sh/install | sh               # hqterm + hqsh
#   curl -fsSL https://hqterm.sh/install | sh -s -- --server  # hqsh only (remote hosts)
#
# Installs prebuilt binaries from the latest GitHub releases of
# profullstack/hqterm and profullstack/hqsh into ~/.local/bin (or $HQTERM_BIN).
# No sudo, safe to run again. Pin versions with HQTERM_VERSION / HQSH_VERSION
# (e.g. v0.1.0).
set -eu

BIN="${HQTERM_BIN:-$HOME/.local/bin}"
SERVER=0
for arg in "$@"; do
  case "$arg" in
    --server) SERVER=1 ;;
    --bin=*) BIN="${arg#--bin=}" ;;
    -h|--help)
      echo "usage: install.sh [--server] [--bin=DIR]"
      echo "  --server   install only hqsh (for hosts you connect to)"
      echo "  --bin=DIR  install into DIR (default ~/.local/bin, or \$HQTERM_BIN)"
      exit 0 ;;
    *) echo "hqterm install: unknown option $arg" >&2; exit 2 ;;
  esac
done

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

# install_one REPO NAME VERSION: download NAME-OS-ARCH, verify, install as BIN/NAME.
# Returns 1 (without exiting) when the release or asset does not exist.
install_one() {
  repo="$1"; name="$2"; version="$3"
  asset="$name-$OS-$ARCH"
  if [ -n "$version" ]; then
    base="https://github.com/profullstack/$repo/releases/download/$version"
  else
    base="https://github.com/profullstack/$repo/releases/latest/download"
  fi
  say "downloading $asset from github.com/profullstack/$repo${version:+ ($version)}"
  if ! fetch "$base/$asset" "$TMP/$asset"; then
    return 1
  fi
  if fetch "$base/SHA256SUMS" "$TMP/SHA256SUMS.$name" 2>/dev/null; then
    want="$(grep " \*\{0,1\}$asset\$" "$TMP/SHA256SUMS.$name" | cut -d' ' -f1 | head -n1)"
    got="$(sha256 "$TMP/$asset")"
    if [ -z "$want" ]; then
      say "warning: $asset is not listed in SHA256SUMS; not verified"
    elif [ -z "$got" ]; then
      say "warning: no sha256sum/shasum here; $asset not verified"
    elif [ "$want" != "$got" ]; then
      die "checksum mismatch for $asset (expected $want, got $got)"
    else
      say "verified $asset (sha256 $got)"
    fi
  else
    say "warning: no SHA256SUMS in the $repo release; $asset not verified"
  fi
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
fi
exit "$STATUS"
