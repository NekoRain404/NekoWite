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

echo "[1/7] Bundled engine"
# The sidecar is a build INPUT: `bundle.externalBin` names `binaries/opencode`, Tauri appends the
# target triple itself, and a missing or wrong file there fails the build minutes in — or worse,
# ships an app that has no engine. This runs the same verification P1 does, so a package is only
# built from an artifact that is the one the release manifest pins.
bash scripts/verify-opencode-linux.sh

echo "[2/7] Tests"
npx --yes pnpm --filter @nekowite/desktop test

echo "[3/7] Typecheck + lint"
npx --yes pnpm --filter @nekowite/desktop typecheck
npx --yes pnpm --filter @nekowite/desktop lint

echo "[4/7] Build optimized executable and every bundle"
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

echo "[5/7] Copy release artifacts"
mkdir -p release

# `-p`, or the mtimes below are the copy's and the closing note is a lie: plain
# `cp` stamps every artifact with the moment it was copied, which is always
# minutes after the build, so four artifacts from four different builds would
# look perfectly uniform. That is the whole signal, destroyed by a missing flag.
cp -pf "$TARGET/nekowite" "release/${BIN_NAME}"

# The engine goes beside it, and this is not a convenience — it is the layout the app searches.
# `bundled_program(exe_dir)` (`src/agent_runtime/binary_registry.rs`) looks for `opencode` and
# `opencode-<target>` in the directory the app's own executable was found in, and deliberately
# never on `PATH` (§3.2). The three bundles carry the engine *inside* themselves, so the portable
# executable is the one artifact that arrives incomplete without this line — and it did: it
# shipped as a lone 27 MB file, and the way that was found is a user running it and reading the
# modal that names this directory. `$TARGET/opencode` is the same file `copy_binaries` places at
# `usr/bin/opencode` in the deb and the rpm, under the bare name for the same reason.
[ -x "$TARGET/opencode" ] || {
  echo "FAIL: $TARGET/opencode is absent, so the portable executable would ship with no engine." >&2
  echo "      Tauri's copy_binaries writes it from bundle.externalBin; check the build output." >&2
  exit 1
}
cp -pf "$TARGET/opencode" "release/opencode"
echo
echo "Portable executable: $(pwd)/release/${BIN_NAME}"
echo "  ...and it needs $(pwd)/release/opencode beside it. Ship them together: the executable"
echo "  alone resolves no engine, and the deb, rpm and AppImage each carry their own copy."
sha256sum "release/${BIN_NAME}"
sha256sum "release/opencode"

shopt -s nullglob
for f in "$TARGET/bundle/deb/"*.deb "$TARGET/bundle/rpm/"*.rpm "$TARGET/bundle/appimage/"*.AppImage; do
  cp -pf "$f" "release/$(basename "$f")"
  echo
  echo "Bundle: $(pwd)/release/$(basename "$f")"
  sha256sum "release/$(basename "$f")"
done

echo "[6/7] Verify the engine inside each package"
# The step the whole packaging run exists to make checkable: §3.2 says the installed layout carries
# the engine beside the app's own executable, §3.3 says a program that does not answer the protocol
# is not an engine, and §11.2 says neither is proven by a build succeeding. This checks each package
# the way P1 does — a deb that shipped without its sidecar would otherwise be discovered by a user.
#
# The portable executable is checked separately, and by a different means, because its engine is a
# *sibling file* rather than package contents — no `--bundle` inspection can see it, which is
# exactly why it went missing. What makes this check equivalent to the ones below is the
# comparison: the sibling is `cmp`'d against the artifact `[1/7]` already verified, so it inherits
# every property that check establishes (architecture, the pinned sha256, the empty-environment
# handshake) instead of being trusted for having been copied.
STAGED_ENGINE="$ROOT/apps/desktop/src-tauri/binaries/opencode-x86_64-unknown-linux-gnu"
[ -x "release/opencode" ] || {
  echo "FAIL: release/opencode is absent, so the portable executable resolves no engine." >&2
  echo "      It looks beside its own binary and nowhere else; see agent_runtime/binary_registry.rs." >&2
  exit 1
}
if ! cmp -s "release/opencode" "$STAGED_ENGINE"; then
  echo "FAIL: release/opencode is not the verified artifact at $STAGED_ENGINE." >&2
  exit 1
fi
echo "Portable executable: engine present beside it and identical to the verified artifact"

for f in release/*.deb release/*.rpm release/*.AppImage; do
  bash scripts/verify-opencode-linux.sh --bundle "$f"
done

echo
echo "[7/7] Verify the notice file inside each package"
# §3.3: 第三方许可证和分发义务进入发布清单；不要仅复制程序而漏掉通知文件. The notice itself is
# `apps/desktop/src-tauri/THIRD-PARTY-NOTICES.txt`, and it reaches a package three ways — declared in
# `tauri.conf.json` as `bundle.resources` (all three formats, landing in /usr/lib/nekowite/), as
# `bundle.linux.deb.files` (/usr/share/doc/nekowite/copyright, where Debian policy expects it), as
# `bundle.linux.rpm.files` (/usr/share/licenses/nekowite/) and as `bundle.linux.appimage.files`.
#
# This checks the canonical one for each format, not all four copies. The point is not completeness of
# the copies: it is that a source tree holding a notice no bundle includes is the "built but
# unreachable" defect this repository has found repeatedly, and here it would mean shipping someone
# else's program, and a copyleft library, with no notice at all. A missing file fails the run rather
# than being mentioned in the closing notes.
NOTICE_SRC="apps/desktop/src-tauri/THIRD-PARTY-NOTICES.txt"
[ -f "$NOTICE_SRC" ] || { echo "FAILED: $NOTICE_SRC is missing; nothing below can pass." >&2; exit 1; }

notice_work="$(mktemp -d "$ROOT/apps/desktop/src-tauri/target/notice-check.XXXXXX")"
trap 'rm -rf "$notice_work"' EXIT
for f in release/*.deb release/*.rpm release/*.AppImage; do
  label="$(basename "$f")"
  dest="$notice_work/${label//[^A-Za-z0-9]/_}"
  mkdir -p "$dest"
  case "$f" in
    *.deb)   dpkg-deb -x "$f" "$dest" ;;
    *.rpm)   ( cd "$dest" && rpm2cpio "$f" | cpio -idm --quiet ) ;;
    *.AppImage)
      ( cd "$dest" && "$f" --appimage-extract >/dev/null )
      if [ -d "$dest/squashfs-root" ]; then
        shopt -s dotglob; mv "$dest/squashfs-root"/* "$dest/"; shopt -u dotglob
        rmdir "$dest/squashfs-root"
      fi ;;
    *) echo "FAILED: $f is not a package this step knows how to open." >&2; exit 1 ;;
  esac

  # The one path per format that a person looking for the licence would open.
  case "$f" in
    *.deb)      want="$dest/usr/share/doc/nekowite/copyright" ;;
    *.rpm)      want="$dest/usr/share/licenses/nekowite/THIRD-PARTY-NOTICES.txt" ;;
    *.AppImage) want="$dest/usr/share/doc/nekowite/copyright" ;;
  esac
  [ -s "$want" ] || { echo "FAILED: $label carries no notice file at $want" >&2; exit 1; }
  if ! cmp -s "$NOTICE_SRC" "$want"; then
    echo "FAILED: $label ships a notice file that is not the one in the tree ($want)." >&2
    exit 1
  fi
  # A notice that lost its licence texts in a truncating copy would still be a non-empty file.
  grep -q 'END OF THIRD-PARTY NOTICES' "$want" \
    || { echo "FAILED: $label's notice file is truncated — no end marker." >&2; exit 1; }
  echo "  $label  notice present and identical to $NOTICE_SRC"
done
rm -rf "$notice_work"
trap - EXIT

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
echo
echo "Distribution notices: each package now carries"
echo "apps/desktop/src-tauri/THIRD-PARTY-NOTICES.txt — the bundled OpenCode"
echo "engine (MIT, pinned in src/agent_runtime/update.rs), the Rust crates the"
echo "release links, and the npm packages in the frontend bundle, with each"
echo "licence's full text. Step [7/7] above is what proves it travelled."
echo
echo "One obligation the notice file records but does not discharge: the"
echo "frontend bundles citeproc (CPAL-1.0 OR AGPL-1.0, neither permissive) and"
echo "no branch has been elected. See the notice file's own note and"
echo "docs/architecture/agent-dependencies.md."
