#!/usr/bin/env bash
# Does the artefact we just packaged actually start?
#
# Every other gate in this repository measures the *source tree*: vitest drives modules, Playwright
# drives the dev server, cargo drives test binaries. Not one of them starts the thing the maintainer
# will double-click. That gap has already mattered once here — the app opened to a blank window and
# the cause was in `lib.rs`'s single-instance handler, reachable only by launching the real binary.
#
# Run it headless under Xvfb so it does not put a window on the maintainer's desktop, and give it a
# budget: a Tauri app has no "exit when done", so being *still alive* at the deadline is the pass
# (`timeout` reports 124). Anything else is a failure worth reading the log for.
#
# It runs against the real profile, because that is what the maintainer's copy does. The ledger's
# own loss report is printed by the app on startup and is not a failure of this probe.
set -u

cd "$(dirname "$0")/.." || exit 1
BUDGET="${BUDGET:-75}"
BIN=release/nekowite_1.0.0_x64
LOG="${LOG:-/tmp/nkw-boot.txt}"

[ -x "$BIN" ] || { echo "no portable artefact at $BIN — run pnpm package:linux"; exit 2; }
[ -x release/opencode ] || {
  echo "no engine beside it — the portable executable resolves its engine from its own directory,"
  echo "so the executable alone is not a package. Run pnpm package:linux."
  exit 2
}

echo "booting $BIN with the engine beside it (${BUDGET}s budget)"
# `setsid` puts the whole thing in its own process group, and the group is what gets killed.
# Without it `timeout` reaps `xvfb-run` and leaves the app itself running — and the app it leaves
# is the *next* run's problem, because the shell's single-instance handler sees an instance already
# up, raises it, and exits 0 in three seconds. The probe reported that as "did not survive the
# budget", which is the instrument inventing the failure it then measures.
start=$(date +%s)
setsid timeout "$BUDGET" xvfb-run -a -s "-screen 0 1280x800x24" \
  env GDK_BACKEND=x11 WEBKIT_DISABLE_DMABUF_RENDERER=1 "./$BIN" \
  > "$LOG" 2>&1
code=$?
end=$(date +%s)

# Belt as well as braces: a `setsid`ed descendant can outlive its leader, and one that does would
# be this script's fault the next time it runs.
pkill -f "$(basename "$BIN")" 2>/dev/null
sleep 1

echo "exit=$code after $((end - start))s"
if [ "$code" -eq 124 ]; then
  echo "PASS: still running at the deadline — the shell started and stayed up"
else
  echo "FAIL: it did not survive the budget (124 means it would have)"
fi

echo "--- first 30 lines of what it printed ---"
head -30 "$LOG"
exit 0
