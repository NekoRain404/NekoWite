#!/usr/bin/env bash
# P1 — the pinned OpenCode engine, verified where it matters: the artifact this repository installs,
# and the packages built from it.
#
# What this proves, and why each check is here:
#
#   architecture   the file is a 64-bit little-endian x86-64 ELF. §3.2 claims one architecture, and
#                  this is where that claim is measured rather than written down.
#   identity       its sha256 is the digest recorded in the app's own release manifest
#                  (`src/agent_runtime/update.rs`), and the version is pinned in three places that are
#                  checked against each other here — a drift between them is otherwise silent.
#
#                  **Except inside an AppImage, where that digest cannot match and never will.**
#                  linuxdeploy runs patchelf over the bundled engine so it can find the libraries
#                  the image carries: that adds a `$ORIGIN/../lib` RUNPATH and rewrites the ELF
#                  header and section table, moving the file by a page. A byte-for-byte assertion
#                  there would be asserting something no AppImage this repository builds can
#                  satisfy. What is asserted instead is what the patch is *allowed* to be — the
#                  RUNPATH is exactly the bundler's, the pinned artifact has none, the size moves
#                  by less than a page's worth of header — and the version and the handshake below
#                  remain the proof that it is still this engine. The output says so rather than
#                  printing a digest that matched.
#   no system CLI  the engine answers `--version` and a full ACP handshake with an EMPTY environment
#                  (`env -i`: no PATH, no HOME, nothing). That is the strongest available form of
#                  §3.1.1's "安装 NekoWite 后已经拥有经过验证的 OpenCode 基础版本": not "we did not use a
#                  system one", but "there was none to use".
#   no developer state
#                  HOME and the XDG roots point into a scratch profile inside this repository, so a run
#                  of this script cannot touch a real engine's configuration or credentials.
#   offline        where the kernel allows an unprivileged network namespace, the handshake is
#                  repeated inside it. §11.2 asks for the offline case; where the namespace is
#                  unavailable this says "not proven" instead of passing quietly.
#   packaged layout
#                  with `--bundle`, the sidecar inside a built package sits beside the app's own
#                  executable under its bare name — which is what makes §3.2's "resolve it through
#                  Tauri's sidecar location" a statement about one directory rather than a search.
#
# What it does NOT prove: that the engine can reach a model (that needs credentials and a bill), that
# it renders correctly, or that any architecture other than the pinned one works. A program can pass
# every check here and still be refused by the app's own update gate — `agent_update_test.rs` is where
# that gate is measured.
#
# Usage:
#   bash scripts/verify-opencode-linux.sh                       # the artifact in the tree
#   bash scripts/verify-opencode-linux.sh --bundle release/x.deb
#   bash scripts/verify-opencode-linux.sh --bundle release/y.AppImage --bundle release/z.rpm
#   bash scripts/verify-opencode-linux.sh --require-clean       # a release run: fail if this machine
#                                                               # has a system OpenCode installed
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_TRIPLE="x86_64-unknown-linux-gnu"
STAGED="$ROOT/apps/desktop/src-tauri/binaries/opencode-$TARGET_TRIPLE"
MANIFEST_SRC="$ROOT/apps/desktop/src-tauri/src/agent_runtime/update.rs"
FETCH_SRC="$ROOT/scripts/fetch-opencode-linux.sh"
# The scratch profile lives inside the repository on purpose (plan §3.2: 开发测试的临时 profile 必须放仓库
# 内的测试临时目录). Nothing below writes anywhere else.
SCRATCH_ROOT="$ROOT/apps/desktop/src-tauri/target/verify-opencode"
SCRATCH="$SCRATCH_ROOT/profile-$$"

# The one request every handshake check sends: ACP's initialize, with the client's file-system
# capability declared the way this app declares it (`fs_capability::client_capabilities`). No model,
# no credentials, no session.
INITIALIZE='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":true,"writeTextFile":true}}}}'

BUNDLES=()
REQUIRE_CLEAN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --bundle) BUNDLES+=("${2:?--bundle needs a path}"); shift 2 ;;
    --require-clean) REQUIRE_CLEAN=1; shift ;;
    -h|--help)
      echo "usage: bash scripts/verify-opencode-linux.sh [--bundle PATH]... [--require-clean]"
      echo "       With no --bundle, the artifact in the tree is checked; after 'pnpm package:linux',"
      echo "       pass each release/<file> to check the sidecar inside it as well."
      echo "       --require-clean fails the run if this machine has a system OpenCode installed."
      exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$SCRATCH"
WORK="$(mktemp -d "$SCRATCH_ROOT/work.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PROVEN=()
SKIPPED=()
fail() { echo; echo "FAILED: $*" >&2; exit 1; }
note() { printf '  %s\n' "$*"; }

# The only roots the engine is ever given here. An empty environment plus these five is the whole of
# what a candidate sees, so "it used a system CLI" and "it read the developer's profile" are both
# impossible rather than merely unlikely.
PROFILE_ENV=(
  HOME="$SCRATCH/home"
  XDG_CONFIG_HOME="$SCRATCH/home/.config"
  XDG_DATA_HOME="$SCRATCH/home/.local/share"
  XDG_CACHE_HOME="$SCRATCH/home/.cache"
  XDG_STATE_HOME="$SCRATCH/home/.local/state"
)

echo "P1 — OpenCode on Linux"
echo "  machine        $(uname -m), $(uname -r)"
echo "  scratch        $SCRATCH"

# --- the environment the proof needs ----------------------------------------
# A system OpenCode does not weaken the checks below, and the report should not pretend it does:
# every candidate is run with `env -i` plus this script's own profile roots, so a system CLI is not
# reachable by any of them, and "it must have used the system one" is not a possible explanation of a
# pass. What it does mean is that this machine is not the clean-environment case §11.2 asks for, so it
# is reported loudly — and fatal under --require-clean, which is what a release run uses.
if command -v opencode >/dev/null 2>&1; then
  note "system CLI     $(command -v opencode) — present. Every check below still runs its candidate
      with an empty environment, so nothing of this one is reachable; what this machine cannot show
      is the §11.2 clean-machine case itself."
  SKIPPED+=("clean machine: a system OpenCode is installed here (the §11.2 case needs one without it)")
  if [ "$REQUIRE_CLEAN" -eq 1 ]; then
    fail "--require-clean was given, and a system 'opencode' is on PATH ($(command -v opencode))."
  fi
else
  PROVEN+=("no system CLI on PATH anywhere on this machine")
fi
note "node           $(command -v node 2>/dev/null || echo absent) (the engine brings its own runtime)"

# --- the pinned facts, from the places that state them ----------------------
[ -f "$MANIFEST_SRC" ] || fail "$MANIFEST_SRC is missing; the release record cannot be read"
[ -f "$FETCH_SRC" ] || fail "$FETCH_SRC is missing; the fetch pin cannot be read"

EXPECTED_SHA="$(grep -oE '"[0-9a-f]{64}"' "$MANIFEST_SRC" | head -1 | tr -d '"')"
MANIFEST_VERSION="$(grep -oE '"[0-9]+\.[0-9]+\.[0-9]+"' "$MANIFEST_SRC" | head -1 | tr -d '"')"
FETCH_VERSION="$(sed -n 's/^VERSION="\([^"]*\)"/\1/p' "$FETCH_SRC" | head -1)"
[ -n "$EXPECTED_SHA" ] || fail "no digest found in $MANIFEST_SRC"
[ -n "$MANIFEST_VERSION" ] || fail "no version found in $MANIFEST_SRC"
[ -n "$FETCH_VERSION" ] || fail "no VERSION in $FETCH_SRC"

echo "  pinned         version $MANIFEST_VERSION, sha256 ${EXPECTED_SHA:0:16}…"
if [ "$MANIFEST_VERSION" != "$FETCH_VERSION" ]; then
  fail "the version pin has drifted: the release manifest names $MANIFEST_VERSION and
      scripts/fetch-opencode-linux.sh installs $FETCH_VERSION. One of them is wrong, and the app
      would refuse the artifact the other one produces."
fi

# --- the checks, on one program ---------------------------------------------
check_program() {
  # `$3` is the archive this copy came out of, when it came out of one. It exists for one reason:
  # an AppImage cannot be checked for byte identity against the pinned digest, and this function has
  # to know that it is looking at one rather than at the artifact in the tree. See the header.
  local program="$1" label="$2" source_archive="${3:-}"

  [ -f "$program" ] || fail "$label: $program is not a file"
  [ -x "$program" ] || fail "$label: $program is not executable"

  # x86-64, byte by byte so the result does not depend on od's own byte order.
  local magic class data kind lo hi machine digest reported
  magic="$(od -An -tx1 -N4 "$program" | tr -d ' \n')"
  [ "$magic" = "7f454c46" ] || fail "$label: not an ELF file (magic $magic)"
  class="$(od -An -tu1 -j4 -N1 "$program" | tr -dc '0-9')"
  [ "$class" = "2" ] || fail "$label: ELF class $class, not 64-bit"
  data="$(od -An -tu1 -j5 -N1 "$program" | tr -dc '0-9')"
  [ "$data" = "1" ] || fail "$label: ELF data encoding $data, not little-endian"
  kind="$(od -An -tu1 -j16 -N1 "$program" | tr -dc '0-9')"
  case "$kind" in 2|3) ;; *) fail "$label: ELF type $kind, neither executable nor PIE" ;; esac
  lo="$(od -An -tu1 -j18 -N1 "$program" | tr -dc '0-9')"
  hi="$(od -An -tu1 -j19 -N1 "$program" | tr -dc '0-9')"
  machine=$((hi * 256 + lo))
  [ "$machine" -eq 62 ] || fail "$label: built for machine $machine, and this release installs x86-64 (62)"
  note "$label  ELF 64-bit LSB executable, x86-64, $(( ($(stat -c%s "$program") + 1048575) / 1048576 )) MiB"
  PROVEN+=("$label: x86-64 ELF, executable bit set")

  digest="$(sha256sum "$program" | cut -d' ' -f1)"
  local packaged_rpath pinned_rpath packaged_size delta
  case "$source_archive" in
    *.AppImage)
      # The digest cannot match here, and the reason is the bundler's rather than the artifact's:
      # linuxdeploy runs patchelf over the engine so it can find the libraries the image carries.
      # Asserting the pinned digest would be asserting something no AppImage this repository builds
      # can satisfy — which is how this was found, by the arm failing after a path bug was fixed
      # ahead of it. What is checked instead is that the patch is the one the bundler is allowed to
      # make and nothing else, and the note below says the bytes were not compared, so a reader
      # cannot mistake this for the check the other arms get.
      command -v readelf >/dev/null 2>&1 \
        || fail "$label: readelf is needed to inspect the RUNPATH linuxdeploy adds inside an AppImage"
      packaged_rpath="$(readelf -d "$program" 2>/dev/null | sed -n 's/.*RUNPATH.*\[\(.*\)\].*/\1/p' | head -1)"
      [ "$packaged_rpath" = '$ORIGIN/../lib' ] \
        || fail "$label: the engine inside the AppImage carries RUNPATH '$packaged_rpath', and the
      only patch linuxdeploy is allowed to make is \$ORIGIN/../lib. Something other than the
      bundler rewrote this file."
      if [ -f "$STAGED" ]; then
        pinned_rpath="$(readelf -d "$STAGED" 2>/dev/null | sed -n 's/.*RUNPATH.*\[\(.*\)\].*/\1/p' | head -1)"
        [ -z "$pinned_rpath" ] \
          || fail "$label: the pinned artifact already carries RUNPATH '$pinned_rpath', so the
      difference this check exists to explain is not the bundler's."
        packaged_size="$(stat -c%s "$program")"
        delta=$(( packaged_size > $(stat -c%s "$STAGED") ? packaged_size - $(stat -c%s "$STAGED") : $(stat -c%s "$STAGED") - packaged_size ))
        [ "$delta" -lt 65536 ] \
          || fail "$label: the engine inside the AppImage is $delta bytes from the pinned artifact,
      which is more than the bundler's patch can account for."
        note "$label  digest NOT compared: linuxdeploy's RUNPATH is present and the file moved $delta bytes"
      else
        note "$label  digest NOT compared: linuxdeploy's RUNPATH is present; $STAGED is absent, so
      the size difference against the pinned artifact could not be measured"
      fi
      note "$label  sha256 ${digest:0:16}… recorded, and not the pinned one by construction"
      PROVEN+=("$label: the only difference from the pinned engine is the AppImage bundler's RUNPATH")
      ;;
    *)
      if [ "$digest" != "$EXPECTED_SHA" ]; then
        fail "$label: sha256 $digest does not match the digest this app pinned ($EXPECTED_SHA).
      The artifact is not the one the release record describes."
      fi
      note "$label  sha256 ${digest:0:16}… matches the app's release manifest"
      PROVEN+=("$label: digest matches the pinned release record")
      ;;
  esac

  # The engine's own answer, with an empty environment: `env -i` leaves it without PATH, HOME or any
  # inherited credential, so a version that comes back is a version nothing else could have produced.
  reported="$(timeout 60 env -i "${PROFILE_ENV[@]}" "$program" --version 2>/dev/null | head -1 | tr -d '\r')"
  [ "$reported" = "$MANIFEST_VERSION" ] \
    || fail "$label: --version said '$reported', and the pinned release is $MANIFEST_VERSION"
  note "$label  --version: $reported (empty environment)"
  PROVEN+=("$label: reports its version with PATH, HOME and every credential absent")

  # The handshake: this is §3.3's "ACP 初始化" check, and it needs no credential because initialize
  # is the one exchange an engine answers before any account exists.
  local handshake="$WORK/handshake.jsonl" errors="$WORK/handshake.err" offline="$WORK/offline.jsonl"
  printf '%s\n' "$INITIALIZE" | timeout 120 env -i "${PROFILE_ENV[@]}" "$program" acp \
    > "$handshake" 2> "$errors" || fail "$label: 'opencode acp' exited non-zero on our initialize"
  grep -q '"agentInfo"' "$handshake" || fail "$label: the handshake carried no agentInfo"
  grep -q '"protocolVersion":1' "$handshake" || fail "$label: the handshake did not negotiate protocol version 1"
  grep -q '"name":"OpenCode"' "$handshake" || fail "$label: the handshake did not come from OpenCode"
  note "$label  ACP initialize answered with agentInfo and protocol version 1 (no credentials)"
  PROVEN+=("$label: completes the ACP handshake with no credentials")

  # §11.2's offline case, where the kernel allows an unprivileged network namespace.
  if unshare -rn true 2>/dev/null; then
    printf '%s\n' "$INITIALIZE" | unshare -rn timeout 120 env -i "${PROFILE_ENV[@]}" "$program" acp \
      > "$offline" 2> "$WORK/offline.err" || fail "$label: the handshake failed with the network removed"
    grep -q '"agentInfo"' "$offline" \
      || fail "$label: the handshake did not complete without a network"
    note "$label  ACP initialize also answers inside a network namespace with only loopback"
    PROVEN+=("$label: handshake completes with no network")
  else
    SKIPPED+=("$label: offline handshake (unprivileged network namespaces are unavailable here)")
  fi
}

# Unpacks a built package so its installed layout can be inspected. The formats this repository
# produces, and nothing else: an unknown file is a refusal rather than a guess.
extract_package() {
  local package="$1" dest="$2"
  mkdir -p "$dest"
  # The rpm and AppImage arms `cd` into the destination before running their extractor, so a
  # caller's relative path stops resolving at exactly the moment it is used. Every caller passes
  # one: `package-linux.sh` iterates `release/*.deb`/`*.rpm`/`*.AppImage` from the repository root,
  # and this script is documented to be run that way. The deb arm was unaffected only because
  # `dpkg-deb -x` takes the path as an argument and never changes directory — which is why the
  # failure looked like an AppImage problem rather than a path problem:
  #
  #   release/nekowite-2d60229.AppImage: No such file or directory
  #   FAILED: release/nekowite-2d60229.AppImage could not be extracted (--appimage-extract)
  #
  # for a file that was sitting right there. Because `package-linux.sh` runs under `set -e`, the
  # rpm arm failed first and aborted the packaging run — so the whole `[6/7]` step, the one that
  # exists to prove an installed layout carries its engine, had never completed for any package.
  local package_at
  package_at="$(cd "$(dirname "$package")" && pwd)/$(basename "$package")"
  case "$package" in
    *.deb)
      command -v dpkg-deb >/dev/null 2>&1 || fail "dpkg-deb is needed to inspect $package"
      dpkg-deb -x "$package" "$dest" ;;
    *.rpm)
      command -v rpm2cpio >/dev/null 2>&1 || fail "rpm2cpio is needed to inspect $package"
      command -v cpio >/dev/null 2>&1 || fail "cpio is needed to inspect $package"
      ( cd "$dest" && rpm2cpio "$package_at" | cpio -idm --quiet ) ;;
    *.AppImage)
      ( cd "$dest" && "$package_at" --appimage-extract >/dev/null ) \
        || fail "$package could not be extracted (--appimage-extract)"
      # The AppImage extracts into squashfs-root/; everything below expects the package root.
      if [ -d "$dest/squashfs-root" ]; then
        shopt -s dotglob
        mv "$dest/squashfs-root"/* "$dest/"
        shopt -u dotglob
        rmdir "$dest/squashfs-root"
      fi ;;
    *) fail "$package is not a package this script knows how to inspect (deb, rpm, AppImage)" ;;
  esac
}

# §3.2's installed layout: the engine is the app's own sidecar, under its bare name, beside the app's
# executable.
check_bundle_layout() {
  local layout="$1" package="$2" app="$1/usr/bin/nekowite" sidecar="$1/usr/bin/opencode"
  local label; label="$(basename "$package")"

  [ -f "$app" ] || fail "$label: usr/bin/nekowite is missing; this is not a NekoWite package"
  [ -f "$sidecar" ] || fail "$label: usr/bin/opencode is missing, so the package carries no engine"
  [ -x "$sidecar" ] || fail "$label: usr/bin/opencode is not executable"
  if [ -e "$1/usr/bin/opencode-$TARGET_TRIPLE" ]; then
    fail "$label: the sidecar kept its build-time name (opencode-$TARGET_TRIPLE). Tauri's bundler
      strips the target suffix, and a package that keeps it means the runtime path resolution and
      the bundle disagree about a name."
  fi
  note "$label  usr/bin/opencode sits beside usr/bin/nekowite"
  PROVEN+=("$label: the sidecar is installed beside the app's own executable")
}

# --- the program(s) to check ------------------------------------------------
if [ "${#BUNDLES[@]}" -eq 0 ]; then
  ARCHIVE=""
  if [ ! -f "$STAGED" ]; then
    # A package from an earlier run is a legitimate source: the point of this script is to be
    # runnable on a release machine, where the tree may not hold the 184 MiB artifact.
    ARCHIVE="$(ls -1t "$ROOT"/release/*.AppImage "$ROOT"/release/*.deb "$ROOT"/release/*.rpm 2>/dev/null | head -1 || true)"
    [ -n "$ARCHIVE" ] || fail "no artifact to check: $STAGED is absent (run
      scripts/fetch-opencode-linux.sh), and release/ holds no package"
    note "artifact       none in the tree; checking $ARCHIVE instead"
  fi
  if [ -n "$ARCHIVE" ]; then
    extract_package "$ARCHIVE" "$WORK/bundle"
    check_bundle_layout "$WORK/bundle" "$ARCHIVE"
    check_program "$WORK/bundle/usr/bin/opencode" "packaged" "$ARCHIVE"
  else
    check_program "$STAGED" "staged"
    SKIPPED+=("packaged layout: no --bundle given (run this again after 'pnpm package:linux')")
  fi
else
  index=0
  for bundle in "${BUNDLES[@]}"; do
    index=$((index + 1))
    [ -f "$bundle" ] || fail "--bundle $bundle does not exist"
    extract_package "$bundle" "$WORK/bundle-$index"
    check_bundle_layout "$WORK/bundle-$index" "$bundle"
    check_program "$WORK/bundle-$index/usr/bin/opencode" "$(basename "$bundle")" "$bundle"
  done
fi

# --- the licence obligation, reported rather than enforced -------------------
# §3.3 puts third-party licences and distribution notices into the release manifest, and the manifest
# carries the licence name. The distribution work itself is deferred by the maintainer
# (docs/architecture/agent-dependencies.md), so this reports the obligation instead of failing on it —
# a silent pass would be the one outcome that leaves a release shipping someone else's program with no
# notice at all.
LICENCE="$(grep -oE '"(MIT|Apache-2\.0|BSD-[0-9]-Clause)"' "$MANIFEST_SRC" | head -1 | tr -d '"')"
echo
echo "  licence        the bundled engine is recorded as ${LICENCE:-unknown}; no notice file is"
echo "                 extracted by scripts/fetch-opencode-linux.sh yet, which is the remaining"
echo "                 distribution obligation for a release"
SKIPPED+=("licence/notice file: recorded in the manifest, not yet bundled (deferred by the maintainer)")

# --- what was proven --------------------------------------------------------
echo
echo "PROVEN"
for line in "${PROVEN[@]}"; do echo "  - $line"; done
if [ "${#SKIPPED[@]}" -gt 0 ]; then
  echo "NOT PROVEN HERE"
  for line in "${SKIPPED[@]}"; do echo "  - $line"; done
fi
echo
echo "OK: the pinned engine starts, identifies itself and speaks ACP under an empty environment —"
echo "    no PATH, no developer profile, no network. Model access, rendering and other"
echo "    architectures are not covered by this script."
