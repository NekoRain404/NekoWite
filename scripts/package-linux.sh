#!/usr/bin/env bash
set -euo pipefail

# NekoWite Linux release builder — the counterpart of package-win.sh.
# Usage:
#   bash scripts/package-linux.sh
#
# Outputs, all in release/:
#   nekowite_<version>_x64                    portable executable
#   nekowite_<version>_amd64.deb
#   nekowite-<version>-1.x86_64.rpm
#   nekowite_<version>_amd64.AppImage
#
# The AppImage bundles GTK and WebKitGTK, so it is ~10x the size of the deb and
# runs on any distribution. The deb and the rpm declare those as dependencies
# instead and let the system provide them, so they only install on their own
# family — on Arch, neither does, and the AppImage or the bare executable is
# what runs.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SHORT_VERSION="$(node -p "require('./apps/desktop/src-tauri/tauri.conf.json').version" 2>/dev/null || echo 0.1.0)"
BIN_NAME="nekowite_${SHORT_VERSION}_x64"
TARGET="apps/desktop/src-tauri/target/release"

echo "[1/4] Tests"
npx --yes pnpm --filter @nekowite/desktop test

echo "[2/4] Typecheck + lint"
npx --yes pnpm --filter @nekowite/desktop typecheck
npx --yes pnpm --filter @nekowite/desktop lint

echo "[3/4] Build optimized executable and every bundle"
# `tauri build` already runs `beforeBuildCommand` (`pnpm build`); do not
# pre-build Vite here or the frontend is compiled twice.
#
# One invocation for all four targets, deliberately. Building them in separate
# runs produces artifacts from different moments of the same source tree, and
# nothing on an artifact says which moment it came from: `tauri build` rewrites
# `dist/` and re-embeds it into the Rust binary, so a deb cut before a later
# rebuild carries the frontend of that earlier moment with no way to tell.
# That happened here, and the only reason it was caught is that the timestamps
# were compared by hand.
BUILD_STARTED="$(mktemp)"
APPDIR="$TARGET/bundle/appimage/nekowite.AppDir"
set +e
npx --yes pnpm --filter @nekowite/desktop exec tauri build
BUILD_STATUS=$?
set -e

if [ "$BUILD_STATUS" -ne 0 ]; then
  # The appimage bundle's final step — linuxdeploy's `--output appimage`, which
  # shells out to the appimage plugin and appimagetool — fails here and only
  # here. Four attempts: it hung for two hours once, failed twice with `failed
  # to run linuxdeploy`, and succeeded when run on its own against the very same
  # AppDir. Nothing about it is the source tree: it fails *after* linuxdeploy has
  # finished deploying, so the AppDir it leaves behind is complete, and the
  # recovery is to do the one step tauri could not.
  #
  # This keeps the one-invocation property above, but only because we check the
  # AppDir is this build's own — a stale AppDir from an earlier build would
  # otherwise be silently packaged as this build's AppImage, which is the exact
  # failure the comment above is about. What we do not get is one timestamp for
  # all four: the AppImage is packaged minutes later, and `cp -p` below will say
  # so rather than hiding it.
  if [ -f "$APPDIR/AppRun" ] && [ -x "$APPDIR/usr/bin/nekowite" ] \
     && [ "$APPDIR/usr/bin/nekowite" -nt "$BUILD_STARTED" ]; then
    echo
    echo "tauri build failed at the appimage step, after linuxdeploy finished."
    echo "The AppDir it left is from this build; packaging the AppImage from it."
    AI_TMP="$(mktemp -d)"
    if ( cd "$AI_TMP" && ARCH=x86_64 PATH="$HOME/.cache/tauri:$PATH" \
         "$HOME/.cache/tauri/linuxdeploy-x86_64.AppImage" \
           --appdir "$ROOT/$APPDIR" --output appimage ); then
      # Put it where the copy step below already looks, under the same name, so
      # the two paths converge instead of each having their own idea of the file.
      mv "$AI_TMP"/*.AppImage \
         "$TARGET/bundle/appimage/nekowite_${SHORT_VERSION}_amd64.AppImage"
    else
      echo "Could not finish the AppImage either. Nothing copied to release/." >&2
      rm -rf "$AI_TMP" "$BUILD_STARTED"
      exit 1
    fi
    rm -rf "$AI_TMP"
  else
    echo "tauri build failed before leaving an AppDir from this build." >&2
    rm -f "$BUILD_STARTED"
    exit 1
  fi
fi
rm -f "$BUILD_STARTED"

echo "[4/4] Copy release artifacts"
mkdir -p release

# `-p`, or the mtimes below are the copy's and the closing note is a lie: plain
# `cp` stamps every artifact with the moment it was copied, which is always
# minutes after the build, so four artifacts from four different builds would
# look perfectly uniform. That is the whole signal, destroyed by a missing flag.
cp -pf "$TARGET/nekowite" "release/${BIN_NAME}"
echo
echo "Portable executable: $(pwd)/release/${BIN_NAME}"
sha256sum "release/${BIN_NAME}"

shopt -s nullglob
for f in "$TARGET/bundle/deb/"*.deb "$TARGET/bundle/rpm/"*.rpm "$TARGET/bundle/appimage/"*.AppImage; do
  cp -pf "$f" "release/$(basename "$f")"
  echo
  echo "Bundle: $(pwd)/release/$(basename "$f")"
  sha256sum "release/$(basename "$f")"
done

echo
echo "All four artifacts are from the single build above. Their mtimes in"
echo "release/ are the build's, not the copy's: deb, rpm and the portable"
echo "executable should be seconds apart, and the AppImage may be minutes"
echo "later if the recovery above ran. If one is much older than the rest it"
echo "is stale; git HEAD should be older than all four."
echo
echo "For whoever tests this build: the app takes a single-instance lock, so"
echo "launching it while an older copy is still open only raises that older"
echo "window. Quit the running copy first, or you will be looking at the"
echo "previous build and conclude the fixes did nothing."
