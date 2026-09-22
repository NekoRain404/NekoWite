#!/usr/bin/env bash
set -euo pipefail

# Linux bundles must be validated together before replacing any published artifact.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
SHORT_VERSION="$(node -p "require('./apps/desktop/src-tauri/tauri.conf.json').version")"
BIN_NAME="nekowite_${SHORT_VERSION}_x64"
TARGET="$ROOT/apps/desktop/src-tauri/target/release"
WORK_ROOT="$ROOT/apps/desktop/src-tauri/target/package-linux"
mkdir -p "$WORK_ROOT"
exec 9>"$WORK_ROOT/build.lock"
flock -n 9 || { echo "FAIL: another Linux packaging run is active" >&2; exit 1; }
WORK="$(mktemp -d "$WORK_ROOT/run.XXXXXX")"
# All three XDG directories, not just the cache. This script is run on machines where `$HOME` may not be
# writable, and `pnpm` opens a database under `XDG_DATA_HOME` — with only the cache redirected it dies at
# step [2/7] with `[ERROR] unable to open database file`, which reads as a broken repository rather than
# as a caller who forgot to export two variables. (`scripts/gate.sh` sets all three for the same reason;
# `npm_config_cache` stays because npm reads that name, not the XDG one.)
export TMPDIR="$WORK/tmp" XDG_CACHE_HOME="$WORK_ROOT/cache"
export XDG_DATA_HOME="$WORK_ROOT/data" XDG_STATE_HOME="$WORK_ROOT/state"
export npm_config_cache="$XDG_CACHE_HOME/npm"
# `linuxdeploy` — which is what produces the AppImage — ships *as* an AppImage, and an AppImage normally needs
# FUSE to mount itself. Containers and this machine have no `/dev/fuse`, where the bundler then dies with
# `failed to run linuxdeploy` / `fuse: device not found`, after the deb and rpm have already been built. The
# AppImage runtime's own answer is to extract itself and run from the extraction, which is what this asks for;
# it is set here rather than left to the caller because the bundle step must not depend on the host having FUSE.
export APPIMAGE_EXTRACT_AND_RUN=1
# And `linuxdeploy` strips every library it deploys, with a `strip` from its own AppImage that predates
# `.relr.dyn` (binutils 2.36+): on this distribution it dies with
#   `ERROR: Strip call failed: …/usr/bin/strip: … unknown type [0x13] section '.relr.dyn'`
# after the AppDir has been populated. `NO_STRIP=1` is linuxdeploy's own escape hatch; measured cost on this
# tree: the AppImage came out 168,692,216 bytes against 167,737,848 with stripping — 0.9 MB, and the AppImage
# is verified by running it later in this script either way.
export NO_STRIP=1
mkdir -p "$TMPDIR" "$XDG_CACHE_HOME/tauri" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$WORK/tools" "$WORK/previous"
echo "Packaging evidence and scratch: $WORK"

# A command that only exits zero is not rpm. Pin the checked executable for Tauri too.
RPM_TOOL=""
for candidate in "$(command -v rpm || true)" /usr/bin/rpm /bin/rpm; do
  [ -x "$candidate" ] || continue
  if "$candidate" --version 2>/dev/null | grep -q '^RPM version [0-9]'; then
    RPM_TOOL="$(realpath -- "$candidate")"
    break
  fi
done
[ -n "$RPM_TOOL" ] || { echo "FAIL: no working RPM tool" >&2; exit 1; }
ln -s "$RPM_TOOL" "$WORK/tools/rpm"
export PATH="$WORK/tools:$PATH"

echo "[1/7] Bundled engine"
bash scripts/verify-opencode-linux.sh
echo "[2/7] Tests"
npx --yes pnpm --filter @nekowite/desktop test
echo "[3/7] Typecheck + lint"
npx --yes pnpm --filter @nekowite/desktop typecheck
npx --yes pnpm --filter @nekowite/desktop lint

echo "[4/7] Build executable and all Linux bundles"
# The pinned engine, verified by `[1/7]` above. Defined here rather than at the staging step below, because the
# AppImage recovery needs it: tauri's relinking of this 176 MB sidecar produces a binary the loader cannot run
# (see the recovery), so the recovery puts this artefact back before it builds the AppImage itself.
STAGED_ENGINE="$ROOT/apps/desktop/src-tauri/binaries/opencode-x86_64-unknown-linux-gnu"
[ -s "$STAGED_ENGINE" ] || {
  echo "FAIL: no verified engine to stage from: $STAGED_ENGINE" >&2; exit 1;
}
APPIMAGE_RUNTIME="$XDG_CACHE_HOME/tauri/runtime-x86_64"
APPIMAGE_RUNTIME_URL="https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-x86_64"
if [ ! -s "$APPIMAGE_RUNTIME" ]; then
  curl -fSL --retry 3 --connect-timeout 20 -o "$WORK/runtime.part" "$APPIMAGE_RUNTIME_URL"
  mv "$WORK/runtime.part" "$APPIMAGE_RUNTIME"
fi
[ -s "$APPIMAGE_RUNTIME" ] || { echo "FAIL: empty AppImage runtime" >&2; exit 1; }
export LDAI_RUNTIME_FILE="$APPIMAGE_RUNTIME"

BUNDLES=(
  "$TARGET/bundle/deb/nekowite_${SHORT_VERSION}_amd64.deb"
  "$TARGET/bundle/rpm/nekowite-${SHORT_VERSION}-1.x86_64.rpm"
  "$TARGET/bundle/appimage/nekowite_${SHORT_VERSION}_amd64.AppImage"
)
APPDIR="$TARGET/bundle/appimage/nekowite.AppDir"
# Absence before the invocation proves production by this invocation, even when Cargo
# restores an unchanged executable with its original mtime. Keep all prior output recoverable.
for prior in "$TARGET/nekowite" "$TARGET/opencode" "${BUNDLES[@]}" "$APPDIR"; do
  if [ -e "$prior" ]; then
    mv "$prior" "$WORK/previous/$(basename "$prior")"
  fi
done
BUILD_STATUS=0
npx --yes pnpm --filter @nekowite/desktop exec tauri build || BUILD_STATUS=$?
if [ "$BUILD_STATUS" -ne 0 ]; then
  if [ -f "$APPDIR/AppRun" ] && [ -x "$APPDIR/usr/bin/nekowite" ] \
     && [ -s "${BUNDLES[0]}" ] && [ -s "${BUNDLES[1]}" ]; then
    # **The engine is put back, unpatched, before the recovery runs.**
    #
    # Tauri relinks every bundled executable to carry `$ORIGIN/../lib`, and for this 176 MB sidecar its patcher
    # adds a LOAD segment the loader cannot digest: measured on 2026-09-22, the copy it produced in the AppDir
    # core-dumped on `--version` and made `ldd` exit 1 without a word — which is what killed linuxdeploy with
    # `Failed to run ldd`, after the deb and the rpm had already been built. The same file patched by
    # `patchelf --set-rpath` runs (`1.18.29`) and `ldd`s clean, so the recovery stages the pristine pinned
    # engine — the artefact `scripts/verify-opencode-linux.sh` has just verified — and relinks it itself.
    # `cp` is not enough on its own: tauri's segment lives in the file it wrote, so the copy is replaced first.
    cp -f "$STAGED_ENGINE" "$APPDIR/usr/bin/opencode"
    patchelf --set-rpath '$ORIGIN/../lib' "$APPDIR/usr/bin/opencode"
    "$APPDIR/usr/bin/opencode" --version >/dev/null 2>&1 || {
      echo "FAIL: the engine in the AppDir does not run after relinking" >&2
      exit 1
    }
    AI_TMP="$(mktemp -d "$TMPDIR/appimage.XXXXXX")"
    ( cd "$AI_TMP" && ARCH=x86_64 PATH="$XDG_CACHE_HOME/tauri:$PATH" \
      "$XDG_CACHE_HOME/tauri/linuxdeploy-x86_64.AppImage" --appdir "$APPDIR" --output appimage )
    shopt -s nullglob
    recovered=("$AI_TMP"/*.AppImage)
    [ "${#recovered[@]}" -eq 1 ] || { echo "FAIL: ambiguous AppImage recovery" >&2; exit 1; }
    mv "${recovered[0]}" "${BUNDLES[2]}"
  else
    echo "FAIL: build did not produce the required Linux outputs" >&2
    exit 1
  fi
fi
for artifact in "$TARGET/nekowite" "${BUNDLES[@]}"; do
  [ -s "$artifact" ] || { echo "FAIL: missing current-build artifact: $artifact" >&2; exit 1; }
done
for executable in "$TARGET/nekowite" "${BUNDLES[2]}"; do
  [ -x "$executable" ] || { echo "FAIL: not executable: $executable" >&2; exit 1; }
done

echo "[5/7] Stage exact current-build artifacts"
mkdir -p "$ROOT/release"
STAGE="$(mktemp -d "$ROOT/release/.candidate.XXXXXX")"
cp -p "$TARGET/nekowite" "$STAGE/$BIN_NAME"
# **The engine comes from its own verified input, not from `$TARGET/opencode`.**
#
# That path is where `tauri-build`'s `copy_binaries` used to leave a copy of
# `bundle.externalBin`, and both this script and the one before it required it — but on
# 2026-09-21 it stopped appearing while the three bundles were still built and each still
# carried `usr/bin/opencode`, checked below and by `verify-opencode-linux.sh`. A package step
# that fails on a file the bundler no longer writes, while the bundles it did write are
# correct, is a step measuring the wrong thing.
#
# What the portable artefact needs beside it is the engine the bundles carry, and that is
# `binaries/opencode-<triple>` — the pinned artefact `verify-opencode-linux.sh` already
# vetted before this point and the one `[6/7]` compares the staged copy against. When Tauri
# *does* leave a copy at `$TARGET/opencode`, the comparison below still runs against it, so a
# bundler that ever stages something else is caught rather than silently preferred.
# `STAGED_ENGINE` is the path defined at the top of `[4/7]`, so the AppImage recovery and this staging step
# cannot disagree about which artefact they mean.
cp -p "$TARGET/opencode" "$STAGE/opencode" 2>/dev/null || cp -p "$STAGED_ENGINE" "$STAGE/opencode"
CANDIDATES=()
for artifact in "${BUNDLES[@]}"; do
  candidate="$STAGE/$(basename "$artifact")"
  cp -p "$artifact" "$candidate"
  CANDIDATES+=("$candidate")
done

echo "[6/7] Verify staged engines"
cmp -s "$STAGE/opencode" "$STAGED_ENGINE" || {
  echo "FAIL: portable engine differs from verified input" >&2; exit 1;
}
for package in "${CANDIDATES[@]}"; do
  bash scripts/verify-opencode-linux.sh --bundle "$package"
done

echo "[7/7] Verify staged notices"
NOTICE_SRC="$ROOT/apps/desktop/src-tauri/THIRD-PARTY-NOTICES.txt"
[ -s "$NOTICE_SRC" ] || { echo "FAIL: missing notices" >&2; exit 1; }
for package in "${CANDIDATES[@]}"; do
  dest="$(mktemp -d "$TMPDIR/notice.XXXXXX")"
  case "$package" in
    *.deb) dpkg-deb -x "$package" "$dest"
      want="$dest/usr/share/doc/nekowite/copyright" ;;
    *.rpm) ( cd "$dest" && rpm2cpio "$package" | cpio -idm --quiet )
      want="$dest/usr/share/licenses/nekowite/THIRD-PARTY-NOTICES.txt" ;;
    *.AppImage) ( cd "$dest" && "$package" --appimage-extract >/dev/null )
      if [ -d "$dest/squashfs-root" ]; then dest="$dest/squashfs-root"; fi
      want="$dest/usr/share/doc/nekowite/copyright" ;;
  esac
  cmp -s "$NOTICE_SRC" "$want" || { echo "FAIL: missing or mismatched notice in $package" >&2; exit 1; }
  grep -q 'END OF THIRD-PARTY NOTICES' "$want" || { echo "FAIL: truncated notice" >&2; exit 1; }
done

# Publication touches exact names only. A trap restores the previous generation if any
# rename fails; the unique backup also preserves artifacts used by a running process.
mkdir -p "$ROOT/release/superseded"
BACKUP="$(mktemp -d "$ROOT/release/superseded/build.XXXXXX")"
published=()
backed_up=()
rollback() {
  local status=$?
  local recovery_failed=0
  trap - EXIT
  if [ "$status" -ne 0 ]; then
    for name in "${published[@]}"; do
      mv "$ROOT/release/$name" "$STAGE/$name" || recovery_failed=1
    done
    for name in "${backed_up[@]}"; do
      mv "$BACKUP/$name" "$ROOT/release/$name" || recovery_failed=1
    done
    if [ "$recovery_failed" -eq 0 ]; then
      echo "FAIL: publication interrupted; previous artifacts restored from $BACKUP" >&2
    else
      echo "FAIL: rollback incomplete; inspect $BACKUP and $STAGE before retrying" >&2
    fi
  fi
  exit "$status"
}
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
for artifact in "$STAGE/$BIN_NAME" "$STAGE/opencode" "${CANDIDATES[@]}"; do
  name="$(basename "$artifact")"
  if [ -e "$ROOT/release/$name" ]; then
    mv "$ROOT/release/$name" "$BACKUP/$name"
    backed_up+=("$name")
  fi
  mv "$artifact" "$ROOT/release/$name"
  published+=("$name")
done
trap - EXIT INT TERM
rmdir "$STAGE"
for name in "${published[@]}"; do sha256sum "$ROOT/release/$name"; done
echo "Published verified current-build artifacts; prior files retained at $BACKUP"
echo "Unrelated release files are preserved. Temporary evidence remains at $WORK."
echo "Quit an older app before manual testing; single-instance activation can show the old build."
echo "This does not verify distribution compatibility or interactive workflows."
echo "The citeproc licence branch remains a distribution obligation recorded in THIRD-PARTY-NOTICES.txt."
