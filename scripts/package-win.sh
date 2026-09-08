#!/usr/bin/env bash
set -euo pipefail

# NekoWite Windows release builder.
# Usage: bash scripts/package-win.sh
# Produces release/nekowite_<version>_x64-setup.exe after all gates pass.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[1/4] Tests"
npx --yes pnpm --filter @nekowite/desktop test

echo "[2/4] Typecheck + lint"
npx --yes pnpm --filter @nekowite/desktop typecheck
npx --yes pnpm --filter @nekowite/desktop lint

echo "[3/4] Tauri Windows package"
# Stop any running instance so the release exe is not locked.
if command -v taskkill >/dev/null 2>&1; then
  taskkill //IM nekowite.exe //F >/dev/null 2>&1 || true
fi
npx --yes pnpm --filter @nekowite/desktop exec tauri build --bundles nsis

echo "[4/4] Copy installer to release/"
mkdir -p release
SHORT_VERSION="$(node -p "require('./apps/desktop/src-tauri/tauri.conf.json').version" 2>/dev/null || echo 0.1.0)"
SRC="apps/desktop/src-tauri/target/release/bundle/nsis/nekowite_${SHORT_VERSION}_x64-setup.exe"
DST="release/nekowite_${SHORT_VERSION}_x64-setup.exe"
cp -f "$SRC" "$DST"

echo
echo "Installer: $(pwd)/$DST"
sha256sum "$DST"
