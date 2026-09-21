#!/usr/bin/env bash
# The verification gate for this repository on Linux: every check AGENTS.md requires, plus the three
# instruments and the Rust suite with its process-level cases *required* rather than skipped.
#
# **Why this file exists rather than a list of commands in a document.** The gate used to be run by
# hand, and the sequence had two properties nobody could see: a step's failure did not stop the next
# one, and the script's own exit code was the last command's — so a red `cargo test` followed by a
# successful `ls` reported success. It exited 0 on a run whose suite had failed, which is the same
# defect this repository keeps finding in its tools (a reading that does not mean what it says), and
# it is worse here than anywhere else: everything else is verified *by* this.
#
# So: every step runs even after one fails (a summary of all of them is worth more than the first
# failure), each step's status is recorded, and the exit code is 1 if ANY step failed. `--only` runs a
# subset, which is also how the failure propagation above is tested.
#
# Usage:
#   bash scripts/gate.sh                  # everything except e2e
#   bash scripts/gate.sh --with-e2e       # …and the Playwright suite (needs a browser, ~4 minutes)
#   bash scripts/gate.sh --only lint,fmt  # a subset; the summary still says which steps ran
#
# Steps, in the order they run:
#   verify      `pnpm verify` — typecheck, lint (with its warning ceiling), tests, perf,
#               the renderer build and the export-CSS check, in CI's order
#   fmt         `cargo fmt --all --check`
#   clippy      `cargo clippy --all-targets --locked` (reported, not ratcheted; see the audit ledger)
#   instruments `check-reachability.py`, `check-dead-exports.py`, `check-channels.py`
#   build       `tauri build --no-bundle` — the artefact the process-level cases below drive
#   rust        the whole suite with `NEKOWITE_REQUIRE_PROCESS_TESTS=1`, so a case that cannot run
#               fails instead of skipping (finding T1)
#   e2e         the Playwright suite, only with `--with-e2e`
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 90

# pnpm needs writable XDG directories on a machine whose `$HOME` is not one; the paths are the
# git-ignored scratch this repository already uses for that (`scripts/package-linux.sh` sets its own).
export XDG_DATA_HOME="${XDG_DATA_HOME:-$ROOT/.tmp-review-pnpm/data}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$ROOT/.tmp-review-pnpm/cache}"
export XDG_STATE_HOME="${XDG_STATE_HOME:-$ROOT/.tmp-review-pnpm/state}"
mkdir -p "$XDG_DATA_HOME" "$XDG_STATE_HOME"

LOG_DIR="${GATE_LOG_DIR:-$ROOT/apps/desktop/src-tauri/target/gate}"
mkdir -p "$LOG_DIR"

WITH_E2E=0
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --with-e2e) WITH_E2E=1 ;;
    --only) shift; ONLY="${1:-}" ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

# The engine the process-level cases watch for has to be staged beside the built app, and removed
# again afterwards: a `target/release/opencode` left behind makes a later `cargo test` pass for a
# reason nobody chose (the handover's §9.1), and its absence makes those cases skip — which is what
# `NEKOWITE_REQUIRE_PROCESS_TESTS=1` turns into a failure rather than a quiet pass.
ENGINE_STAGED=0
stage_engine() {
  cp "$ROOT/apps/desktop/src-tauri/binaries/opencode-x86_64-unknown-linux-gnu" \
     "$ROOT/apps/desktop/src-tauri/target/release/opencode"
  ENGINE_STAGED=1
}
unstage_engine() {
  if [ "$ENGINE_STAGED" -eq 1 ]; then
    rm -f "$ROOT/apps/desktop/src-tauri/target/release/opencode"
  fi
}
trap unstage_engine EXIT

FAILED=()
RAN=()
SUMMARY=()

wanted() {
  [ -z "$ONLY" ] && return 0
  case ",$ONLY," in *",$1,"*) return 0 ;; *) return 1 ;; esac
}

step() {
  local name="$1" describe="$2"
  shift 2
  wanted "$name" || return 0
  RAN+=("$name")
  echo "### $(date -Is) $name — $describe"
  local log="$LOG_DIR/$name.log" status=0
  "$@" > "$log" 2>&1 || status=$?
  if [ "$status" -eq 0 ]; then
    echo "    PASS $name"
  else
    echo "    FAIL $name (exit $status) — $log"
    FAILED+=("$name")
  fi
  SUMMARY+=("$name|$status|$log")
}

step verify "pnpm verify" \
  pnpm verify
step fmt "cargo fmt --all --check" \
  cargo fmt --all --check --manifest-path apps/desktop/src-tauri/Cargo.toml
step clippy "cargo clippy --all-targets --locked" \
  cargo clippy --all-targets --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
step instruments "the three source instruments" \
  bash -c 'python3 scripts/check-reachability.py && python3 scripts/check-dead-exports.py && python3 scripts/check-channels.py'
step build "tauri build --no-bundle" \
  pnpm --filter @nekowite/desktop exec tauri build --no-bundle

# The suite is the one step with a precondition of its own, so it is not just a command: the engine
# is staged first (see above) and the log is read for the counts rather than the exit code alone.
rust_step() {
  stage_engine
  ls -l --time-style=+%H:%M \
    "$ROOT/apps/desktop/src-tauri/target/release/nekowite" \
    "$ROOT/apps/desktop/src-tauri/target/release/opencode"
  NEKOWITE_REQUIRE_PROCESS_TESTS=1 cargo test --locked --no-fail-fast \
    --manifest-path "$ROOT/apps/desktop/src-tauri/Cargo.toml"
}
step rust "the whole suite, process tests required" \
  rust_step

if [ "$WITH_E2E" -eq 1 ]; then
  step e2e "the Playwright suite" \
    pnpm --filter @nekowite/desktop e2e
fi

echo
echo "=== the gate, $(date -Is) ==="
for row in "${SUMMARY[@]}"; do
  IFS='|' read -r name status log <<< "$row"
  target_count=""
  case "$name" in
    rust)
      # The counts a green suite is judged by: a run that collected no targets is not a pass.
      target_count=" — $(grep -c '^test result:' "$log" 2>/dev/null || echo 0) targets, \
$(grep -E '^test result:' "$log" 2>/dev/null | awk -F'[ ;]' '{p+=$4; f+=$6} END {printf "%d passed, %d failed", p, f}')"
      ;;
    verify)
      # The WORKSPACE suite's totals, summed over the package runs — not the last `Tests N passed`
      # line in the log, which is the perf project's ten. The first version of this summary reported
      # perf's count, which is a reading that looks like the suite's and is not: exactly the defect
      # this script exists to stop making.
      target_count=" — $(awk '/test: +Tests +[0-9]+ passed/ {
        match($0, /Tests +[0-9]+/); n = substr($0, RSTART, RLENGTH); gsub(/[^0-9]/, "", n);
        sum += n; runs += 1
      } END { if (runs) printf "%d tests across %d package runs", sum, runs }' "$log" 2>/dev/null)"
      ;;
    clippy)
      target_count=" — $(grep -c '^warning' "$log" 2>/dev/null || echo 0) warning lines"
      ;;
    e2e)
      # Playwright's own last line. A run that collected nothing says "no tests found" and never
      # prints this, which is why the count is worth reading rather than the exit code alone.
      target_count=" — $(grep -oE '[0-9]+ passed' "$log" 2>/dev/null | tail -1)"
      ;;
  esac
  if [ "$status" -eq 0 ]; then
    printf '  PASS  %-12s (exit 0)%s\n' "$name" "$target_count"
  else
    printf '  FAIL  %-12s (exit %s)%s\n' "$name" "$status" "$target_count"
  fi
done
echo "  logs: $LOG_DIR"
if [ "${#RAN[@]}" -eq 0 ]; then
  echo "FAIL: no step matched --only '$ONLY'" >&2
  exit 2
fi
if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "FAIL: ${#FAILED[@]} of ${#RAN[@]} step(s) failed: ${FAILED[*]}" >&2
  exit 1
fi
echo "PASS: all ${#RAN[@]} step(s) green."
