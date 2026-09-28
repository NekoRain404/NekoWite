#!/usr/bin/env bash
set -euo pipefail

ROOT="${ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT"
VERSION="$(node -p "require('./apps/desktop/src-tauri/tauri.conf.json').version")"
TARGET="$ROOT/apps/desktop/src-tauri/target/release/bundle/appimage"
SOURCE_APPDIR="$TARGET/nekowite.AppDir"
PACKAGE_ROOT="$ROOT/apps/desktop/src-tauri/target/package-linux"
LINUXDEPLOY="${LINUXDEPLOY:-$PACKAGE_ROOT/cache/tauri/linuxdeploy-x86_64.AppImage}"
APPIMAGE_RUNTIME="${APPIMAGE_RUNTIME:-$PACKAGE_ROOT/cache/tauri/runtime-x86_64}"
OUTPUT="$ROOT/release/nekowite_${VERSION}_amd64-acp.AppImage"

[ -x "$SOURCE_APPDIR/AppRun" ] || { echo "FAIL: missing AppDir: $SOURCE_APPDIR" >&2; exit 1; }
[ -x "$SOURCE_APPDIR/usr/bin/nekowite" ] || { echo "FAIL: missing AppImage executable" >&2; exit 1; }
[ -x "$SOURCE_APPDIR/usr/bin/opencode" ] || { echo "FAIL: expected integrated AppDir with OpenCode" >&2; exit 1; }
[ -x "$LINUXDEPLOY" ] || { echo "FAIL: linuxdeploy not found: $LINUXDEPLOY" >&2; exit 1; }
[ -s "$APPIMAGE_RUNTIME" ] || { echo "FAIL: AppImage runtime not found: $APPIMAGE_RUNTIME" >&2; exit 1; }

WORK="$(mktemp -d "$PACKAGE_ROOT/appimage-acp.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
APPDIR="$WORK/nekowite.AppDir"
cp -a "$SOURCE_APPDIR" "$APPDIR"
rm "$APPDIR/usr/bin/opencode"
[ -z "$(find "$APPDIR" -type f -name opencode -print -quit)" ] || {
  echo "FAIL: ACP AppDir still contains an OpenCode executable" >&2; exit 1;
}

mkdir -p "$ROOT/release"
export APPIMAGE_EXTRACT_AND_RUN=1 NO_STRIP=1 LDAI_RUNTIME_FILE="$APPIMAGE_RUNTIME"
shopt -s nullglob
( cd "$WORK" && ARCH=x86_64 "$LINUXDEPLOY" --appdir "$APPDIR" --output appimage )
CANDIDATES=("$WORK"/*.AppImage)
[ "${#CANDIDATES[@]}" -eq 1 ] || { echo "FAIL: expected one ACP AppImage, got ${#CANDIDATES[@]}" >&2; exit 1; }

EXTRACT="$WORK/extracted"
mkdir -p "$EXTRACT"
( cd "$EXTRACT" && "${CANDIDATES[0]}" --appimage-extract >/dev/null )
EXTRACTED_APPDIR="$EXTRACT/squashfs-root"
[ -x "$EXTRACTED_APPDIR/usr/bin/nekowite" ] || { echo "FAIL: ACP AppImage has no application binary" >&2; exit 1; }
[ -z "$(find "$EXTRACTED_APPDIR" -type f -name opencode -print -quit)" ] || {
  echo "FAIL: generated ACP AppImage still contains OpenCode" >&2; exit 1;
}

STAGED="$WORK/$(basename "$OUTPUT")"
cp -p "${CANDIDATES[0]}" "$STAGED"
mv -f "$STAGED" "$OUTPUT"
sha256sum "$OUTPUT"
echo "Published ACP AppImage: $OUTPUT"
