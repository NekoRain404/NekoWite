#!/usr/bin/env bash
# Put the PINNED OpenCode Linux artifact where Tauri's sidecar bundler expects it.
#
# The app ships its own engine: nothing here uses a system `opencode`, and the
# binary this installs is the only one the bundle will carry. The version and
# the tarball's sha512 are both pinned below, and the digest is verified before
# anything is extracted — the registry's own `dist.integrity` for
# `opencode-linux-x64@<version>`, which is what makes "we pinned it" a checkable
# claim rather than a hope.
#
#   scripts/fetch-opencode-linux.sh                 # download, verify, install
#   scripts/fetch-opencode-linux.sh --tarball FILE  # verify an already-fetched file
#
# The installed path is gitignored: 176 MB belongs in a release artifact, not in
# a commit. `scripts/verify-opencode-linux.sh` (T14) is what proves the installed
# one answers ACP; this script only proves it is the file we meant.
set -euo pipefail

VERSION="1.18.29"
# registry.npmjs.org/opencode-linux-x64/-/opencode-linux-x64-${VERSION}.tgz
INTEGRITY="X8/wS/8mzL7Ko0zYYF6RzKax39KkxXDRoimhmzXuo0gPrZX4DQjqBNpPAByBwUjFapk73ZGSVsjDGvoNapBa1Q=="
PKG="opencode-linux-x64"
TARGET_TRIPLE="x86_64-unknown-linux-gnu"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_DIR="$ROOT/apps/desktop/src-tauri/binaries"
DEST="$DEST_DIR/opencode-$TARGET_TRIPLE"

TARBALL=""
if [ "${1:-}" = "--tarball" ]; then
  TARBALL="${2:?--tarball needs a path}"
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if [ -z "$TARBALL" ]; then
  url="https://registry.npmjs.org/$PKG/-/$PKG-$VERSION.tgz"
  echo "fetching $PKG@$VERSION"
  curl -fsSL --max-time 600 "$url" -o "$work/$PKG-$VERSION.tgz"
  TARBALL="$work/$PKG-$VERSION.tgz"
fi

echo "verifying sha512 against the pinned integrity"
actual="$(openssl dgst -sha512 -binary "$TARBALL" | openssl base64 -A)"
if [ "$actual" != "$INTEGRITY" ]; then
  echo "REFUSING: digest mismatch." >&2
  echo "  expected $INTEGRITY" >&2
  echo "  actual   $actual" >&2
  exit 1
fi

tar -xzf "$TARBALL" -C "$work"
src="$work/package/bin/opencode"
[ -f "$src" ] || { echo "REFUSING: no package/bin/opencode in the tarball" >&2; exit 1; }

mkdir -p "$DEST_DIR"
install -m 0755 "$src" "$DEST"

echo "installed $DEST"
echo "  version  $("$DEST" --version 2>/dev/null || echo '--version FAILED')"
echo "  sha256   $(sha256sum "$DEST" | cut -d' ' -f1)"
echo "  license  MIT (opencode-ai@$VERSION)"
echo
echo "gitignored: $(git -C "$ROOT" check-ignore -q "$DEST" && echo yes || echo 'NO — add it before committing')"
