#!/usr/bin/env bash
# A process-survival probe, not proof that the window rendered or editing works.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
BUDGET="${BUDGET:-30}"
BUNDLE_MODE="${BUNDLE_MODE:-full}"
[[ "$BUDGET" =~ ^([1-9][0-9]*([.][0-9]+)?|0[.][0-9]*[1-9][0-9]*)$ ]] || {
  echo "BUDGET must be a positive number of seconds" >&2
  exit 2
}
if [ -z "${BIN:-}" ]; then
  VERSION="$(node -p "require('./apps/desktop/src-tauri/tauri.conf.json').version")"
  BIN="$ROOT/release/nekowite_${VERSION}_x64"
fi
BIN="$(realpath -m -- "$BIN")"
[ -x "$BIN" ] || { echo "no executable at $BIN" >&2; exit 2; }
if [ "$BUNDLE_MODE" = full ]; then
  [ -x "$(dirname "$BIN")/opencode" ] || {
    echo "no engine beside $BIN" >&2
    exit 2
  }
elif [ "$BUNDLE_MODE" != lean ]; then
  echo "BUNDLE_MODE must be full or lean" >&2
  exit 2
fi

# Linux Unix sockets allow only 107 pathname bytes. Keep the profile near the
# repository root; nested target paths broke portal sockets in real launches.
mkdir -p "$ROOT/target"
SCRATCH="$(mktemp -d "$ROOT/target/b.XXXXXX")"
LOG="$(realpath -m -- "${LOG:-$SCRATCH/boot.log}")"
case "$LOG" in
  "$ROOT"/*) ;;
  *) echo "LOG must be inside the repository" >&2; exit 2 ;;
esac
export XDG_CONFIG_HOME="$SCRATCH/config" XDG_DATA_HOME="$SCRATCH/data"
export XDG_CACHE_HOME="$SCRATCH/cache" XDG_STATE_HOME="$SCRATCH/state"
export XDG_RUNTIME_DIR="$SCRATCH/r" TMPDIR="$SCRATCH/tmp"
mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" \
  "$XDG_STATE_HOME" "$XDG_RUNTIME_DIR" "$TMPDIR"
chmod 700 "$XDG_RUNTIME_DIR"

probe_pid=""
cleanup() {
  # Only this launch's session is ours; matching executable names can kill a user's app.
  if [ -n "$probe_pid" ]; then
    kill -TERM -- "-$probe_pid" 2>/dev/null || true
    sleep 0.1
    kill -KILL -- "-$probe_pid" 2>/dev/null || true
    wait "$probe_pid" 2>/dev/null || true
    probe_pid=""
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "booting $BIN (${BUDGET}s budget); log: $LOG"
# A separate bus prevents this probe from activating an existing user instance.
# setsid gives cleanup an owned process group, including timeout and its descendants.
#
# **`-extension GLX`, for the reason the process-level test targets pass it too.** Measured on this
# workstation: plain `Xvfb :N -screen 0 <size> -nolisten tcp` segfaults while initialising GLX
# (`libEGL_nvidia` reached through `swrast_dri`), so the display never comes up, GTK cannot
# initialise, and the app exits 1 — which this script then reports as "process exited before the
# deadline", i.e. as a boot failure rather than as a display that never existed. The app renders
# through WebKitGTK over X11 and nothing here needs GLX. The first run of this probe on this machine
# failed exactly that way, with `Xvfb` "Aborted (core dumped)" in the log above the GTK panic.
setsid timeout --kill-after=2 "$BUDGET" dbus-run-session -- \
  xvfb-run -a -s "-screen 0 1280x800x24 -extension GLX" \
  env GDK_BACKEND=x11 WEBKIT_DISABLE_DMABUF_RENDERER=1 "$BIN" > "$LOG" 2>&1 &
probe_pid=$!
code=0
wait "$probe_pid" || code=$?
cleanup
head -30 "$LOG"
if [ "$code" -eq 124 ]; then
  echo "PASS: process stayed alive until the deadline; rendering is not verified"
  exit 0
fi
echo "FAIL: process exited before the deadline (exit=$code)" >&2
exit 1
