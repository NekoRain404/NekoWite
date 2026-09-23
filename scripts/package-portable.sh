#!/usr/bin/env bash
set -euo pipefail

# Publish a portable Linux edition from a release build. The ACP edition lives
# in its own directory so it cannot accidentally resolve the full edition's
# adjacent OpenCode sidecar.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
VERSION="$(node -p "require('./apps/desktop/src-tauri/tauri.conf.json').version")"
MODE="${BUNDLE_MODE:-full}"
BIN="${BIN:-$ROOT/apps/desktop/src-tauri/target/release/nekowite}"
ENGINE="${ENGINE:-$ROOT/apps/desktop/src-tauri/target/release/opencode}"
OUT="$ROOT/release"

[ -x "$BIN" ] || { echo "FAIL: executable not found: $BIN" >&2; exit 1; }
mkdir -p "$OUT"

case "$MODE" in
  full)
    [ -x "$ENGINE" ] || { echo "FAIL: engine not found: $ENGINE" >&2; exit 1; }
    cp -p "$BIN" "$OUT/nekowite_${VERSION}_x64"
    cp -p "$ENGINE" "$OUT/opencode"
    echo "Published full edition: $OUT/nekowite_${VERSION}_x64"
    ;;
  lean)
    DEST="$OUT/nekowite-acp_${VERSION}_x64"
    rm -rf "$DEST"
    mkdir -p "$DEST"
    cp -p "$BIN" "$DEST/nekowite"
    [ ! -e "$DEST/opencode" ] || { echo "FAIL: ACP edition carried opencode" >&2; exit 1; }
    echo "Published ACP edition: $DEST/nekowite"
    ;;
  *)
    echo "FAIL: BUNDLE_MODE must be full or lean, got: $MODE" >&2
    exit 2
    ;;
esac
