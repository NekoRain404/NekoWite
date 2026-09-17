#!/usr/bin/env bash
# The live AI run: the editor's own completion path, against a real OpenAI-compatible gateway.
#
# `ai_test.rs`, `ai_stream_frame_test.rs` and their siblings drive every function of the AI path
# against a loopback server this repository writes itself, which is worth having and is not evidence
# about a provider: a real gateway's frame shapes, its chunking, its usage field set and the TLS
# chain it presents are exactly what a self-written fixture cannot contain. `ai_live_test.rs` closes
# that, and this script is what runs it — it exists rather than a bare `cargo test` for the reason
# the ACP runner gives, which is that the one thing the run needs is not the test's to check:
#
#   the key   `/tmp/nkw-test-key`, outside the repository, 0600. Written by whoever owns the gateway
#             account. It is read here, exported, and printed nowhere: not in `argv`
#             (`/proc/<pid>/cmdline` is world readable), not in a file, not in a log line. The test
#             reads `NWK_TEST_KEY` and never that path, so this script is the only reader.
#
# The test SKIPS without the key, and a caller that cannot tell a skip from a pass would conclude the
# integration works — which is why the check below is fatal here and deliberately not fatal there.
#
# Cost: ONE prompt, in `one_paid_turn_streams_through_the_apps_own_path`. The other test in the
# target, `the_gateway_lists_the_model_the_paid_turn_asks_for`, is a `GET /models` and spends
# nothing — it is also the test that answers the transport question for this crate (the shipped
# client, its redirect refusal, its pin and the trust anchors this crate's `reqwest` was built
# with), so it is never worth dropping. It runs first, and the paid turn is what its listing is
# checked against: a turn against a model the gateway does not offer is paid for and answered with
# an error. Measured 2026-09-17: the turn billed 17 prompt + 2 completion tokens.
#
# Usage:
#   bash scripts/verify-ai-live.sh
#
# `CARGO_TARGET_DIR` is left to the caller, like the ACP runner: several agents build this crate at
# once and a shared target directory serializes them behind one lock. Every run of this script
# builds in the tree's own `apps/desktop/src-tauri/target` unless the caller says otherwise; a
# private directory is fine, `/tmp` and `~/.cache` are not (a run of that mistake filled a disk).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEY_FILE="/tmp/nkw-test-key"

say() { printf '%s\n' "$*"; }
die() { printf '%s\n' "$*" >&2; exit 1; }

# --- what a live run needs, checked here rather than skipped there ---------------------------------
# Deliberately fatal, and the reason this script exists: a missing key inside the test is a skip.
[ -f "$KEY_FILE" ] || die "FAIL: no credential at $KEY_FILE
  The test needs it and must not invent one. This key is not in the repository by design; see the
  P0 report's §3 for what it is and who writes it."
KEY="$(tr -d '\r\n' < "$KEY_FILE")"
[ -n "$KEY" ] || die "FAIL: $KEY_FILE is empty."
export NWK_TEST_KEY="$KEY"
# Not echoed at any verbosity, and `set -x` would echo it: if this script is ever traced, that is a
# credential in a terminal's scrollback and in whatever captures it.

LOGS="$(mktemp -d)"
trap 'rm -rf "$LOGS"' EXIT

TARGET=ai_live_test
LOG="$LOGS/$TARGET.log"
say "=== $TARGET ==="
set +e
cargo test \
  --manifest-path "$ROOT/apps/desktop/src-tauri/Cargo.toml" \
  --test "$TARGET" \
  -- --nocapture 2>&1 | tee "$LOG"
STATUS="${PIPESTATUS[0]}"
set -e

# --- the result --------------------------------------------------------------------------------------
say ''
[ "$STATUS" -eq 0 ] || die "FAIL: $TARGET exited $STATUS. The output above is the finding; a red live
  test that reproduces a real defect is a result, not a broken run."

# A skip is not a pass. The key check above makes the credential skip unreachable, so anything still
# saying SKIP means an environment this script did not anticipate, and a caller must be told rather
# than reassured.
if grep -q '^SKIP:' "$LOG"; then
  die "FAIL: $TARGET skipped:
$(grep '^SKIP:' "$LOG")"
fi

grep -q 'test result: ok' "$LOG" || die "FAIL: $TARGET printed no test result line."

# One pattern per acceptance item, and every one of them has to be in the log: a run that listed the
# models and never streamed an answer (or the reverse) must not read as a pass. The usage patterns
# are two, because they say different things — `provider usage frames` is what the gateway sent,
# `app-side TokenUsage: Some(` is what the app made of it — and the pair is what makes the third
# item's measurement a measurement of BOTH ends.
required=(
  '--- model ids from the gateway ('
  '--- assistant text ('
  '--- provider usage frames ('
  '--- app-side TokenUsage: Some('
  '--- every count the app reports is one the provider sent, unchanged'
)
missing=0
for marker in "${required[@]}"; do
  # `--` matters: every marker below starts with `-`, and without it grep reads the pattern as a
  # list of options and answers "unrecognized option" — which this script would then report as a
  # missing evidence line, i.e. a green run reading as red for a reason that has nothing to do with
  # the run. Measured: the first version of this script did exactly that.
  if ! grep -qF -- "$marker" "$LOG"; then
    say "FAIL: $TARGET printed no evidence for \"$marker\"."
    missing=1
  fi
done
[ "$missing" -eq 0 ] || exit 1

say "PASS: $TARGET — a real gateway listed its models, and one paid turn streamed through the app's
  own transport, its own SSE parser and its own usage accounting."
