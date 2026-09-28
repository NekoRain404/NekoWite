#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d "$REPO_ROOT/target/appimage-acp-test.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

VERSION="0.99.0-beta.1"
APPDIR="$TEST_ROOT/apps/desktop/src-tauri/target/release/bundle/appimage/nekowite.AppDir"
CACHE="$TEST_ROOT/apps/desktop/src-tauri/target/package-linux/cache/tauri"
mkdir -p "$APPDIR/usr/bin" "$CACHE"
printf '{"version":"%s"}\n' "$VERSION" > "$TEST_ROOT/apps/desktop/src-tauri/tauri.conf.json"
printf 'app-runner\n' > "$APPDIR/AppRun"
printf 'nekowite\n' > "$APPDIR/usr/bin/nekowite"
printf 'opencode\n' > "$APPDIR/usr/bin/opencode"
chmod +x "$APPDIR/AppRun" "$APPDIR/usr/bin/nekowite" "$APPDIR/usr/bin/opencode"
printf 'runtime\n' > "$CACHE/runtime-x86_64"
cat > "$CACHE/linuxdeploy-x86_64.AppImage" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
appdir="$2"
[ ! -e "$appdir/usr/bin/opencode" ] || exit 31
[ -x "$appdir/usr/bin/nekowite" ] || exit 32
cat > "$PWD/nekowite-test.AppImage" <<'IMAGE'
#!/usr/bin/env bash
if [ "${1:-}" = --appimage-extract ]; then
  mkdir -p squashfs-root/usr/bin
  printf 'nekowite\n' > squashfs-root/usr/bin/nekowite
  chmod +x squashfs-root/usr/bin/nekowite
fi
IMAGE
chmod +x "$PWD/nekowite-test.AppImage"
STUB
chmod +x "$CACHE/linuxdeploy-x86_64.AppImage"

if ROOT="$TEST_ROOT" LINUXDEPLOY="$CACHE/linuxdeploy-x86_64.AppImage" \
   APPIMAGE_RUNTIME="$CACHE/runtime-x86_64" bash "$REPO_ROOT/scripts/package-appimage-acp.sh"; then
  test -x "$TEST_ROOT/release/nekowite_${VERSION}_amd64-acp.AppImage"
else
  echo "ACP AppImage should build from an integrated AppDir" >&2
  exit 1
fi

rm -rf "$APPDIR"
if ROOT="$TEST_ROOT" LINUXDEPLOY="$CACHE/linuxdeploy-x86_64.AppImage" \
   APPIMAGE_RUNTIME="$CACHE/runtime-x86_64" bash "$REPO_ROOT/scripts/package-appimage-acp.sh"; then
  echo "ACP AppImage packaging must fail when the integrated AppDir is missing" >&2
  exit 1
fi
echo "PASS: ACP AppImage packaging scenarios"
