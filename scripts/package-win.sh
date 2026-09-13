#!/usr/bin/env bash
set -euo pipefail

# NekoWite Windows portable release builder.
# Usage:
#   bash scripts/package-win.sh            # portable nekowite.exe (default)
#   PORTABLE=0 bash scripts/package-win.sh # optional NSIS installer
#
# Outputs:
#   release/nekowite_<version>_x64.exe   (portable, double-click to run)
#   release/nekowite_<version>_x64-setup.exe (only when PORTABLE=0)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORTABLE="${PORTABLE:-1}"
SHORT_VERSION="$(node -p "require('./apps/desktop/src-tauri/tauri.conf.json').version" 2>/dev/null || echo 0.1.0)"
EXE_NAME="nekowite_${SHORT_VERSION}_x64"

echo "[1/4] Tests"
npx --yes pnpm --filter @nekowite/desktop test

echo "[2/4] Typecheck + lint"
npx --yes pnpm --filter @nekowite/desktop typecheck
npx --yes pnpm --filter @nekowite/desktop lint

echo "[3/4] Build optimized executable"
# Stop any running instance of the previous portable executable so the release
# exe is not locked. The portable file is versioned in its name, so match it
# explicitly (Tauri's own binary is nekowite.exe).
if command -v taskkill >/dev/null 2>&1; then
  taskkill //IM "${EXE_NAME}.exe" //F >/dev/null 2>&1 || true
  taskkill //IM nekowite.exe //F >/dev/null 2>&1 || true
fi
if [ "$PORTABLE" = "1" ]; then
  # `tauri build` already runs `beforeBuildCommand` (`pnpm build`); do not
  # pre-build Vite here or the frontend is compiled twice.
  npx --yes pnpm --filter @nekowite/desktop exec tauri build --no-bundle
else
  npx --yes pnpm --filter @nekowite/desktop exec tauri build --bundles nsis
fi

echo "[4/4] Copy release artifacts"
mkdir -p release
BUILT="apps/desktop/src-tauri/target/release/nekowite.exe"
DST="release/${EXE_NAME}.exe"
cp -f "$BUILT" "$DST"

echo
echo "Portable executable: $(pwd)/$DST"
sha256sum "$DST"
if [ "$PORTABLE" != "1" ]; then
  SRC_SETUP="apps/desktop/src-tauri/target/release/bundle/nsis/${EXE_NAME}-setup.exe"
  DST_SETUP="release/${EXE_NAME}-setup.exe"
  cp -f "$SRC_SETUP" "$DST_SETUP"
  echo "Installer: $(pwd)/$DST_SETUP"
  sha256sum "$DST_SETUP"
fi
