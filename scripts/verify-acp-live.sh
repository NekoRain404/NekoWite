#!/usr/bin/env bash
# The live ACP run: the pinned engine, a real model, and this repository's own runtime driving both.
#
# `agent_runtime_test.rs` proves the runtime against a shell fixture and stops the real engine at its
# handshake, because a handshake needs no credentials and costs nothing (that file says so). What
# that leaves unmeasured is everything from `session/new` down — the session, the model selection,
# the stream, the stop reason and the usage — which P0 §2/§6 measured only through hand-written
# probes talking straight to the binary. This script is what runs the tests that close that gap, and
# it exists rather than a bare `cargo test` because three of the things those runs need are not the
# tests' to check:
#
#   the artifact   `apps/desktop/src-tauri/binaries/opencode-x86_64-unknown-linux-gnu`, a gitignored
#                  pipeline product. Absent means the test would skip, and a skip is not a pass.
#   the key        `/tmp/nkw-test-key`, outside the repository, 0600. Written by whoever owns the
#                  gateway account. It is read here, exported, and printed nowhere: not in `argv`
#                  (`/proc/<pid>/cmdline` is world readable), not in a file, not in a log line.
#   the profile    `~/.config/opencode` and `~/.local/share/opencode` are the developer's own
#                  installation, and plan §10.4 forbids the test from reading or writing them. The
#                  test points HOME and the XDG roots into a scratch profile inside the repository
#                  (plan §3.2), and the comparison below is the evidence that it worked rather than a
#                  claim that it does.
#
# Cost: three prompts per run — one for `agent_live_test`'s end-to-end turn, and two for
# `agent_cancel_live_test`, which needs a turn that is still streaming when the stop is pressed and a
# second turn on the same session to show the engine really let go of the first. Roughly 9–14k tokens
# of input each (P0 §3). It is not a test to put on a loop.
#
# `agent_session_lifecycle_test.rs` is deliberately **not** here: it spends no prompt (`session/new`
# needs no credentials and none of the calls it makes reaches a provider) and so needs none of the
# three guards above. Run it with
#   cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --test agent_session_lifecycle_test
#
# Usage:
#   bash scripts/verify-acp-live.sh
#
# `CARGO_TARGET_DIR` is left to the caller: several agents build this crate at once and a shared
# target directory serializes them behind one lock. Point it at a private directory if that matters.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_TRIPLE="x86_64-unknown-linux-gnu"
ARTIFACT="$ROOT/apps/desktop/src-tauri/binaries/opencode-$TARGET_TRIPLE"
KEY_FILE="/tmp/nkw-test-key"
# The developer's real profile, as opencode itself spells it.
REAL_CONFIG="$HOME/.config/opencode"
REAL_DATA="$HOME/.local/share/opencode"

say() { printf '%s\n' "$*"; }
die() { printf '%s\n' "$*" >&2; exit 1; }

# --- what a live run needs, checked here rather than skipped there ---------------------------------
[ -f "$ARTIFACT" ] || die "FAIL: no engine at $ARTIFACT
  The artifact is gitignored; fetch it with scripts/fetch-opencode-linux.sh."
[ -x "$ARTIFACT" ] || die "FAIL: $ARTIFACT is not executable."
# Deliberately fatal, and the reason this script exists: a missing key inside the test is a skip,
# and a caller that cannot tell a skip from a pass would conclude the integration works.
[ -f "$KEY_FILE" ] || die "FAIL: no credential at $KEY_FILE
  The test needs it and must not invent one. This key is not in the repository by design; see the
  P0 report's §3 for what it is and who writes it."
KEY="$(tr -d '\r\n' < "$KEY_FILE")"
[ -n "$KEY" ] || die "FAIL: $KEY_FILE is empty."
export NWK_TEST_KEY="$KEY"
# Not echoed at any verbosity, and `set -x` would echo it: if this script is ever traced, that is a
# credential in a terminal's scrollback and in whatever captures it.

# --- the developer's profile, before ---------------------------------------------------------------
# One line per entry, with its mtime and size, plus the directory itself — a file created inside a
# directory moves that directory's mtime, so a new file cannot hide behind an unchanged listing.
snapshot() {
  local dir="$1"
  if [ -e "$dir" ]; then
    find "$dir" -maxdepth 1 -printf '%p %T@ %s\n' 2>/dev/null | sort
  else
    printf 'absent\n'
  fi
}

BEFORE="$(mktemp -d)"
trap 'rm -rf "$BEFORE"' EXIT
snapshot "$REAL_CONFIG" > "$BEFORE/config"
snapshot "$REAL_DATA" > "$BEFORE/data"
say "profile before: $REAL_CONFIG and $REAL_DATA recorded"

# --- the runs ---------------------------------------------------------------------------------------
# One target at a time, and every one of them runs: a first failure is not a reason to skip the
# second, because what a caller needs to know is the state of all of them. Each target's own
# evidence marker is what separates "a model answered" from "the tests all skipped and cargo still
# printed ok" — the same distinction the artifact and key checks above exist to keep unreachable.
TARGETS=(agent_live_test agent_cancel_live_test)
MARKERS=('reply in ' 'the turn after the stop answered')
STATUSES=()

# One log per target, and a combined one: the per-target file is what the checks below read, so one
# target's SKIP or its `test result` line can never be attributed to another's output.
: > "$BEFORE/log"
for index in "${!TARGETS[@]}"; do
  target="${TARGETS[$index]}"
  per="$BEFORE/$target.log"
  say ''
  say "=== $target ==="
  set +e
  cargo test \
    --manifest-path "$ROOT/apps/desktop/src-tauri/Cargo.toml" \
    --test "$target" \
    -- --nocapture 2>&1 | tee "$per"
  STATUSES+=("${PIPESTATUS[0]}")
  set -e
  cat "$per" >> "$BEFORE/log"
done

# --- the developer's profile, after ------------------------------------------------------------------
say ''
for pair in "config:$REAL_CONFIG" "data:$REAL_DATA"; do
  name="${pair%%:*}"
  dir="${pair#*:}"
  if diff -q "$BEFORE/$name" <(snapshot "$dir") > /dev/null; then
    say "profile after: $dir unchanged"
  else
    say "profile after: $dir CHANGED"
    diff "$BEFORE/$name" <(snapshot "$dir") | sed 's/^/    /' || true
  fi
done

# A change under the configuration root is unambiguous: this host's own files live there, and no
# other process of the developer's writes them, so it is a P0 and it fails the run. The data root is
# reported but not fatal, because a running `opencode` of the developer's own writes to its session
# database there and that would be reported as our fault.
if ! diff -q "$BEFORE/config" <(snapshot "$REAL_CONFIG") > /dev/null; then
  say ''
  say 'FAIL: P0 — the live run reached the developer'"'"'s configuration. Plan §10.4 forbids it.'
  exit 1
fi

# --- the result --------------------------------------------------------------------------------------
say ''
FAILURES=0
for index in "${!TARGETS[@]}"; do
  target="${TARGETS[$index]}"
  status="${STATUSES[$index]}"
  if [ "$status" -ne 0 ]; then
    say "FAIL: $target exited $status. The output above is the finding; a red live test that
  reproduces a real defect is a result, not a broken run."
    FAILURES=1
    continue
  fi
  # A skip is not a pass. The two artifact/key checks above make those skips unreachable, so anything
  # still saying SKIP means an environment this script did not anticipate (a bundle the runtime cannot
  # inject, an inherited NODE_EXTRA_CA_CERTS, a missing CA store) and a caller must be told rather
  # than reassured.
  per="$BEFORE/$target.log"
  if grep -q '^SKIP:' "$per"; then
    say "FAIL: $target skipped:
$(grep '^SKIP:' "$per")"
    FAILURES=1
    continue
  fi
  grep -q 'test result: ok' "$per" || {
    say "FAIL: $target printed no test result line."
    FAILURES=1
    continue
  }
  if ! grep -qF "${MARKERS[$index]}" "$per"; then
    say "FAIL: $target printed no evidence that a model answered (expected \"${MARKERS[$index]}\")."
    FAILURES=1
    continue
  fi
  say "PASS: $target — a real prompt against the pinned engine, on a real model."
done

[ "$FAILURES" -eq 0 ] || exit 1
say ''
say 'PASS: the runtime completed real prompts against the pinned engine, and stopped one mid-stream.'
